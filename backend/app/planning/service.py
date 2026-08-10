"""
Shipment Planning Service.

Business logic for the planning grid: creating/renaming/removing sheets,
rows, and admin-defined columns; reading/writing cell values and CRM-style
status colors; and recording every structural/value change to both the
dedicated planning change log (for inline grid history) and the shared
audit log (for cross-module consistency).

Position management (re-sequencing rows/columns on insert, delete, and
move) lives here rather than in the repository, since it requires
coordinating two repositories (shifting positions, then writing the moved
row/column) inside one logical operation.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from typing import Any

from app.audit.constants import AuditAction
from app.audit.service import AuditService
from app.core.exceptions import BadRequestException, ConflictException, ForbiddenException, NotFoundException
from app.planning import source_registry
from app.planning.formula import FormulaError, evaluate_formula, validate_formula_syntax
from app.planning.models import (
    PlanningCell,
    PlanningCellStatusColor,
    PlanningChangeAction,
    PlanningColumn,
    PlanningColumnDataType,
    PlanningColumnSourceType,
    PlanningRow,
    PlanningSheet,
    PlanningStatusTag,
)
from app.planning.repository import (
    PlanningCellRepository,
    PlanningChangeLogRepository,
    PlanningColumnRepository,
    PlanningColumnRoleLockRepository,
    PlanningRowRepository,
    PlanningSheetRepository,
    PlanningStatusTagRepository,
)

MODULE_NAME = "planning"


class PlanningService:
    """Owns all business rules for the Shipment Planning grid."""

    def __init__(
        self,
        sheet_repository: PlanningSheetRepository,
        row_repository: PlanningRowRepository,
        column_repository: PlanningColumnRepository,
        cell_repository: PlanningCellRepository,
        status_tag_repository: PlanningStatusTagRepository,
        change_log_repository: PlanningChangeLogRepository,
        audit_service: AuditService,
        column_role_lock_repository: PlanningColumnRoleLockRepository,
        user_role_repository: Any = None,
    ) -> None:
        self.sheet_repository = sheet_repository
        self.row_repository = row_repository
        self.column_repository = column_repository
        self.cell_repository = cell_repository
        self.status_tag_repository = status_tag_repository
        self.change_log_repository = change_log_repository
        self.audit_service = audit_service
        self.column_role_lock_repository = column_role_lock_repository
        # Typed as Any / kept optional rather than importing
        # app.rbac.repository.UserRoleRepository directly: RBAC and Planning
        # are otherwise independent modules, and this is the one place
        # Planning needs to ask "what roles does this user have" for the
        # per-column role-lock feature.
        self.user_role_repository = user_role_repository

    # --- internal: dual-write to change log + shared audit log -----------------

    async def _record_change(
        self,
        *,
        action: PlanningChangeAction,
        sheet_id: uuid.UUID,
        user_id: uuid.UUID,
        username: str,
        row_id: uuid.UUID | None = None,
        column_id: uuid.UUID | None = None,
        cell_id: uuid.UUID | None = None,
        old_value: str | None = None,
        new_value: str | None = None,
        description: str | None = None,
    ) -> None:
        """Write one entry to the dedicated planning change log, and mirror it to the shared audit log."""
        await self.change_log_repository.create(
            sheet_id=sheet_id,
            row_id=row_id,
            column_id=column_id,
            cell_id=cell_id,
            action=action,
            changed_by=user_id,
            changed_by_username_snapshot=username,
            old_value=old_value,
            new_value=new_value,
            description=description,
        )
        audit_action = (
            AuditAction.DELETE
            if action.value.endswith("_DELETED")
            else AuditAction.CREATE
            if action.value.endswith(("_ADDED", "_CREATED"))
            else AuditAction.UPDATE
        )
        entity_id = str(cell_id or column_id or row_id or sheet_id)
        await self.audit_service.record(
            action=audit_action,
            module=MODULE_NAME,
            user_id=user_id,
            username_snapshot=username,
            entity_type=action.value.split("_")[0].lower(),
            entity_id=entity_id,
            old_values={"value": old_value} if old_value is not None else None,
            new_values={"value": new_value} if new_value is not None else None,
            description=description,
        )

    # --- Sheets ------------------------------------------------------------------

    async def list_sheets(self) -> list[PlanningSheet]:
        return await self.sheet_repository.list_active()

    async def get_sheet_or_raise(self, sheet_id: uuid.UUID) -> PlanningSheet:
        sheet = await self.sheet_repository.get_by_id(sheet_id)
        if sheet is None:
            raise NotFoundException("Planning sheet not found.")
        return sheet

    async def create_sheet(self, *, name: str, description: str | None, user_id: uuid.UUID, username: str) -> PlanningSheet:
        name = name.strip()
        if not name:
            raise BadRequestException("Sheet name is required.")
        if await self.sheet_repository.get_by_name(name):
            raise ConflictException(f"A sheet named {name!r} already exists.")
        position = await self.sheet_repository.next_position()
        sheet = await self.sheet_repository.create(
            name=name, description=description, position=position, created_by=user_id
        )
        await self._record_change(
            action=PlanningChangeAction.SHEET_CREATED,
            sheet_id=sheet.id,
            user_id=user_id,
            username=username,
            new_value=name,
            description=f"Created sheet '{name}'.",
        )
        return sheet

    async def rename_sheet(self, sheet_id: uuid.UUID, *, name: str, user_id: uuid.UUID, username: str) -> PlanningSheet:
        sheet = await self.get_sheet_or_raise(sheet_id)
        name = name.strip()
        if not name:
            raise BadRequestException("Sheet name is required.")
        existing = await self.sheet_repository.get_by_name(name)
        if existing and existing.id != sheet_id:
            raise ConflictException(f"A sheet named {name!r} already exists.")
        old_name = sheet.name
        sheet = await self.sheet_repository.update(sheet, name=name)
        await self._record_change(
            action=PlanningChangeAction.SHEET_RENAMED,
            sheet_id=sheet.id,
            user_id=user_id,
            username=username,
            old_value=old_name,
            new_value=name,
            description=f"Renamed sheet '{old_name}' to '{name}'.",
        )
        return sheet

    async def delete_sheet(self, sheet_id: uuid.UUID, *, user_id: uuid.UUID, username: str) -> None:
        sheet = await self.get_sheet_or_raise(sheet_id)
        name = sheet.name
        await self.sheet_repository.delete(sheet)
        await self._record_change(
            action=PlanningChangeAction.SHEET_DELETED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            old_value=name,
            description=f"Deleted sheet '{name}'.",
        )

    # --- Grid read (rows + columns + cells for one sheet) -------------------------

    async def get_grid(self, sheet_id: uuid.UUID) -> dict[str, Any]:
        """Fetch everything needed to render one sheet's grid in a single call."""
        sheet = await self.get_sheet_or_raise(sheet_id)
        columns = await self.column_repository.list_for_sheet(sheet_id)
        rows = await self.row_repository.list_for_sheet(sheet_id)
        return {"sheet": sheet, "columns": columns, "rows": rows}

    # --- Columns (admin-defined, unlimited, insertable at any position) ----------

    async def add_column(
        self,
        sheet_id: uuid.UUID,
        *,
        name: str,
        data_type: PlanningColumnDataType,
        position: int | None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningColumn:
        """
        Add a new column, admin-named, at ``position`` (or appended at the end if omitted).

        This is the only code path for adding a column -- the workbook's
        built-in columns (Supplier Name, Mum 40, Mum 40 Remarks, ...) are
        ordinary rows in ``planning_columns`` created the same way, so
        "the admin can add unlimited columns and name them whatever" has
        no special case to fall through to.
        """
        await self.get_sheet_or_raise(sheet_id)
        name = name.strip()
        if not name:
            raise BadRequestException("Column name is required.")
        if await self.column_repository.get_by_name(sheet_id, name):
            raise ConflictException(f"A column named {name!r} already exists on this sheet.")

        existing_columns = await self.column_repository.list_for_sheet(sheet_id)
        target_position = position if position is not None else len(existing_columns)
        target_position = max(0, min(target_position, len(existing_columns)))

        await self.column_repository.shift_positions_after(sheet_id, target_position, delta=1)
        column = await self.column_repository.create(
            sheet_id=sheet_id,
            name=name,
            data_type=data_type,
            position=target_position,
            created_by=user_id,
        )
        await self._record_change(
            action=PlanningChangeAction.COLUMN_ADDED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            column_id=column.id,
            new_value=name,
            description=f"Added column '{name}' at position {target_position}.",
        )
        return column

    async def rename_column(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, name: str, user_id: uuid.UUID, username: str
    ) -> PlanningColumn:
        column = await self._get_column_or_raise(sheet_id, column_id)
        name = name.strip()
        if not name:
            raise BadRequestException("Column name is required.")
        existing = await self.column_repository.get_by_name(sheet_id, name)
        if existing and existing.id != column_id:
            raise ConflictException(f"A column named {name!r} already exists on this sheet.")
        old_name = column.name
        column = await self.column_repository.update(column, name=name, updated_by=user_id)
        await self._record_change(
            action=PlanningChangeAction.COLUMN_RENAMED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            column_id=column.id,
            old_value=old_name,
            new_value=name,
            description=f"Renamed column '{old_name}' to '{name}'.",
        )
        return column

    async def move_column(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, new_position: int, user_id: uuid.UUID, username: str
    ) -> PlanningColumn:
        """Move a column to ``new_position``, re-sequencing every column between the old and new spot."""
        column = await self._get_column_or_raise(sheet_id, column_id)
        columns = await self.column_repository.list_for_sheet(sheet_id)
        new_position = max(0, min(new_position, len(columns) - 1))
        old_position = column.position
        if new_position == old_position:
            return column

        if new_position < old_position:
            await self.column_repository.shift_positions_after(sheet_id, new_position, delta=1)
            await self.column_repository.shift_positions_after(sheet_id, old_position + 1, delta=-1)
        else:
            await self.column_repository.shift_positions_after(sheet_id, old_position, delta=-1)
            await self.column_repository.shift_positions_after(sheet_id, new_position + 1, delta=1)

        column = await self.column_repository.update(column, position=new_position, updated_by=user_id)
        await self._record_change(
            action=PlanningChangeAction.COLUMN_MOVED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            column_id=column.id,
            old_value=str(old_position),
            new_value=str(new_position),
            description=f"Moved column '{column.name}' from position {old_position} to {new_position}.",
        )
        return column

    async def delete_column(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, user_id: uuid.UUID, username: str
    ) -> None:
        column = await self._get_column_or_raise(sheet_id, column_id)
        name = column.name
        position = column.position
        await self.column_repository.delete(column)
        await self.column_repository.shift_positions_after(sheet_id, position + 1, delta=-1)
        await self._record_change(
            action=PlanningChangeAction.COLUMN_DELETED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            column_id=column_id,
            old_value=name,
            description=f"Deleted column '{name}'.",
        )

    async def get_column(self, sheet_id: uuid.UUID, column_id: uuid.UUID) -> PlanningColumn:
        """Public wrapper around ``_get_column_or_raise`` for routes that just need the column (e.g. to recompute a display value)."""
        return await self._get_column_or_raise(sheet_id, column_id)

    async def _get_column_or_raise(self, sheet_id: uuid.UUID, column_id: uuid.UUID) -> PlanningColumn:
        column = await self.column_repository.get_by_id(column_id)
        if column is None or column.sheet_id != sheet_id:
            raise NotFoundException("Column not found on this sheet.")
        return column

    async def check_column_role_lock(self, column_id: uuid.UUID, *, user_id: uuid.UUID) -> None:
        """
        Enforce a column's optional per-column role lock, if it has one.

        The sheet-level ``planning.column.manage`` / ``planning.cell.edit``
        permissions are already checked by the route layer before this
        runs; this is an *additional*, optional restriction an admin can
        layer on top for one specific column ("only the Purchase team can
        touch this column"). A column with no role locks is unaffected --
        this is purely additive, matching the confirmed scope.

        super_admin always bypasses, matching the system-wide convention
        (see app.rbac.dependencies.require_super_admin).
        """
        if self.user_role_repository is None:
            return  # Role-lock enforcement unavailable in this context; sheet-level permission still applies.

        lock_role_ids = await self.column_repository.list_role_lock_ids(column_id)
        if not lock_role_ids:
            return  # No lock set on this column -- sheet-level permission is sufficient.

        user_roles = await self.user_role_repository.list_for_user(user_id)
        user_role_names = {ur.role.name for ur in user_roles if ur.role is not None}
        if "super_admin" in user_role_names:
            return

        user_role_ids = {ur.role_id for ur in user_roles}
        if not user_role_ids.intersection(lock_role_ids):
            raise ForbiddenException(
                "This column is restricted to specific roles by an administrator. "
                "You don't hold a role permitted to edit it."
            )

    async def set_column_role_lock(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, role_ids: list[uuid.UUID], user_id: uuid.UUID, username: str
    ) -> PlanningColumn:
        """
        Set (or clear, with an empty list) the roles allowed to edit one column.

        Document: "admin can also lock individual columns to specific
        roles, on top of the sheet-level permission." Only a user with
        ``planning.column.manage`` (checked at the route layer) can call
        this -- setting a role lock is itself a sheet-level admin action,
        not gated by the lock it's creating.
        """
        column = await self._get_column_or_raise(sheet_id, column_id)
        await self.column_role_lock_repository.replace_for_column(column_id, role_ids, created_by=user_id)
        await self._record_change(
            action=PlanningChangeAction.COLUMN_ROLE_LOCK_CHANGED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            column_id=column.id,
            new_value=f"{len(role_ids)} role(s)",
            description=f"Set role lock on column '{column.name}' to {len(role_ids)} role(s).",
        )
        return column

    async def set_column_status_color_enabled(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, enabled: bool, user_id: uuid.UUID, username: str
    ) -> PlanningColumn:
        """
        Opt a column in/out of carrying CRM-style cell status colors.

        Off by default for every column, including pre-existing ones.
        Turning it off doesn't clear any status colors already set on
        that column's cells (the data isn't touched) -- it only hides the
        status-dot button going forward and blocks setting new ones
        (see set_cell_status's enforcement of this flag).
        """
        column = await self._get_column_or_raise(sheet_id, column_id)
        old_value = column.enable_status_color
        column = await self.column_repository.update(column, enable_status_color=enabled, updated_by=user_id)
        if old_value != enabled:
            await self._record_change(
                action=PlanningChangeAction.COLUMN_STATUS_COLOR_TOGGLED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                column_id=column.id,
                old_value=str(old_value),
                new_value=str(enabled),
                description=f"{'Enabled' if enabled else 'Disabled'} status colors on column '{column.name}'.",
            )
        return column

    async def get_column_role_lock_ids(self, sheet_id: uuid.UUID, column_id: uuid.UUID) -> list[uuid.UUID]:
        await self._get_column_or_raise(sheet_id, column_id)
        return await self.column_repository.list_role_lock_ids(column_id)

    # --- Dynamic column sourcing: linked lookup / aggregate / formula --------------

    def list_available_source_modules(self) -> list[dict[str, Any]]:
        """Return every registered source module + its allow-listed fields, for the admin UI's dropdowns."""
        return [
            {
                "key": mod.key,
                "label": mod.label,
                "fields": [{"key": f.key, "label": f.label, "is_numeric": f.is_numeric} for f in mod.fields],
            }
            for mod in source_registry.list_source_modules()
        ]

    async def configure_column_source(
        self,
        sheet_id: uuid.UUID,
        column_id: uuid.UUID,
        *,
        source_type: PlanningColumnSourceType,
        source_module: str | None,
        source_field: str | None,
        source_aggregate_fn: str | None,
        source_aggregate_filters: dict | None,
        formula_expression: str | None,
        enable_description: bool,
        auto_populate_enabled: bool = False,
        auto_populate_limit: int | None = None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningColumn:
        """
        Turn a column into MANUAL / LINKED_LOOKUP / AGGREGATE / FORMULA, or reconfigure it.

        This is the single entry point for the "extract data from other
        parts" and "add any calculation" feature -- every validation rule
        for each source type lives here, so a column can never be saved
        in a half-configured state that would fail later at read time.
        """
        column = await self._get_column_or_raise(sheet_id, column_id)
        await self.check_column_role_lock(column_id, user_id=user_id)

        if source_type == PlanningColumnSourceType.MANUAL:
            updated = await self.column_repository.update(
                column,
                source_type=source_type,
                source_module=None,
                source_field=None,
                source_aggregate_fn=None,
                source_aggregate_filters=None,
                formula_expression=None,
                is_locked=False,
                enable_description=enable_description,
                auto_populate_enabled=auto_populate_enabled,
                auto_populate_limit=auto_populate_limit,
                updated_by=user_id,
            )

        elif source_type == PlanningColumnSourceType.LINKED_LOOKUP:
            module = source_registry.get_source_module(source_module or "")
            if module is None:
                raise BadRequestException(f"Unknown source module {source_module!r}.")
            field = source_registry.get_source_field(module.key, source_field or "")
            if field is None:
                raise BadRequestException(f"Unknown field {source_field!r} on source module {module.key!r}.")
            updated = await self.column_repository.update(
                column,
                source_type=source_type,
                source_module=module.key,
                source_field=field.key,
                source_aggregate_fn=None,
                source_aggregate_filters=None,
                formula_expression=None,
                is_locked=True,  # computed -- direct cell edits are rejected (see set_cell_value)
                enable_description=enable_description,
                auto_populate_enabled=auto_populate_enabled,
                auto_populate_limit=auto_populate_limit,
                updated_by=user_id,
            )

        elif source_type == PlanningColumnSourceType.AGGREGATE:
            module = source_registry.get_source_module(source_module or "")
            if module is None:
                raise BadRequestException(f"Unknown source module {source_module!r}.")
            field = source_registry.get_source_field(module.key, source_field or "")
            if field is None:
                raise BadRequestException(f"Unknown field {source_field!r} on source module {module.key!r}.")
            valid_fns = {"count", "sum", "avg", "min", "max"}
            if source_aggregate_fn not in valid_fns:
                raise BadRequestException(f"source_aggregate_fn must be one of {sorted(valid_fns)}.")
            if source_aggregate_fn != "count" and not field.is_numeric:
                raise BadRequestException(f"Field {field.key!r} is not numeric; only 'count' is valid for it.")
            updated = await self.column_repository.update(
                column,
                source_type=source_type,
                source_module=module.key,
                source_field=field.key,
                source_aggregate_fn=source_aggregate_fn,
                source_aggregate_filters=source_aggregate_filters,
                formula_expression=None,
                is_locked=True,
                enable_description=enable_description,
                auto_populate_enabled=auto_populate_enabled,
                auto_populate_limit=auto_populate_limit,
                updated_by=user_id,
            )

        elif source_type == PlanningColumnSourceType.FORMULA:
            if not formula_expression or not formula_expression.strip():
                raise BadRequestException("formula_expression is required for FORMULA columns.")
            sibling_columns = await self.column_repository.list_for_sheet(sheet_id)
            known_names = {c.name for c in sibling_columns if c.id != column_id}
            try:
                validate_formula_syntax(formula_expression, known_column_names=known_names)
            except FormulaError:
                raise  # already a BadRequestException subclass; re-raise as-is with its own message
            updated = await self.column_repository.update(
                column,
                source_type=source_type,
                source_module=None,
                source_field=None,
                source_aggregate_fn=None,
                source_aggregate_filters=None,
                formula_expression=formula_expression.strip(),
                is_locked=True,
                enable_description=enable_description,
                auto_populate_enabled=auto_populate_enabled,
                auto_populate_limit=auto_populate_limit,
                updated_by=user_id,
            )
        else:
            raise BadRequestException(f"Unknown source_type {source_type!r}.")

        await self._record_change(
            action=PlanningChangeAction.COLUMN_SOURCE_CONFIGURED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            column_id=column.id,
            new_value=source_type.value,
            description=f"Configured column '{column.name}' as {source_type.value}.",
        )
        return updated

    async def link_row_to_source_record(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        column_id: uuid.UUID,
        *,
        record_id: uuid.UUID,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningCell:
        """
        Link one row's cell (under a LINKED_LOOKUP column) to a specific record in that column's source module.

        E.g. "this row's Product Weight column is linked to Product X" --
        the displayed value (Product X's packaging_net_weight) is computed
        fresh on every read, not frozen at link time, so it stays correct
        if the Product master's data changes later.
        """
        row = await self._get_row_or_raise(sheet_id, row_id)
        column = await self._get_column_or_raise(sheet_id, column_id)
        await self.check_column_role_lock(column_id, user_id=user_id)

        if column.source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            raise BadRequestException(f"Column '{column.name}' is not configured as a linked-lookup column.")
        module = source_registry.get_source_module(column.source_module or "")
        if module is None:
            raise ConflictException(f"Column '{column.name}' references an unregistered source module.")

        repository = module.repository_factory(self.cell_repository.session)
        record = await repository.get_by_id(record_id)
        if record is None:
            raise BadRequestException(f"No {module.label} record found with that ID.")

        cell = await self.cell_repository.get_by_row_and_column(row_id, column_id)
        if cell is None:
            cell = await self.cell_repository.create(
                row_id=row_id, column_id=column_id, linked_record_id=record_id, updated_by=user_id
            )
        else:
            cell = await self.cell_repository.update(cell, linked_record_id=record_id, updated_by=user_id)

        await self._record_change(
            action=PlanningChangeAction.CELL_VALUE_CHANGED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            row_id=row_id,
            column_id=column_id,
            cell_id=cell.id,
            new_value=str(record_id),
            description=f"Linked '{row.label}' / '{column.name}' to a {module.label} record.",
        )
        return cell

    async def auto_link_column_to_item_records(
        self,
        sheet_id: uuid.UUID,
        column_id: uuid.UUID,
        *,
        user_id: uuid.UUID,
        username: str,
    ) -> list[PlanningCell]:
        """
        Bulk-link every row's cell under this column to the SAME record its
        ITEM is already linked to, instead of clicking 🔗 once per row per
        column. Only meaningful when this column pulls from the same source
        module as the sheet's ITEM -- e.g. ITEM is "Product Name" from
        Product Master and this column is "Packaging Net Weight" from the
        same Product Master, so "the product this row is" is the same
        record both places.

        Rows with no ITEM link yet, or whose linked record doesn't belong
        to this column's module, are simply skipped rather than erroring,
        so this is always safe to run again after adding more rows.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        column = await self._get_column_or_raise(sheet_id, column_id)
        await self.check_column_role_lock(column_id, user_id=user_id)

        if column.source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            raise BadRequestException(f"Column '{column.name}' is not configured as a linked-lookup column.")
        if sheet.item_source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            raise BadRequestException("The sheet's ITEM column must be linked-lookup for this to have any rows to copy from.")
        if column.source_module != sheet.item_source_module:
            raise BadRequestException(
                f"Column '{column.name}' pulls from a different module than ITEM "
                f"({column.source_module!r} vs {sheet.item_source_module!r}), so there's no matching record to copy."
            )

        rows = await self.row_repository.list_for_sheet(sheet_id)
        cells_by_row: dict[uuid.UUID, PlanningCell] = {}
        for r in rows:
            for c in r.cells:
                if c.column_id == column_id:
                    cells_by_row[r.id] = c

        updated: list[PlanningCell] = []
        for row in rows:
            if row.linked_record_id is None:
                continue
            existing_cell = cells_by_row.get(row.id)
            if existing_cell is not None and existing_cell.linked_record_id == row.linked_record_id:
                continue  # already matches -- nothing to do
            if existing_cell is None:
                cell = await self.cell_repository.create(
                    row_id=row.id, column_id=column_id, linked_record_id=row.linked_record_id, updated_by=user_id
                )
            else:
                cell = await self.cell_repository.update(existing_cell, linked_record_id=row.linked_record_id, updated_by=user_id)
            updated.append(cell)

        if updated:
            await self._record_change(
                action=PlanningChangeAction.CELL_VALUE_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                column_id=column_id,
                description=f"Auto-linked {len(updated)} row(s) in '{column.name}' to their ITEM's record.",
            )
        return updated

    async def configure_item_source(
        self,
        sheet_id: uuid.UUID,
        *,
        source_type: PlanningColumnSourceType,
        source_module: str | None,
        source_field: str | None,
        formula_expression: str | None,
        item_enable_description: bool,
        item_auto_populate_enabled: bool = False,
        item_auto_populate_limit: int | None = None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningSheet:
        """
        Configure the sheet's built-in ITEM column data source (MANUAL / LINKED_LOOKUP / FORMULA).

        Mirrors ``configure_column_source`` but writes to the sheet
        itself, since ITEM isn't a row in ``planning_columns``. AGGREGATE
        isn't offered here -- a single sheet-wide number repeated as every
        row's item name isn't a meaningful use of this column.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)

        if source_type == PlanningColumnSourceType.MANUAL:
            updated = await self.sheet_repository.update(
                sheet,
                item_source_type=source_type,
                item_source_module=None,
                item_source_field=None,
                item_formula_expression=None,
                item_enable_description=item_enable_description,
                item_auto_populate_enabled=item_auto_populate_enabled,
                item_auto_populate_limit=item_auto_populate_limit,
            )

        elif source_type == PlanningColumnSourceType.LINKED_LOOKUP:
            module = source_registry.get_source_module(source_module or "")
            if module is None:
                raise BadRequestException(f"Unknown source module {source_module!r}.")
            field = source_registry.get_source_field(module.key, source_field or "")
            if field is None:
                raise BadRequestException(f"Unknown field {source_field!r} on source module {module.key!r}.")
            updated = await self.sheet_repository.update(
                sheet,
                item_source_type=source_type,
                item_source_module=module.key,
                item_source_field=field.key,
                item_formula_expression=None,
                item_enable_description=item_enable_description,
                item_auto_populate_enabled=item_auto_populate_enabled,
                item_auto_populate_limit=item_auto_populate_limit,
            )

        elif source_type == PlanningColumnSourceType.FORMULA:
            if not formula_expression or not formula_expression.strip():
                raise BadRequestException("formula_expression is required for FORMULA.")
            sibling_columns = await self.column_repository.list_for_sheet(sheet_id)
            known_names = {c.name for c in sibling_columns}
            try:
                validate_formula_syntax(formula_expression, known_column_names=known_names)
            except FormulaError:
                raise
            updated = await self.sheet_repository.update(
                sheet,
                item_source_type=source_type,
                item_source_module=None,
                item_source_field=None,
                item_formula_expression=formula_expression.strip(),
                item_enable_description=item_enable_description,
                item_auto_populate_enabled=item_auto_populate_enabled,
                item_auto_populate_limit=item_auto_populate_limit,
            )
        else:
            raise BadRequestException(f"Unknown source_type {source_type!r} for the ITEM column.")

        await self._record_change(
            action=PlanningChangeAction.COLUMN_SOURCE_CONFIGURED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            description=f"Configured ITEM column as {source_type.value}.",
        )
        return updated

    async def link_row_to_item_source_record(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        *,
        record_id: uuid.UUID,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningRow:
        """Link one row's ITEM cell to a specific record in the sheet's item_source_module."""
        sheet = await self.get_sheet_or_raise(sheet_id)
        row = await self._get_row_or_raise(sheet_id, row_id)

        if sheet.item_source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            raise BadRequestException("The ITEM column is not configured as a linked-lookup column.")
        module = source_registry.get_source_module(sheet.item_source_module or "")
        if module is None:
            raise ConflictException("The ITEM column references an unregistered source module.")

        repository = module.repository_factory(self.row_repository.session)
        record = await repository.get_by_id(record_id)
        if record is None:
            raise BadRequestException(f"No {module.label} record found with that ID.")

        row = await self.row_repository.update(row, linked_record_id=record_id, updated_by=user_id)

        await self._record_change(
            action=PlanningChangeAction.CELL_VALUE_CHANGED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            row_id=row_id,
            new_value=str(record_id),
            description=f"Linked row's ITEM to a {module.label} record.",
        )
        return row

    async def auto_populate_rows_from_item_source(
        self,
        sheet_id: uuid.UUID,
        *,
        limit: int | None,
        user_id: uuid.UUID,
        username: str,
    ) -> list[PlanningRow]:
        """
        Bulk-create rows straight from the sheet's configured item source
        module, one row per record, already linked -- the "check a box
        instead of linking one row at a time" option next to the manual
        per-row 🔗 flow.

        Skips any record that's already linked to an existing row in this
        sheet (comparing against every linked row, not just ones from a
        previous auto-populate call), so repeating this with a bigger page
        size to pull more records in doesn't create duplicate rows for
        records already on the sheet.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        if sheet.item_source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            raise BadRequestException("The ITEM column is not configured as a linked-lookup column.")
        module = source_registry.get_source_module(sheet.item_source_module or "")
        if module is None:
            raise ConflictException("The ITEM column references an unregistered source module.")

        repository = module.repository_factory(self.row_repository.session)
        records = await repository.list(offset=0, limit=limit)

        existing_rows = await self.row_repository.list_for_sheet(sheet_id)
        already_linked_ids = {r.linked_record_id for r in existing_rows if r.linked_record_id is not None}
        next_position = len(existing_rows)

        created: list[PlanningRow] = []
        for record in records:
            if record.id in already_linked_ids:
                continue
            row = await self.row_repository.create(
                sheet_id=sheet_id,
                label=f"{module.label} record",  # placeholder only -- LINKED_LOOKUP always displays the live computed value instead
                position=next_position,
                linked_record_id=record.id,
                created_by=user_id,
            )
            next_position += 1
            created.append(row)

        if created:
            await self._record_change(
                action=PlanningChangeAction.ROW_ADDED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                description=f"Auto-populated {len(created)} row(s) from {module.label} (loaded {len(records)}, "
                f"{len(records) - len(created)} already on the sheet).",
            )
        return created


    async def compute_row_item_display(self, sheet: PlanningSheet, row: PlanningRow) -> str:
        """
        Return the effective ITEM value for a row, computing it live when the
        sheet's ITEM column is linked-lookup or formula (same "never trust a
        stale value" behavior as ``compute_cell_display_value``).

        Falls back to ``row.label`` for MANUAL (unchanged, original
        behavior) and whenever a linked/formula value isn't available yet
        (e.g. the row hasn't been linked to a record), so a row is never
        left with a blank name.
        """
        if sheet.item_source_type == PlanningColumnSourceType.MANUAL:
            return row.label

        # Reuse compute_cell_display_value by describing the sheet's ITEM
        # config as a column-shaped object -- same fields it reads, without
        # needing a real (persisted) PlanningColumn row for it to exist.
        pseudo_column = PlanningColumn(
            sheet_id=sheet.id,
            source_type=sheet.item_source_type,
            source_module=sheet.item_source_module,
            source_field=sheet.item_source_field,
            source_aggregate_fn=None,
            source_aggregate_filters=None,
            formula_expression=sheet.item_formula_expression,
        )
        pseudo_cell = (
            PlanningCell(row_id=row.id, column_id=uuid.uuid4(), linked_record_id=row.linked_record_id)
            if row.linked_record_id is not None
            else None
        )
        display = await self.compute_cell_display_value(pseudo_column, pseudo_cell, row_id=row.id)
        return display if display else row.label

    async def compute_cell_display_value(
        self, column: PlanningColumn, cell: PlanningCell | None, *, row_id: uuid.UUID | None = None
    ) -> str | None:
        """
        Return the effective display value for one cell, computing it live for non-manual columns.

        MANUAL columns just return the stored value unchanged (original
        behavior, zero risk of regression). The other three source types
        never trust a stale stored ``value`` -- they recompute from the
        live source data on every call, so a later change in the Product
        master (for example) is reflected immediately without any manual
        "refresh" step.

        ``row_id`` is accepted explicitly (rather than always reading
        ``cell.row_id``) because a FORMULA column never has a stored cell
        of its own -- direct edits to it are rejected -- so ``cell`` is
        routinely ``None`` for these columns even though the row's other
        (sibling) cell values it needs are very much present.
        """
        if column.source_type == PlanningColumnSourceType.MANUAL:
            return cell.value if cell else None

        if column.source_type == PlanningColumnSourceType.LINKED_LOOKUP:
            if cell is None or cell.linked_record_id is None:
                return None
            module = source_registry.get_source_module(column.source_module or "")
            if module is None:
                return None
            repository = module.repository_factory(self.cell_repository.session)
            record = await repository.get_by_id(cell.linked_record_id)
            if record is None:
                return None
            value = module.value_getter(record, column.source_field or "")
            return str(value) if value is not None else None

        if column.source_type == PlanningColumnSourceType.AGGREGATE:
            module = source_registry.get_source_module(column.source_module or "")
            if module is None:
                return None
            repository = module.repository_factory(self.cell_repository.session)
            filters = column.source_aggregate_filters or {}
            if column.source_aggregate_fn == "count":
                total = await repository.count(filters=filters)
                return str(total)
            # sum/avg/min/max: fetch matching rows (bounded to a sane page size)
            # and reduce client-side -- BaseRepository has no generic
            # aggregate-by-field SQL helper, and adding one for a handful of
            # numeric fields isn't worth a new abstraction layer here.
            rows = await repository.list(offset=0, limit=5000, filters=filters)
            # DB numeric columns (SQLAlchemy `Numeric`) come back as
            # `Decimal`, not `int`/`float` -- without explicitly allowing
            # Decimal here, every such field (most of Product's numeric
            # fields, e.g. packaging weights, stock, cost/price) would be
            # silently dropped from the aggregate, so SUM/AVG/MIN/MAX would
            # look like they ran but always return "0" or nothing.
            values: list[float] = [
                float(v)
                for r in rows
                if (v := module.value_getter(r, column.source_field or "")) is not None
                and isinstance(v, (int, float, Decimal))
            ]
            if not values:
                return "0" if column.source_aggregate_fn == "sum" else None
            if column.source_aggregate_fn == "sum":
                return str(sum(values))
            if column.source_aggregate_fn == "avg":
                return str(sum(values) / len(values))
            if column.source_aggregate_fn == "min":
                return str(min(values))
            if column.source_aggregate_fn == "max":
                return str(max(values))
            return None

        if column.source_type == PlanningColumnSourceType.FORMULA:
            effective_row_id = row_id if row_id is not None else (cell.row_id if cell else None)
            if not column.formula_expression or effective_row_id is None:
                return None
            row_cells = await self.cell_repository.list_for_rows([effective_row_id])
            cells_by_column_id = {rc.column_id: rc for rc in row_cells}
            sibling_columns = await self.column_repository.list_for_sheet(column.sheet_id)
            row_values: dict[str, float] = {}
            for sibling in sibling_columns:
                # A formula can name any sibling column, not just MANUAL
                # ones -- but LINKED_LOOKUP and AGGREGATE columns never
                # store a raw `cell.value` (their value only exists as a
                # live computed display value), so reading `rc.value`
                # alone silently made those columns invisible to formulas
                # even though the module/field extraction itself was
                # working fine on its own column. Recompute each sibling's
                # effective value the same way the grid does, instead of
                # only trusting the stored cell.
                if sibling.id == column.id:
                    continue
                if sibling.source_type == PlanningColumnSourceType.FORMULA:
                    # Skip formula-referencing-formula: nothing here
                    # detects cycles, so recursing would risk infinite
                    # recursion between two formula columns that reference
                    # each other.
                    continue
                sibling_cell = cells_by_column_id.get(sibling.id)
                raw_value = await self.compute_cell_display_value(sibling, sibling_cell, row_id=effective_row_id)
                if raw_value is None:
                    continue
                try:
                    row_values[sibling.name] = float(raw_value)
                except ValueError:
                    continue  # non-numeric sibling value -- simply unavailable to the formula, not an error
            try:
                result = evaluate_formula(column.formula_expression, row_values=row_values)
            except FormulaError:
                return None  # a formula error on read shows as an empty cell, not a broken page
            return str(result)

        return None

    # --- Rows (item lines, unlimited) ---------------------------------------------

    async def add_row(
        self, sheet_id: uuid.UUID, *, label: str, position: int | None, user_id: uuid.UUID, username: str
    ) -> PlanningRow:
        await self.get_sheet_or_raise(sheet_id)
        label = label.strip()
        if not label:
            raise BadRequestException("Row label is required.")

        existing_rows = await self.row_repository.list_for_sheet(sheet_id)
        target_position = position if position is not None else len(existing_rows)
        target_position = max(0, min(target_position, len(existing_rows)))

        await self.row_repository.shift_positions_after(sheet_id, target_position, delta=1)
        row = await self.row_repository.create(
            sheet_id=sheet_id, label=label, position=target_position, created_by=user_id
        )
        await self._record_change(
            action=PlanningChangeAction.ROW_ADDED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            row_id=row.id,
            new_value=label,
            description=f"Added row '{label}' at position {target_position}.",
        )
        return row

    async def rename_row(
        self, sheet_id: uuid.UUID, row_id: uuid.UUID, *, label: str, user_id: uuid.UUID, username: str
    ) -> PlanningRow:
        row = await self._get_row_or_raise(sheet_id, row_id)
        label = label.strip()
        if not label:
            raise BadRequestException("Row label is required.")
        old_label = row.label
        row = await self.row_repository.update(row, label=label, updated_by=user_id)
        await self._record_change(
            action=PlanningChangeAction.ROW_RENAMED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            row_id=row.id,
            old_value=old_label,
            new_value=label,
            description=f"Renamed row '{old_label}' to '{label}'.",
        )
        return row

    async def move_row(
        self, sheet_id: uuid.UUID, row_id: uuid.UUID, *, new_position: int, user_id: uuid.UUID, username: str
    ) -> PlanningRow:
        row = await self._get_row_or_raise(sheet_id, row_id)
        rows = await self.row_repository.list_for_sheet(sheet_id)
        new_position = max(0, min(new_position, len(rows) - 1))
        old_position = row.position
        if new_position == old_position:
            return row

        if new_position < old_position:
            await self.row_repository.shift_positions_after(sheet_id, new_position, delta=1)
            await self.row_repository.shift_positions_after(sheet_id, old_position + 1, delta=-1)
        else:
            await self.row_repository.shift_positions_after(sheet_id, old_position, delta=-1)
            await self.row_repository.shift_positions_after(sheet_id, new_position + 1, delta=1)

        row = await self.row_repository.update(row, position=new_position, updated_by=user_id)
        await self._record_change(
            action=PlanningChangeAction.ROW_MOVED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            row_id=row.id,
            old_value=str(old_position),
            new_value=str(new_position),
            description=f"Moved row '{row.label}' from position {old_position} to {new_position}.",
        )
        return row

    async def delete_row(self, sheet_id: uuid.UUID, row_id: uuid.UUID, *, user_id: uuid.UUID, username: str) -> None:
        row = await self._get_row_or_raise(sheet_id, row_id)
        label = row.label
        position = row.position
        await self.row_repository.delete(row)
        await self.row_repository.shift_positions_after(sheet_id, position + 1, delta=-1)
        await self._record_change(
            action=PlanningChangeAction.ROW_DELETED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            row_id=row_id,
            old_value=label,
            description=f"Deleted row '{label}'.",
        )

    async def _get_row_or_raise(self, sheet_id: uuid.UUID, row_id: uuid.UUID) -> PlanningRow:
        row = await self.row_repository.get_by_id(row_id)
        if row is None or row.sheet_id != sheet_id:
            raise NotFoundException("Row not found on this sheet.")
        return row

    # --- Cells (value + CRM-style status color) -----------------------------------

    async def set_cell_value(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        column_id: uuid.UUID,
        *,
        value: str | None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningCell:
        row = await self._get_row_or_raise(sheet_id, row_id)
        column = await self._get_column_or_raise(sheet_id, column_id)
        if column.is_locked:
            raise ForbiddenException(f"Column '{column.name}' is locked and cannot be edited directly.")

        cell = await self.cell_repository.get_by_row_and_column(row_id, column_id)
        old_value = cell.value if cell else None
        if cell is None:
            cell = await self.cell_repository.create(row_id=row_id, column_id=column_id, value=value, updated_by=user_id)
        else:
            cell = await self.cell_repository.update(cell, value=value, updated_by=user_id)

        if old_value != value:
            await self._record_change(
                action=PlanningChangeAction.CELL_VALUE_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                row_id=row_id,
                column_id=column_id,
                cell_id=cell.id,
                old_value=old_value,
                new_value=value,
                description=f"Changed '{row.label}' / '{column.name}' from {old_value!r} to {value!r}.",
            )
            # Document: "if an user first puts any data or number into that
            # Color status first turn it into Blue automatically" -- every
            # value change re-triggers this (not just the first one), even
            # overriding a status the user set manually before, per the
            # confirmed requirement. Clearing a cell (value is empty/None)
            # does not set a color. Silently skipped on columns that don't
            # allow status colors at all, rather than raising -- typing a
            # value should never be blocked by an unrelated column setting.
            if value is not None and value.strip() and column.enable_status_color:
                try:
                    cell = await self.set_cell_status(
                        sheet_id,
                        row_id,
                        column_id,
                        status_color=PlanningCellStatusColor.BLUE_ORDERED,
                        custom_status_tag_id=None,
                        user_id=user_id,
                        username=username,
                    )
                except BadRequestException:
                    pass  # enable_status_color was checked above, but re-check defensively; never block the value save on this.
        return cell

    async def set_cell_status(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        column_id: uuid.UUID,
        *,
        status_color: PlanningCellStatusColor | None,
        custom_status_tag_id: uuid.UUID | None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningCell:
        """
        Attach/clear a CRM-style status tag on any cell (admin's choice of cell, not restricted to a fixed column).

        ``status_color=None`` clears the tag. ``status_color=CUSTOM`` requires
        ``custom_status_tag_id`` pointing at an admin-defined
        :class:`~app.planning.models.PlanningStatusTag`.
        """
        row = await self._get_row_or_raise(sheet_id, row_id)
        column = await self._get_column_or_raise(sheet_id, column_id)

        if status_color is not None and not column.enable_status_color:
            raise BadRequestException(
                f"Column '{column.name}' does not allow status colors. "
                "An admin must enable this for the column first (see the Columns panel)."
            )

        if status_color == PlanningCellStatusColor.CUSTOM:
            if custom_status_tag_id is None:
                raise BadRequestException("custom_status_tag_id is required when status_color is 'custom'.")
            tag = await self.status_tag_repository.get_by_id(custom_status_tag_id)
            if tag is None:
                raise NotFoundException("Custom status tag not found.")
        else:
            custom_status_tag_id = None

        cell = await self.cell_repository.get_by_row_and_column(row_id, column_id)
        old_status = cell.status_color.value if (cell and cell.status_color) else None
        new_status = status_color.value if status_color else None

        if cell is None:
            cell = await self.cell_repository.create(
                row_id=row_id,
                column_id=column_id,
                status_color=status_color,
                custom_status_tag_id=custom_status_tag_id,
                updated_by=user_id,
            )
        else:
            cell = await self.cell_repository.update(
                cell, status_color=status_color, custom_status_tag_id=custom_status_tag_id, updated_by=user_id
            )

        if old_status != new_status:
            await self._record_change(
                action=PlanningChangeAction.CELL_STATUS_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                row_id=row_id,
                column_id=column_id,
                cell_id=cell.id,
                old_value=old_status,
                new_value=new_status,
                description=f"Changed status on '{row.label}' / '{column.name}' from {old_status!r} to {new_status!r}.",
            )
        return cell

    async def set_cell_description(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        column_id: uuid.UUID,
        *,
        description: str | None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningCell:
        """
        Set or clear a cell's free-text description.

        Independent of the cell's value/status/source-type -- writable
        regardless of whether the column's enable_description is
        currently on, so toggling the setting off and back on later
        doesn't lose anything already written.
        """
        row = await self._get_row_or_raise(sheet_id, row_id)
        column = await self._get_column_or_raise(sheet_id, column_id)

        cell = await self.cell_repository.get_by_row_and_column(row_id, column_id)
        old_description = cell.description if cell else None

        if cell is None:
            cell = await self.cell_repository.create(
                row_id=row_id, column_id=column_id, description=description, updated_by=user_id
            )
        else:
            cell = await self.cell_repository.update(cell, description=description, updated_by=user_id)

        if old_description != description:
            await self._record_change(
                action=PlanningChangeAction.CELL_DESCRIPTION_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                row_id=row_id,
                column_id=column_id,
                cell_id=cell.id,
                old_value=old_description,
                new_value=description,
                description=f"Updated description on '{row.label}' / '{column.name}'.",
            )
        return cell

    async def set_row_description(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        *,
        description: str | None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningRow:
        """
        Set or clear a row's ITEM-cell free-text description.

        Mirrors set_cell_description for the built-in ITEM column, which
        lives directly on PlanningRow rather than as a PlanningCell.
        """
        row = await self._get_row_or_raise(sheet_id, row_id)
        old_description = row.description

        row = await self.row_repository.update(row, description=description, updated_by=user_id)

        if old_description != description:
            await self._record_change(
                action=PlanningChangeAction.ROW_DESCRIPTION_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                row_id=row_id,
                old_value=old_description,
                new_value=description,
                description=f"Updated description on row '{row.label}'.",
            )
        return row

    # --- Status tags (admin-defined custom colors beyond the 3 built-ins) ---------

    async def list_status_tags(self) -> list[PlanningStatusTag]:
        return await self.status_tag_repository.list_active()

    async def create_status_tag(self, *, label: str, hex_color: str, user_id: uuid.UUID) -> PlanningStatusTag:
        label = label.strip()
        if not label:
            raise BadRequestException("Status tag label is required.")
        if not (hex_color.startswith("#") and len(hex_color) == 7):
            raise BadRequestException("hex_color must be a 7-character hex code, e.g. '#F97316'.")
        if await self.status_tag_repository.get_by_label(label):
            raise ConflictException(f"A status tag named {label!r} already exists.")
        return await self.status_tag_repository.create(label=label, hex_color=hex_color, created_by=user_id)

    # --- Change history (who/when) -------------------------------------------------

    async def get_sheet_history(self, sheet_id: uuid.UUID, *, limit: int = 200):
        await self.get_sheet_or_raise(sheet_id)
        return await self.change_log_repository.list_for_sheet(sheet_id, limit=limit)

    async def get_row_history(self, sheet_id: uuid.UUID, row_id: uuid.UUID, *, limit: int = 100):
        await self._get_row_or_raise(sheet_id, row_id)
        return await self.change_log_repository.list_for_row(row_id, limit=limit)

    async def get_mum_column_status_history_for_row(
        self, sheet_id: uuid.UUID, row_id: uuid.UUID, *, limit: int = 200
    ) -> list[dict[str, Any]]:
        """
        Build the Approval Date column's hover-history feed for one row.

        Document: "When Mum 45 was blue and when Mum 46 was blue and other
        color too" -- a chronological list of every status-color change on
        that row's Mum-series columns (name starts with "mum",
        case-insensitive; e.g. "Mum45", "MUM 47", "mum46 remarks" all
        match), each entry showing which column, old/new color, and when.

        Built from the existing PlanningChangeLog rather than a new
        tracking mechanism -- CELL_STATUS_CHANGED events already carry
        everything this needs; this method is purely a filtered,
        column-name-resolved view over data already being recorded by
        set_cell_status (including the auto-blue-on-value-entry path in
        set_cell_value, which calls set_cell_status internally).
        """
        await self._get_row_or_raise(sheet_id, row_id)
        columns = await self.column_repository.list_for_sheet(sheet_id)
        mum_column_names = {c.id: c.name for c in columns if c.name.strip().lower().startswith("mum")}
        if not mum_column_names:
            return []

        entries = await self.change_log_repository.list_for_row(row_id, limit=limit)
        results = []
        for entry in entries:
            if entry.action != PlanningChangeAction.CELL_STATUS_CHANGED:
                continue
            if entry.column_id not in mum_column_names:
                continue
            results.append(
                {
                    "column_id": entry.column_id,
                    "column_name": mum_column_names[entry.column_id],
                    "old_status": entry.old_value,
                    "new_status": entry.new_value,
                    "changed_at": entry.created_at,
                    "changed_by_username": entry.changed_by_username_snapshot,
                }
            )
        return results

    async def get_column_history(self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, limit: int = 100):
        await self._get_column_or_raise(sheet_id, column_id)
        return await self.change_log_repository.list_for_column(column_id, limit=limit)