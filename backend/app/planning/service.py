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

import re
import uuid
from decimal import Decimal
from typing import Any

from sqlalchemy import select, update

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
    ColumnSearchFilter,
    PlanningCellRepository,
    PlanningChangeLogRepository,
    PlanningColumnRepository,
    PlanningColumnRoleLockRepository,
    PlanningRowRepository,
    PlanningSheetRepository,
    PlanningStatusTagRepository,
)

MODULE_NAME = "planning"

# Sentinel for compute_cell_display_value's optional `prefetched_record`
# param -- see that method's docstring for why this can't just default to
# `None` (None is itself a meaningful "resolved to nothing" value).
_UNSET = object()


def _is_pure_mum_column(name: str, *, label: str = "Mum") -> bool:
    cleaned = name.strip().lower()
    if "remark" in cleaned or cleaned.startswith(("no. of pkg", "total")):
        return False
    return bool(re.match(rf"^{re.escape(label.lower())}\s*\d+$", cleaned, re.IGNORECASE))


def mum_num_from_column_name(col_name: str, *, label: str = "Mum") -> int | None:
    """
    Return the group number if ``col_name`` is that sheet's main group
    column (e.g. "Mum 3" when ``label`` is "Mum", or "Chen 3" when
    ``label`` is "Chen"), else None.

    Excludes the "NO. OF PKG"/"TOTAL ..." derived totals and the
    "<label>N Remarks" companion, the same as the previous hardcoded
    "mum" version -- this is a drop-in, label-aware replacement for what
    used to be inline ``_get_mum_num`` closures duplicated at each call
    site.
    """
    cleaned = col_name.strip().lower()
    if "remark" in cleaned or cleaned.startswith(("no. of pkg", "total")):
        return None
    match = re.search(rf"^{re.escape(label.lower())}\s*(\d+)$", cleaned, re.IGNORECASE)
    return int(match.group(1)) if match else None


# --- Fixed (non-editable) formulas for the Mum-group package/weight/CBM totals ---
#
# "NO. OF PKG MUM<n>", "TOTAL WEIGHT MUM<n>", and "TOTAL CBM MUM<n>" are not
# admin-written FORMULA columns (an admin could previously type any
# expression here, including a wrong one -- e.g. the historical bug where
# the frontend wired "NO. OF PKG" as `Mum N * PKG QTY` instead of dividing).
# These three are always computed the one fixed, correct way, straight from
# the row's linked Product Master record, and the admin-supplied
# formula_expression text is never consulted for them:
#
#   NO. OF PKG MUM<n>    = Mum<n> / PKG QTY
#   TOTAL WEIGHT MUM<n>  = NO. OF PKG MUM<n> * UNIT WEIGHT/PKG (KG)
#   TOTAL CBM MUM<n>     = NO. OF PKG MUM<n> * CBM/PKG (KG)
#
# PKG QTY / UNIT WEIGHT/PKG (KG) / CBM/PKG (KG) are themselves sourced live
# from Product Master (packaging_quantity / packaging_gross_weight /
# packaging_unit_cbm) via the row's linked_record_id -- never typed in --
# so editing an item in Product Master changes these totals immediately,
# with no per-column config for an admin to get wrong.
_MUM_PKG_COUNT_RE_TEMPLATE = r"^no\.?\s*of\s*pkg\s*{label}\s*(\d+)$"
_MUM_TOTAL_WEIGHT_RE_TEMPLATE = r"^total\s*weight\s*{label}\s*(\d+)$"
_MUM_TOTAL_CBM_RE_TEMPLATE = r"^total\s*cbm\s*{label}\s*(\d+)$"


def _mum_derived_kind_and_group(name: str, *, label: str = "Mum") -> tuple[str, int] | None:
    """
    Return ("pkg_count" | "total_weight" | "total_cbm", mum_group_number) if
    ``name`` is one of the three fixed Mum-derived totals for that sheet's
    group label, else None.

    ``label`` defaults to "Mum" (the original, hardcoded behavior) but is
    always passed explicitly by real callers as the owning sheet's
    ``mum_group_label`` -- see PlanningSheet.mum_group_label -- so a
    sheet duplicated with a different label (e.g. "Chen") gets working
    "NO. OF PKG CHEN1" / "TOTAL WEIGHT CHEN1" / "TOTAL CBM CHEN1" totals
    without touching this function.
    """
    cleaned = name.strip()
    escaped_label = re.escape(label)
    for kind, template in (
        ("pkg_count", _MUM_PKG_COUNT_RE_TEMPLATE),
        ("total_weight", _MUM_TOTAL_WEIGHT_RE_TEMPLATE),
        ("total_cbm", _MUM_TOTAL_CBM_RE_TEMPLATE),
    ):
        match = re.match(template.format(label=escaped_label), cleaned, re.IGNORECASE)
        if match:
            return kind, int(match.group(1))
    return None


def is_fixed_mum_derived_column(name: str, *, label: str = "Mum") -> bool:
    """True for any column name matching one of the three fixed Mum-derived totals."""
    return _mum_derived_kind_and_group(name, label=label) is not None


def _format_date_dd_mm_yyyy(val: Any) -> str:
    if val is None:
        return ""
    if hasattr(val, "strftime"):
        return val.strftime("%d/%m/%Y")
    val_str = str(val).strip()
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})", val_str)
    if match:
        return f"{match.group(3)}/{match.group(2)}/{match.group(1)}"
    return val_str


def _relabel_mum_word(text: str, *, old_label: str, new_label: str) -> str:
    """
    Replace every occurrence of ``old_label`` in ``text`` with
    ``new_label``, preserving each occurrence's original case pattern
    (all-caps, capitalized, or lowercase) -- so duplicating "Mum branch"
    (label "Mum") into a "Chen" sheet turns "Mum 1" into "Chen 1",
    "Mum1 Remarks" into "Chen1 Remarks", and "NO. OF PKG MUM1" into
    "NO. OF PKG CHEN1" in one pass, without a separate rule per casing.

    Matched with lookaround (not ``\\b``) on either side, because ``\\b``
    doesn't fall between a letter and an immediately-following digit
    (both count as "word characters") -- with plain ``\\b`` this would
    correctly relabel "Mum 1" but silently miss "Mum1 Remarks" and
    "NO. OF PKG MUM1", which is exactly how the group's own column names
    are actually written. Still never matches "Mum" as a substring of
    some unrelated longer word, since a letter immediately before/after
    still blocks the match.
    """
    pattern = re.compile(rf"(?<![A-Za-z]){re.escape(old_label)}(?![A-Za-z])", re.IGNORECASE)

    def _replace(match: re.Match) -> str:
        found = match.group(0)
        if found.isupper():
            return new_label.upper()
        if found[0].isupper():
            return new_label[:1].upper() + new_label[1:]
        return new_label.lower()

    return pattern.sub(_replace, text)


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
        company_repository: Any = None,
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
        # Same pattern as user_role_repository above: typed Any / optional
        # rather than importing app.masters.company_list.repository.CompanyRepository
        # directly, since Planning and Masters are otherwise independent
        # modules. Used only by create_sheet, to validate that a new
        # sheet's chosen branch_id actually exists inside organization_id's
        # MasterCompany.branches list before linking the sheet to it.
        self.company_repository = company_repository
        # Request-scoped cache: sheet_id -> mum_group_label. Populated by
        # _get_mum_group_label, which many recursive per-cell/per-row calls
        # (compute_cell_display_value, its FORMULA branch, approval-date
        # grouping, status history) need on every call but which never
        # changes mid-request -- avoids turning "load a 50-row grid" into
        # 50+ extra sheet lookups just to find out which word ("Mum",
        # "Chen", ...) that sheet's groups use.
        self._mum_group_label_cache: dict[uuid.UUID, str] = {}

    async def _get_mum_group_label(self, sheet_id: uuid.UUID) -> str:
        """Return the sheet's configured Mum-group label (e.g. "Mum", "Chen"), request-cached."""
        cached = self._mum_group_label_cache.get(sheet_id)
        if cached is not None:
            return cached
        sheet = await self.sheet_repository.get_by_id(sheet_id)
        label = (sheet.mum_group_label if sheet is not None else None) or "Mum"
        self._mum_group_label_cache[sheet_id] = label
        return label

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

    async def create_sheet(
        self,
        *,
        name: str,
        organization_id: uuid.UUID,
        branch_id: str,
        mum_group_label: str = "Mum",
        description: str | None = None,
        user_id: uuid.UUID,
        username: str,
        auto_populate: bool = True,
    ) -> PlanningSheet:
        name = name.strip()
        if not name:
            raise BadRequestException("Sheet name is required.")
        mum_group_label = (mum_group_label or "Mum").strip() or "Mum"
        if await self.sheet_repository.get_by_name(name):
            raise ConflictException(f"A sheet named {name!r} already exists.")

        # Validate organization_id/branch_id against Product Master's real
        # organization/branch list -- every sheet must represent one
        # actual, existing branch, not just a name that sounds like one.
        branch_id = (branch_id or "").strip()
        if not branch_id:
            raise BadRequestException("A branch is required to create a sheet.")
        if self.company_repository is None:
            raise BadRequestException("Cannot validate the selected branch right now -- please try again.")
        organization = await self.company_repository.get_by_id(organization_id)
        if organization is None:
            raise BadRequestException("The selected organization does not exist.")
        branch_ids_on_org = {str(b.get("id")) for b in (organization.branches or []) if isinstance(b, dict)}
        if branch_id not in branch_ids_on_org:
            raise BadRequestException(
                f"{branch_id!r} is not a branch of {organization.name!r}. "
                "Pick a branch from that organization's own list."
            )

        position = await self.sheet_repository.next_position()
        sheet = await self.sheet_repository.create(
            name=name,
            description=description,
            position=position,
            created_by=user_id,
            organization_id=organization_id,
            branch_id=branch_id,
            item_source_type=PlanningColumnSourceType.LINKED_LOOKUP,
            item_source_module="product",
            item_source_field="product_name",
            item_auto_populate_enabled=True,
            item_auto_populate_limit=50,
            mum_group_label=mum_group_label,
        )
        await self._record_change(
            action=PlanningChangeAction.SHEET_CREATED,
            sheet_id=sheet.id,
            user_id=user_id,
            username=username,
            new_value=name,
            description=f"Created sheet '{name}'.",
        )
        # Populate base default columns in one single batch insert
        base_columns = [
            ("TEST(Y/N)", PlanningColumnDataType.TEXT, PlanningColumnSourceType.MANUAL, None, None),
            ("APPROVAL DATE", PlanningColumnDataType.TEXT, PlanningColumnSourceType.MANUAL, None, None),
            ("Supplier Name", PlanningColumnDataType.TEXT, PlanningColumnSourceType.LINKED_LOOKUP, "product", "supplier_name"),
            ("City", PlanningColumnDataType.TEXT, PlanningColumnSourceType.LINKED_LOOKUP, "product", "supplier_city"),
            ("PKG QTY", PlanningColumnDataType.NUMBER, PlanningColumnSourceType.LINKED_LOOKUP, "product", "packaging_quantity"),
            ("UNIT WEIGHT/PKG (KG)", PlanningColumnDataType.NUMBER, PlanningColumnSourceType.LINKED_LOOKUP, "product", "packaging_gross_weight"),
            ("CBM/PKG (KG)", PlanningColumnDataType.NUMBER, PlanningColumnSourceType.LINKED_LOOKUP, "product", "packaging_unit_cbm"),
        ]
        created_cols = [
            PlanningColumn(
                sheet_id=sheet.id,
                name=col_name,
                data_type=data_type,
                position=idx,
                created_by=user_id,
                source_type=source_type,
                source_module=src_mod,
                source_field=src_field,
                auto_populate_enabled=(source_type == PlanningColumnSourceType.LINKED_LOOKUP),
            )
            for idx, (col_name, data_type, source_type, src_mod, src_field) in enumerate(base_columns)
        ]
        self.column_repository.session.add_all(created_cols)
        await self.column_repository.session.flush()

        if auto_populate:
            try:
                await self.auto_populate_rows_from_item_source(
                    sheet.id,
                    limit=50,
                    user_id=user_id,
                    username=username,
                    organization_id=organization_id,
                    branch_id=branch_id,
                )
            except (BadRequestException, ConflictException):
                pass
        return sheet

    async def duplicate_sheet(
        self,
        source_sheet_id: uuid.UUID,
        *,
        name: str,
        mum_group_label: str,
        description: str | None,
        user_id: uuid.UUID,
        username: str,
    ) -> PlanningSheet:
        """
        Create a new sheet with the exact same column structure as an existing one.

        Copies every column from ``source_sheet_id`` (name, data type,
        position, and full source config -- LINKED_LOOKUP module/field,
        AGGREGATE fn/filters, or the fixed Mum-derived FORMULA) onto the
        new sheet, remapping the source sheet's Mum-group label to
        ``mum_group_label`` wherever it appears in a column name (see
        ``_relabel_mum_word``) -- e.g. duplicating "Mum branch" (label
        "Mum") as "Chennai branch" with ``mum_group_label="Chen"`` turns
        "Mum 1" / "Mum1 Remarks" / "NO. OF PKG MUM1" into "Chen 1" /
        "Chen1 Remarks" / "NO. OF PKG CHEN1", while "Supplier Name",
        "City", "PKG QTY", etc. are copied unchanged since they don't
        contain the group label at all.

        The new sheet's ITEM column always starts as the normal
        LINKED_LOOKUP-onto-Product-Name default (see ``create_sheet``)
        regardless of how the source sheet's ITEM was configured, and
        rows are never copied -- exactly like creating any other new
        sheet, it starts empty and gets populated from Product Master
        via the usual auto-populate/"Load More Products" flow. Copying
        rows too would mean the new branch starts out pointing at the
        same items as the source branch, which is virtually never what
        "start a new branch with the same column layout" means in
        practice.
        """
        source_sheet = await self.get_sheet_or_raise(source_sheet_id)
        name = name.strip()
        if not name:
            raise BadRequestException("Sheet name is required.")
        mum_group_label = mum_group_label.strip()
        if not mum_group_label:
            raise BadRequestException("Mum group label is required.")
        if await self.sheet_repository.get_by_name(name):
            raise ConflictException(f"A sheet named {name!r} already exists.")

        new_sheet = await self.create_sheet(
            name=name, description=description, user_id=user_id, username=username, auto_populate=True
        )
        # create_sheet() always defaults mum_group_label to "Mum" via the
        # ORM column default -- overwrite it with the requested one before
        # any columns are copied, since column-name remapping below and
        # every fixed-formula/approval-date feature on the new sheet reads
        # this field.
        new_sheet = await self.sheet_repository.update(new_sheet, mum_group_label=mum_group_label)

        source_columns = await self.column_repository.list_for_sheet(source_sheet_id)
        source_label = source_sheet.mum_group_label

        # Two passes: first create every column with its (possibly
        # relabeled) name/data_type/position, THEN configure sources --
        # a FORMULA column's fixed-Mum-derived branch and any ordinary
        # FORMULA column's expression can reference a sibling by name, so
        # every column must already exist (with its final name) before
        # any source config that might reference one is applied.
        created_columns: list[PlanningColumn] = []
        for source_column in source_columns:
            new_name = _relabel_mum_word(source_column.name, old_label=source_label, new_label=mum_group_label)
            created_columns.append(
                await self.column_repository.create(
                    sheet_id=new_sheet.id,
                    name=new_name,
                    data_type=source_column.data_type,
                    position=source_column.position,
                    created_by=user_id,
                    enable_status_color=source_column.enable_status_color,
                )
            )

        for source_column, new_column in zip(source_columns, created_columns):
            if source_column.source_type == PlanningColumnSourceType.MANUAL:
                continue  # already MANUAL by default -- nothing to configure
            formula_expression = source_column.formula_expression
            if formula_expression and source_label != mum_group_label:
                # Relabel any "Mum"/"[Mum N]" text inside a copied
                # FORMULA's expression too -- covers both the fixed
                # Mum-derived totals' stored label text and an ordinary
                # admin-written formula that happens to reference a
                # renamed Mum-series sibling column by name.
                formula_expression = _relabel_mum_word(
                    formula_expression, old_label=source_label, new_label=mum_group_label
                )
            try:
                await self.configure_column_source(
                    new_sheet.id,
                    new_column.id,
                    source_type=source_column.source_type,
                    source_module=source_column.source_module,
                    source_field=source_column.source_field,
                    source_aggregate_fn=source_column.source_aggregate_fn,
                    source_aggregate_filters=source_column.source_aggregate_filters,
                    formula_expression=formula_expression,
                    enable_description=source_column.enable_description,
                    auto_populate_enabled=False,  # never auto-populate/auto-link on the new (empty) sheet
                    auto_populate_limit=source_column.auto_populate_limit,
                    user_id=user_id,
                    username=username,
                )
            except (BadRequestException, FormulaError):
                # A column whose config can't carry over as-is (e.g. an
                # ordinary FORMULA referencing a column that didn't exist
                # yet at copy time) is left MANUAL rather than aborting
                # the whole duplication -- the admin can reconfigure it
                # from the column's own Configure Source modal afterward.
                pass

        await self._record_change(
            action=PlanningChangeAction.SHEET_CREATED,
            sheet_id=new_sheet.id,
            user_id=user_id,
            username=username,
            new_value=name,
            description=f"Duplicated sheet '{source_sheet.name}' as '{name}' "
            f"(group label '{source_label}' -> '{mum_group_label}').",
        )
        return await self.get_sheet_or_raise(new_sheet.id)

    async def rename_sheet(
        self, sheet_id: uuid.UUID, *, name: str, user_id: uuid.UUID, username: str, version: int | None = None
    ) -> PlanningSheet:
        """
        Rename a sheet's display name, enforcing Optimistic Concurrency
        Control if ``version`` is given.

        ``version`` added in the Phase 5 audit -- mirrors the identical
        fix applied to ``BuyerService.update`` in Phase 4:
        ``BaseRepository.update()`` already auto-detects a ``version``
        kwarg and treats it as ``expected_version`` (see its own
        docstring), so no repository change was needed here either, only
        threading the field through from the schema.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        name = name.strip()
        if not name:
            raise BadRequestException("Sheet name is required.")
        existing = await self.sheet_repository.get_by_name(name)
        if existing and existing.id != sheet_id:
            raise ConflictException(f"A sheet named {name!r} already exists.")
        old_name = sheet.name
        update_kwargs: dict[str, Any] = {"name": name}
        if version is not None:
            update_kwargs["version"] = version
        sheet = await self.sheet_repository.update(sheet, **update_kwargs)
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

    async def update_mum_group_label(
        self, sheet_id: uuid.UUID, *, mum_group_label: str, user_id: uuid.UUID, username: str
    ) -> PlanningSheet:
        """
        Correct an EXISTING sheet's group label in place (e.g. it was
        created as "Mum" by default and should really be "Test" or "MP"),
        relabeling every already-existing Mum-series column name and fixed
        formula to match -- WITHOUT touching any row/cell data.

        This is deliberately separate from ``rename_sheet``: the sheet's
        display name (its branch tab, e.g. "Test Branch1") and its
        ``mum_group_label`` (what "+Next <label>" columns are called, e.g.
        "Mum"/"MP"/"Chen") are two independent concepts by design -- a
        branch can be named anything while its group label stays
        whatever the person actually wants typed into headers like
        "NO. OF PKG MUM1". ``create_sheet`` only sets this label once, at
        creation time, from whatever the "+Sheet" form was given (see its
        own docstring); nothing before this method could correct it
        afterward for a sheet that ended up with the wrong one -- the
        closest existing tool, ``duplicate_sheet``, only relabels while
        copying to a brand NEW sheet, leaving the original untouched.

        Column names are relabeled via the exact same ``_relabel_mum_word``
        helper ``duplicate_sheet`` already relies on (turns "Mum 1" /
        "Mum1 Remarks" / "NO. OF PKG MUM1" into "Test 1" / "Test1 Remarks"
        / "NO. OF PKG TEST1"), so the two code paths can never drift into
        handling a label differently. Any ordinary FORMULA column's stored
        expression text that happens to reference a relabeled sibling by
        name is relabeled too. Row/cell data is completely untouched --
        this only ever renames columns and rewrites formula text, never
        creates/deletes/moves a row or overwrites a stored cell value.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        old_label = sheet.mum_group_label
        mum_group_label = mum_group_label.strip()
        if not mum_group_label:
            raise BadRequestException("Group label is required.")
        if mum_group_label == old_label:
            return sheet  # nothing to do -- avoid a no-op change-log entry

        columns = await self.column_repository.list_for_sheet(sheet_id)
        for column in columns:
            new_name = _relabel_mum_word(column.name, old_label=old_label, new_label=mum_group_label)
            updates: dict[str, Any] = {}
            if new_name != column.name:
                updates["name"] = new_name
            if column.formula_expression:
                new_expression = _relabel_mum_word(
                    column.formula_expression, old_label=old_label, new_label=mum_group_label
                )
                if new_expression != column.formula_expression:
                    updates["formula_expression"] = new_expression
            if updates:
                await self.column_repository.update(column, **updates)

        sheet = await self.sheet_repository.update(sheet, mum_group_label=mum_group_label)
        self._mum_group_label_cache[sheet_id] = mum_group_label
        await self._record_change(
            action=PlanningChangeAction.SHEET_RENAMED,
            sheet_id=sheet.id,
            user_id=user_id,
            username=username,
            old_value=old_label,
            new_value=mum_group_label,
            description=f"Changed sheet '{sheet.name}' group label from '{old_label}' to '{mum_group_label}'.",
        )
        # Relabeling can shift which columns count as "fixed Mum-derived
        # formulas" (see is_fixed_mum_derived_column) and rewrites ordinary
        # FORMULA columns' stored expression text -- every non-MANUAL
        # column's stored cell values need recomputing across every row,
        # or they'd keep showing results computed under the OLD label.
        refreshed_columns = await self.column_repository.list_for_sheet(sheet_id)
        for refreshed_column in refreshed_columns:
            await self.recompute_and_store_column_for_all_rows(sheet_id, refreshed_column)
        return sheet

    async def normalize_column_order(
        self, sheet_id: uuid.UUID, *, user_id: uuid.UUID, username: str
    ) -> list[PlanningColumn]:
        """
        Reorder an EXISTING sheet's columns into the correct, intended
        layout in one pass, without touching any row/cell data.

        Fixes sheets whose columns ended up in the wrong order because of
        a since-fixed frontend bug in "+Next <label>" (see
        ``handleCreateNextMumGroup`` in Planning.tsx): it computed where
        to insert a new group's "NO. OF PKG"/"TOTAL WEIGHT"/"TOTAL CBM"
        totals by re-searching the CURRENT column list for an existing
        CBM/PKG (KG) column, but on a sheet where that column had just
        been created moments earlier in the same action, the search could
        miss it and silently fall back to appending the 3 totals at the
        very END of the sheet -- after every other group's columns,
        including ones added later -- instead of right after CBM/PKG (KG)
        as intended. That bug is fixed going forward; this method repairs
        sheets that already got columns added while it was still present.

        The correct order, computed fresh from scratch every time (so
        it's safe to run repeatedly, and fixes ANY accumulated ordering
        drift, not just the one known bug):
            1. ITEM
            2. TEST(Y/N)
            3. APPROVAL DATE
            4. EVERY Mum group's main column + Remarks companion,
               ascending by group number (Group1, Group1 Remarks,
               Group2, Group2 Remarks, ...) -- ALL groups together here,
               before the shared block.
            5. Supplier Name / City / PKG QTY / UNIT WEIGHT/PKG (KG) /
               CBM/PKG (KG) -- these five are shared across every Mum
               group on the sheet (not repeated per group -- see
               ``create_sheet``'s base_columns), and sit exactly once,
               between every group's main/Remarks columns and every
               group's totals.
            6. EVERY Mum group's own 3 fixed totals (NO. OF PKG / TOTAL
               WEIGHT / TOTAL CBM), ascending by group number, ALL
               together here after the shared block -- not interleaved
               per-group between steps 4 and 5.
            7. Everything else (any other MANUAL/FORMULA/AGGREGATE
               column an admin added), in their existing relative order,
               appended at the end.
        Any group number missing its main "<Label> N" column (e.g. its
        Remarks or totals exist but the main column was deleted) is
        treated as not present -- those orphaned companions fall through
        to bucket 7 rather than being silently dropped.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        label = sheet.mum_group_label
        columns = await self.column_repository.list_for_sheet(sheet_id)

        item_col = next((c for c in columns if c.name.strip().lower() == "item"), None)
        test_col = next((c for c in columns if c.name.strip().lower() == "test(y/n)"), None)
        approval_col = next((c for c in columns if c.name.strip().lower() == "approval date"), None)
        supplier_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "supplier_name"), None
        )
        city_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "supplier_city"), None
        )
        pkg_qty_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "packaging_quantity"), None
        )
        unit_weight_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "packaging_gross_weight"),
            None,
        )
        cbm_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "packaging_unit_cbm"), None
        )
        shared_block = [c for c in (supplier_col, city_col, pkg_qty_col, unit_weight_col, cbm_col) if c is not None]

        # Group every Mum-series column by its number: {group_number: {"main": col, "remarks": col, "pkg_count": col, "total_weight": col, "total_cbm": col}}
        groups: dict[int, dict[str, PlanningColumn]] = {}
        remaining: list[PlanningColumn] = []  # everything NOT part of item/test/approval/shared-block/a Mum group
        already_placed_ids = {c.id for c in (item_col, test_col, approval_col, *shared_block) if c is not None}
        for column in columns:
            if column.id in already_placed_ids:
                continue
            main_num = mum_num_from_column_name(column.name, label=label)
            if main_num is not None:
                groups.setdefault(main_num, {})["main"] = column
                continue
            derived = _mum_derived_kind_and_group(column.name, label=label)
            if derived is not None:
                kind, group_num = derived
                groups.setdefault(group_num, {})[kind] = column
                continue
            remarks_match = re.match(rf"^{re.escape(label)}\s*(\d+)\s*remarks$", column.name.strip(), re.IGNORECASE)
            if remarks_match:
                groups.setdefault(int(remarks_match.group(1)), {})["remarks"] = column
                continue
            remaining.append(column)

        # A group with no main "<Label> N" column left (e.g. it was
        # deleted but a stray Remarks/total survived) doesn't get a slot
        # in the ordered layout below -- its leftover pieces fall through
        # to `remaining` instead of vanishing.
        ordered_group_numbers = sorted(n for n, g in groups.items() if "main" in g)
        for n in list(groups.keys()):
            if n not in ordered_group_numbers:
                remaining.extend(groups.pop(n).values())

        ordered: list[PlanningColumn] = [c for c in (item_col, test_col, approval_col) if c is not None]
        # Step 4: every group's main + Remarks, all together, ascending.
        for group_num in ordered_group_numbers:
            group = groups[group_num]
            if "main" in group:
                ordered.append(group["main"])
            if "remarks" in group:
                ordered.append(group["remarks"])
        # Step 5: the shared block, exactly once.
        ordered.extend(shared_block)
        # Step 6: every group's own 3 totals, all together, ascending.
        for group_num in ordered_group_numbers:
            group = groups[group_num]
            for kind in ("pkg_count", "total_weight", "total_cbm"):
                if kind in group:
                    ordered.append(group[kind])
        # Preserve `remaining`'s existing relative order (their own
        # position values, ascending) rather than the order they happened
        # to appear in the `columns` list traversal above.
        remaining.sort(key=lambda c: c.position)
        ordered.extend(remaining)

        changed = False
        for new_position, column in enumerate(ordered):
            if column.position != new_position:
                await self.column_repository.update(column, position=new_position)
                changed = True

        if changed:
            await self._record_change(
                action=PlanningChangeAction.COLUMN_MOVED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                description="Normalized column order (moved NO. OF PKG / TOTAL WEIGHT / TOTAL CBM columns to "
                "immediately follow CBM/PKG (KG) for each Mum group).",
            )
        return await self.column_repository.list_for_sheet(sheet_id)

    async def repair_fixed_mum_formulas(
        self, sheet_id: uuid.UUID, *, user_id: uuid.UUID, username: str
    ) -> list[PlanningColumn]:
        """
        Wire up NO. OF PKG / TOTAL WEIGHT / TOTAL CBM columns that were
        never actually turned into FORMULA columns, without touching any
        row/cell data or any other column.

        Fixes sheets affected by a since-fixed frontend bug in
        "+Next <label>" (``handleCreateNextMumGroup`` in Planning.tsx): it
        located these three just-created columns by searching for the
        literal string "MUM<n>" regardless of the sheet's actual group
        label, so on any sheet labeled anything other than "Mum" (CN, TN,
        etc.) the search never matched -- the columns were created with
        the right NAME (e.g. "NO. OF PKG CN1"), but were never actually
        switched from the default MANUAL type to FORMULA, so they never
        computed anything, showed no "ƒx" badge, and any value in them
        was whatever was last typed by hand rather than a live
        calculation. The backend's own read-time logic
        (``is_fixed_mum_derived_column`` / ``compute_cell_display_value``)
        was always correctly label-aware and unaffected -- this method
        only needed to fix the ONE-TIME column type/config, which is a
        write, not a read.

        For every Mum-series group already on the sheet, finds that
        group's own "NO. OF PKG <Label>N" / "TOTAL WEIGHT <Label>N" /
        "TOTAL CBM <Label>N" columns (by name, using the sheet's real
        ``mum_group_label`` -- never hardcoded) and, for any that isn't
        already ``source_type == FORMULA``, configures it via the exact
        same path (``configure_column_source``) "+Next <label>" itself
        uses. A column that's already correctly wired is left completely
        untouched -- safe to run repeatedly, and safe to run on a sheet
        where some groups are already fine and only others need fixing.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        label = sheet.mum_group_label
        columns = await self.column_repository.list_for_sheet(sheet_id)

        pkg_qty_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "packaging_quantity"), None
        )
        unit_weight_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "packaging_gross_weight"),
            None,
        )
        cbm_col = next(
            (c for c in columns if c.source_type == "linked_lookup" and c.source_field == "packaging_unit_cbm"), None
        )
        if pkg_qty_col is None or unit_weight_col is None or cbm_col is None:
            # Nothing to repair against -- the shared PKG QTY/Weight/CBM
            # columns don't exist yet on this sheet, so there's no
            # Product Master data for any fixed formula to divide/multiply
            # by in the first place.
            return columns

        # Every Mum-series main column still on the sheet, by group number.
        main_by_group: dict[int, PlanningColumn] = {}
        for c in columns:
            num = mum_num_from_column_name(c.name, label=label)
            if num is not None:
                main_by_group[num] = c

        repaired_ids: set[uuid.UUID] = set()
        for column in columns:
            derived = _mum_derived_kind_and_group(column.name, label=label)
            if derived is None:
                continue
            _, group_num = derived
            if column.source_type == PlanningColumnSourceType.FORMULA:
                continue  # already correctly wired -- untouched
            if group_num not in main_by_group:
                continue  # orphaned total with no main column left -- nothing sensible to wire it to
            # formula_expression is intentionally not built here: when the
            # column name matches a fixed Mum-derived total,
            # configure_column_source's own FORMULA branch (see
            # is_fixed_mum_derived_column) completely ignores whatever
            # text is passed and self-generates the correct fixed label
            # from the sheet's REAL group label -- so there is no
            # expression-string logic to duplicate or get wrong here.
            await self.configure_column_source(
                sheet_id,
                column.id,
                source_type=PlanningColumnSourceType.FORMULA,
                source_module=None,
                source_field=None,
                source_aggregate_fn=None,
                source_aggregate_filters=None,
                formula_expression=None,
                enable_description=False,
                auto_populate_enabled=False,
                auto_populate_limit=None,
                user_id=user_id,
                username=username,
            )
            repaired_ids.add(column.id)

        if repaired_ids:
            await self._record_change(
                action=PlanningChangeAction.COLUMN_MOVED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                description=f"Repaired {len(repaired_ids)} fixed Mum-derived total column(s) that were never "
                "wired to FORMULA (were stuck as plain MANUAL columns).",
            )
        return await self.column_repository.list_for_sheet(sheet_id)

    async def create_next_mum_group(
        self, sheet_id: uuid.UUID, *, user_id: uuid.UUID, username: str
    ) -> list[PlanningColumn]:
        """
        Create the next Mum/group column set in a single fast, atomic operation.

        Batch-creates:
          1. <Label> <N> (manual number column, enable_status_color=True)
          2. <Label><N> Remarks (manual text column)
          3. NO. OF PKG <LABEL><N> (fixed formula column)
          4. TOTAL WEIGHT <LABEL><N> (fixed formula column)
          5. TOTAL CBM <LABEL><N> (fixed formula column)

        Also ensures the prerequisite shared Product lookup block (Supplier Name, City,
        PKG QTY, UNIT WEIGHT/PKG (KG), CBM/PKG (KG)) exists on the sheet.
        Normalizes all column positions into the canonical layout in one database pass.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        mum_label = sheet.mum_group_label or "Mum"
        columns = await self.column_repository.list_for_sheet(sheet_id)

        # 1. Detect latest Mum group number
        max_mum = 0
        for col in columns:
            num = mum_num_from_column_name(col.name, label=mum_label)
            if num is not None and num > max_mum:
                max_mum = num
            derived = _mum_derived_kind_and_group(col.name, label=mum_label)
            if derived is not None and derived[1] > max_mum:
                max_mum = derived[1]
            remarks_match = re.match(rf"^{re.escape(mum_label)}\s*(\d+)\s*remarks$", col.name.strip(), re.IGNORECASE)
            if remarks_match and int(remarks_match.group(1)) > max_mum:
                max_mum = int(remarks_match.group(1))

        next_mum_num = max_mum + 1 if max_mum > 0 else 1

        new_columns_to_add: list[PlanningColumn] = []

        # 2. Check and ensure shared product lookup columns exist
        base_lookup_specs = [
            ("Supplier Name", PlanningColumnDataType.TEXT, "supplier_name"),
            ("City", PlanningColumnDataType.TEXT, "supplier_city"),
            ("PKG QTY", PlanningColumnDataType.NUMBER, "packaging_quantity"),
            ("UNIT WEIGHT/PKG (KG)", PlanningColumnDataType.NUMBER, "packaging_gross_weight"),
            ("CBM/PKG (KG)", PlanningColumnDataType.NUMBER, "packaging_unit_cbm"),
        ]

        all_cols_list = list(columns)
        for label_text, dtype, field in base_lookup_specs:
            existing = next(
                (
                    c
                    for c in all_cols_list
                    if c.source_type == PlanningColumnSourceType.LINKED_LOOKUP
                    and c.source_module == "product"
                    and c.source_field == field
                ),
                None,
            )
            if not existing:
                lookup_col = PlanningColumn(
                    sheet_id=sheet_id,
                    name=label_text,
                    data_type=dtype,
                    position=len(all_cols_list),
                    created_by=user_id,
                    source_type=PlanningColumnSourceType.LINKED_LOOKUP,
                    source_module="product",
                    source_field=field,
                    auto_populate_enabled=True,
                    is_locked=True,
                )
                new_columns_to_add.append(lookup_col)
                all_cols_list.append(lookup_col)

        # 3. Create the 5 companion columns for next_mum_num
        label_upper = mum_label.upper()
        mum_col_name = f"{mum_label} {next_mum_num}"
        remarks_col_name = f"{mum_label}{next_mum_num} Remarks"
        pkg_col_name = f"NO. OF PKG {label_upper}{next_mum_num}"
        weight_col_name = f"TOTAL WEIGHT {label_upper}{next_mum_num}"
        cbm_col_name = f"TOTAL CBM {label_upper}{next_mum_num}"

        col_main = PlanningColumn(
            sheet_id=sheet_id,
            name=mum_col_name,
            data_type=PlanningColumnDataType.NUMBER,
            position=len(all_cols_list),
            created_by=user_id,
            source_type=PlanningColumnSourceType.MANUAL,
            enable_status_color=True,
        )
        new_columns_to_add.append(col_main)
        all_cols_list.append(col_main)

        col_remarks = PlanningColumn(
            sheet_id=sheet_id,
            name=remarks_col_name,
            data_type=PlanningColumnDataType.TEXT,
            position=len(all_cols_list),
            created_by=user_id,
            source_type=PlanningColumnSourceType.MANUAL,
        )
        new_columns_to_add.append(col_remarks)
        all_cols_list.append(col_remarks)

        col_pkg = PlanningColumn(
            sheet_id=sheet_id,
            name=pkg_col_name,
            data_type=PlanningColumnDataType.NUMBER,
            position=len(all_cols_list),
            created_by=user_id,
            source_type=PlanningColumnSourceType.FORMULA,
            formula_expression=f"[{mum_col_name}] / [PKG QTY]  (fixed)",
            is_locked=True,
        )
        new_columns_to_add.append(col_pkg)
        all_cols_list.append(col_pkg)

        col_weight = PlanningColumn(
            sheet_id=sheet_id,
            name=weight_col_name,
            data_type=PlanningColumnDataType.NUMBER,
            position=len(all_cols_list),
            created_by=user_id,
            source_type=PlanningColumnSourceType.FORMULA,
            formula_expression=f"NO. OF PKG {label_upper}{next_mum_num} * [UNIT WEIGHT/PKG (KG)]  (fixed)",
            is_locked=True,
        )
        new_columns_to_add.append(col_weight)
        all_cols_list.append(col_weight)

        col_cbm = PlanningColumn(
            sheet_id=sheet_id,
            name=cbm_col_name,
            data_type=PlanningColumnDataType.NUMBER,
            position=len(all_cols_list),
            created_by=user_id,
            source_type=PlanningColumnSourceType.FORMULA,
            formula_expression=f"NO. OF PKG {label_upper}{next_mum_num} * [CBM/PKG (KG)]  (fixed)",
            is_locked=True,
        )
        new_columns_to_add.append(col_cbm)
        all_cols_list.append(col_cbm)

        # Add all new columns to session
        self.column_repository.session.add_all(new_columns_to_add)
        await self.column_repository.session.flush()

        # 4. Canonical column ordering
        item_col = next((c for c in all_cols_list if c.name.strip().lower() == "item"), None)
        test_col = next((c for c in all_cols_list if c.name.strip().lower() == "test(y/n)"), None)
        approval_col = next((c for c in all_cols_list if c.name.strip().lower() == "approval date"), None)
        supplier_col = next(
            (
                c
                for c in all_cols_list
                if c.source_type == PlanningColumnSourceType.LINKED_LOOKUP and c.source_field == "supplier_name"
            ),
            None,
        )
        city_col = next(
            (
                c
                for c in all_cols_list
                if c.source_type == PlanningColumnSourceType.LINKED_LOOKUP and c.source_field == "supplier_city"
            ),
            None,
        )
        pkg_qty_col = next(
            (
                c
                for c in all_cols_list
                if c.source_type == PlanningColumnSourceType.LINKED_LOOKUP and c.source_field == "packaging_quantity"
            ),
            None,
        )
        unit_weight_col = next(
            (
                c
                for c in all_cols_list
                if c.source_type == PlanningColumnSourceType.LINKED_LOOKUP and c.source_field == "packaging_gross_weight"
            ),
            None,
        )
        cbm_col = next(
            (
                c
                for c in all_cols_list
                if c.source_type == PlanningColumnSourceType.LINKED_LOOKUP and c.source_field == "packaging_unit_cbm"
            ),
            None,
        )
        shared_block = [c for c in (supplier_col, city_col, pkg_qty_col, unit_weight_col, cbm_col) if c is not None]

        groups: dict[int, dict[str, PlanningColumn]] = {}
        remaining: list[PlanningColumn] = []
        already_placed = {c for c in (item_col, test_col, approval_col, *shared_block) if c is not None}

        for column in all_cols_list:
            if column in already_placed:
                continue
            main_num = mum_num_from_column_name(column.name, label=mum_label)
            if main_num is not None:
                groups.setdefault(main_num, {})["main"] = column
                continue
            derived = _mum_derived_kind_and_group(column.name, label=mum_label)
            if derived is not None:
                kind, group_num = derived
                groups.setdefault(group_num, {})[kind] = column
                continue
            remarks_match = re.match(rf"^{re.escape(mum_label)}\s*(\d+)\s*remarks$", column.name.strip(), re.IGNORECASE)
            if remarks_match:
                groups.setdefault(int(remarks_match.group(1)), {})["remarks"] = column
                continue
            remaining.append(column)

        ordered_group_numbers = sorted(n for n, g in groups.items() if "main" in g)
        for n in list(groups.keys()):
            if n not in ordered_group_numbers:
                remaining.extend(groups.pop(n).values())

        ordered: list[PlanningColumn] = [c for c in (item_col, test_col, approval_col) if c is not None]
        for group_num in ordered_group_numbers:
            group = groups[group_num]
            if "main" in group:
                ordered.append(group["main"])
            if "remarks" in group:
                ordered.append(group["remarks"])
        ordered.extend(shared_block)
        for group_num in ordered_group_numbers:
            group = groups[group_num]
            for kind in ("pkg_count", "total_weight", "total_cbm"):
                if kind in group:
                    ordered.append(group[kind])
        remaining.sort(key=lambda c: c.position if c.position is not None else 9999)
        ordered.extend(remaining)

        for new_position, column in enumerate(ordered):
            if column.position != new_position:
                column.position = new_position

        await self.column_repository.session.flush()

        await self._record_change(
            action=PlanningChangeAction.COLUMN_ADDED,
            sheet_id=sheet_id,
            user_id=user_id,
            username=username,
            new_value=mum_col_name,
            description=f"Created {mum_label} {next_mum_num} column group ({mum_col_name}, {remarks_col_name}, and totals).",
        )

        return ordered

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

    async def get_grid(
        self,
        sheet_id: uuid.UUID,
        *,
        offset: int = 0,
        limit: int | None = 50,
        organization_id: uuid.UUID | None = None,
        search_column_filters: list[ColumnSearchFilter] | None = None,
    ) -> dict[str, Any]:
        """
        Fetch everything needed to render one page of one sheet's grid.

        ``limit=None`` fetches every row (the pre-pagination behavior,
        still used by internal callers that genuinely need the whole
        sheet). The default (50) is what the grid endpoint uses, matching
        Product Master's own default page size -- a sheet with hundreds
        of rows no longer pays for computing every row's cells on every
        single load; scrolling loads the next page automatically instead
        of the whole grid growing every time (see the frontend's
        IntersectionObserver-driven auto-load). Columns are never
        paginated (a sheet rarely has more than a few dozen), only rows.

        ``organization_id`` (optional) is a REQUEST-TIME override, used
        only as a fallback for sheets created before the branch-link
        feature existed (``sheet.organization_id is None``) -- see the
        "All Organizations" dropdown in the UI, which still works exactly
        as before for those legacy, unlinked sheets. For any sheet that
        HAS a real link (``sheet.organization_id``/``sheet.branch_id`` --
        every sheet created going forward always has one, see
        ``create_sheet``), that link is used automatically and always,
        regardless of what (if anything) the caller passes here: the
        whole point of linking a sheet to one specific branch is that
        filtering to that branch's products is automatic, not something
        that has to be re-selected via a dropdown on every visit.

        Nothing about organization/branch membership is stored on the
        row itself; it's read live off Product Master's
        ``organization_ids``/``branch_ids`` on every call, the same
        "never a stale copy" rule every other Shipment Planning lookup
        column follows (see
        ``PlanningRowRepository._linked_record_ids_for_organization``).

        ``search_column_filters`` (optional) is the server-side
        per-column search/filter (see
        ``PlanningRowRepository._apply_search_column_filters``) -- when
        given, this searches EVERY row on the sheet, not just whichever
        page is currently loaded in the browser. When a search is
        active, the auto-population-on-read behavior below is
        deliberately SKIPPED: a not-yet-materialized Product Master
        record has no computed cell values yet for a search to match
        against, so "does this search have more matches further down"
        can only ever mean "further down among rows that already
        exist" -- conjuring up new rows here would not help a search
        find anything it couldn't already find, and would do
        (potentially large amounts of) row-creation work for a read-only
        action. ``total_rows`` in that case is the true COUNT OF MATCHES
        across the whole sheet, not the source-module total.

        --- Auto-population on read (fixes "Showing 1-50 of 50" getting
        permanently stuck on a sheet whose ITEM is LINKED_LOOKUP onto a
        source module that actually has MORE than 50 records) ---

        For a LINKED_LOOKUP-onto-a-module ITEM column, ``total_rows`` is
        no longer "how many PlanningRow records happen to exist yet" --
        it's the TRUE count of matching source records (e.g. every live
        Product Master row, or every one belonging to this sheet's
        linked organization/branch). A brand-new sheet (which starts with
        only its first 50 rows materialized -- see ``create_sheet``) or
        one an admin previously capped via scrolling now reports the
        real total from the very first load, not just whatever happened
        to be linked already.

        To back that number with real rows once the person actually
        scrolls that far, this transparently creates whatever linked
        rows are still missing to satisfy ``offset + limit`` (capped at
        the true total) BEFORE reading the page -- the exact same
        row-creation path scrolling already used
        (``auto_populate_rows_from_item_source``), just triggered
        automatically instead of requiring a separate explicit click.
        Skips this entirely for MANUAL/other ITEM configs, where there is
        no source module to pull more rows from and the row count really
        is just however many rows exist.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)

        # A branch-linked sheet's own link always wins over whatever the
        # request happens to pass; only a legacy, never-linked sheet falls
        # back to the request-time organization_id (the old "All
        # Organizations" dropdown behavior).
        effective_organization_id = sheet.organization_id if sheet.organization_id is not None else organization_id
        effective_branch_id = sheet.branch_id if sheet.organization_id is not None else None

        has_active_search = bool(search_column_filters) and any(
            (f.text_query or "").strip() or f.selected_values for f in search_column_filters
        )

        # Automatically clean up any rows whose linked product master records were deleted
        if sheet.item_source_type == PlanningColumnSourceType.LINKED_LOOKUP and sheet.item_source_module == "product":
            await self.row_repository.cleanup_orphaned_product_rows(sheet_id)

        source_total: int | None = None
        if (
            not has_active_search
            and sheet.item_source_type == PlanningColumnSourceType.LINKED_LOOKUP
            and sheet.item_source_module == "product"
        ):
            all_matching_ids = await self.row_repository._all_product_ids_for_organization(
                effective_organization_id, branch_id=effective_branch_id
            )
            source_total = len(all_matching_ids)

            if limit is not None and source_total > 0:
                needed = min(offset + limit, source_total)
                currently_linked = await self.row_repository.count_for_sheet(
                    sheet_id, organization_id=effective_organization_id, branch_id=effective_branch_id
                )
                if currently_linked < needed:
                    # Pull enough of THIS organization's (and, if linked,
                    # this exact branch's) records to cover the requested
                    # page -- e.g. asking for offset=50, limit=50 with 31
                    # currently linked needs 69 more created.
                    await self.auto_populate_rows_from_item_source(
                        sheet_id,
                        limit=needed,
                        user_id=sheet.created_by,  # system-driven creation; attributed to the sheet's owner, mirrors seed-time auto-populate
                        username="system",
                        organization_id=effective_organization_id,
                        branch_id=effective_branch_id,
                    )

        columns = await self.column_repository.list_for_sheet(sheet_id)
        rows = await self.row_repository.list_page_for_sheet(
            sheet_id,
            offset=offset,
            limit=limit,
            organization_id=effective_organization_id,
            branch_id=effective_branch_id,
            search_column_filters=search_column_filters,
        )
        total_rows = (
            source_total
            if source_total is not None
            else await self.row_repository.count_for_sheet(
                sheet_id,
                organization_id=effective_organization_id,
                branch_id=effective_branch_id,
                search_column_filters=search_column_filters,
            )
        )
        return {"sheet": sheet, "columns": columns, "rows": rows, "total_rows": total_rows}

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
        sheet = await self.get_sheet_or_raise(sheet_id)
        name = name.strip()
        if not name:
            raise BadRequestException("Column name is required.")
        existing_columns = await self.column_repository.list_for_sheet(sheet_id)
        target_position = position if position is not None else len(existing_columns)
        target_position = max(0, min(target_position, len(existing_columns)))

        await self.column_repository.shift_positions_after(sheet_id, target_position, delta=1)
        is_mum_main_col = bool(
            re.match(rf"^{re.escape(sheet.mum_group_label)}\s*\d+$", name.strip(), re.IGNORECASE)
        )
        column = await self.column_repository.create(
            sheet_id=sheet_id,
            name=name,
            data_type=data_type,
            position=target_position,
            created_by=user_id,
            enable_status_color=is_mum_main_col,
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

    async def set_column_width(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, width_px: int | None
    ) -> PlanningColumn:
        """
        Set (or clear, if ``width_px`` is None) a column's server-persisted width.

        Deliberately does NOT call ``_record_change``/broadcast a change-log
        entry the way rename/move do -- dragging a column wider or narrower
        is a cosmetic display preference shared across users (see
        PlanningColumn.width_px's docstring for why this is server-side at
        all, unlike Hide/Freeze), not a data change worth surfacing in the
        sheet's audit trail. It still broadcasts a lightweight live-update
        event (see the route) so other users viewing the sheet see the new
        width without needing to reload.
        """
        column = await self._get_column_or_raise(sheet_id, column_id)
        return await self.column_repository.update(column, width_px=width_px)

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
        col_name_lower = column.name.strip().lower()
        if col_name_lower in ("item", "test(y/n)", "approval date") or "test (y/n)" in col_name_lower:
            raise BadRequestException(f"System column '{column.name}' cannot be deleted.")

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
        sheet = await self.get_sheet_or_raise(sheet_id)
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
            mum_derived = _mum_derived_kind_and_group(column.name, label=sheet.mum_group_label)
            if mum_derived is not None:
                # NO. OF PKG <LABEL><n> / TOTAL WEIGHT <LABEL><n> / TOTAL
                # CBM <LABEL><n> always use the one fixed backend formula
                # (see is_fixed_mum_derived_column) -- an admin cannot
                # type a different expression for these three, so
                # formula_expression is intentionally ignored here rather
                # than validated. The stored text is a fixed, human-
                # readable label only; compute_cell_display_value never
                # reads it back.
                kind, group_number = mum_derived
                label = sheet.mum_group_label
                fixed_labels = {
                    "pkg_count": f"[{label} {group_number}] / [PKG QTY]  (fixed)",
                    "total_weight": f"NO. OF PKG {label.upper()}{group_number} * [UNIT WEIGHT/PKG (KG)]  (fixed)",
                    "total_cbm": f"NO. OF PKG {label.upper()}{group_number} * [CBM/PKG (KG)]  (fixed)",
                }
                updated = await self.column_repository.update(
                    column,
                    source_type=source_type,
                    source_module=None,
                    source_field=None,
                    source_aggregate_fn=None,
                    source_aggregate_filters=None,
                    formula_expression=fixed_labels[kind],
                    is_locked=True,
                    enable_description=enable_description,
                    auto_populate_enabled=auto_populate_enabled,
                    auto_populate_limit=auto_populate_limit,
                    updated_by=user_id,
                )
            else:
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
        # The column's configuration just changed -- every existing row's
        # stored cell for THIS column reflects the OLD configuration, so
        # recompute all of them now rather than leaving them stale until
        # some unrelated future edit happens to touch each row. A no-op
        # for MANUAL (nothing to compute; recompute_and_store_column_for_all_rows
        # returns immediately for it).
        await self.recompute_and_store_column_for_all_rows(sheet_id, updated)
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
        and PERSISTED right now (see recompute_and_store_cell), not
        recomputed live on every future read. It stays correct if the
        Product master's data changes later because
        app.masters.products.service (and Suppliers'/Buyers' equivalents)
        calls recompute_and_store_cells_referencing_record after every
        successful save, refreshing every cell that points at the edited
        record -- not because this cell recomputes itself on read.
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

        # Persist the computed display value now -- see this method's
        # docstring for why reads no longer recompute it themselves.
        cell = await self.recompute_and_store_cell(column, row_id=row_id) or cell

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
            # Persist the computed display value now for this row's newly
            # (re)linked cell -- see recompute_and_store_cell.
            cell = await self.recompute_and_store_cell(column, row_id=row.id) or cell
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
        # ITEM's configuration just changed -- every existing row's stored
        # label reflects the OLD configuration (see
        # compute_row_item_display/PlanningRow.label), so refresh every
        # row now rather than leaving them stale.
        if updated.item_source_type != PlanningColumnSourceType.MANUAL:
            all_rows = await self.row_repository.list_for_sheet(sheet_id)
            for existing_row in all_rows:
                new_label = await self.compute_row_item_display(updated, existing_row)
                if new_label and new_label != existing_row.label:
                    await self.row_repository.update(existing_row, label=new_label)
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

        # This row's ITEM link just changed, which can affect every
        # sibling LINKED_LOOKUP column that has no explicit link of its
        # own (they fall back to the row's ITEM link -- see
        # compute_cell_display_value's row_linked_record_id docstring),
        # plus any FORMULA column referencing them -- recompute the whole
        # row's non-MANUAL cells together, not just one.
        await self.recompute_and_store_row(sheet_id, row_id)

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
        organization_id: uuid.UUID | None = None,
        branch_id: str | None = None,
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

        ``organization_id`` (optional) restricts which records are
        eligible to become new rows to those belonging to that
        organization -- only meaningful when the source module is
        ``"product"`` (the only module with an Organization concept right
        now; see ``app.masters.products.models.Product.organization_ids``).
        ``branch_id`` (optional, only meaningful together with
        ``organization_id``) further restricts to that organization's
        specific branch (``Product.branch_ids``) -- this is what a sheet
        LINKED to a branch (``PlanningSheet.branch_id``) always passes, per
        the "only pull products in this exact branch" requirement.
        Ignored for any other source module. This is what lets the
        Organization/branch filter (see ``PlanningService.get_grid``'s
        auto-population-on-read) create exactly the rows it needs when a
        filtered page runs past how many matching rows already exist,
        instead of only ever pulling from the front of the WHOLE
        (unfiltered) source list.
        """
        sheet = await self.get_sheet_or_raise(sheet_id)
        if sheet.item_source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            raise BadRequestException("The ITEM column is not configured as a linked-lookup column.")
        module = source_registry.get_source_module(sheet.item_source_module or "")
        if module is None:
            raise ConflictException("The ITEM column references an unregistered source module.")

        if module.key == "product":
            if organization_id is not None:
                record_ids = await self.row_repository._all_product_ids_for_organization(organization_id, branch_id=branch_id)
                record_ids = record_ids if limit is None else record_ids[:limit]
                repository = module.repository_factory(self.row_repository.session)
                records_by_id = await repository.get_by_ids(record_ids)
                # get_by_ids returns a dict (arbitrary key order in some drivers) --
                # re-sort back into record_ids' deterministic order, so
                # position/next_position assignment below stays stable.
                records = [records_by_id[rid] for rid in record_ids if rid in records_by_id]
            else:
                repository = module.repository_factory(self.row_repository.session)
                order_by = getattr(repository.model, "created_at", None)
                records = await repository.list(offset=0, limit=limit, order_by=order_by)
            # Batch attach supplier info in 1 fast query for all records
            await repository.attach_planning_supplier_info(records)
        else:
            repository = module.repository_factory(self.row_repository.session)
            order_by = getattr(repository.model, "created_at", None)
            records = await repository.list(offset=0, limit=limit, order_by=order_by)

        existing_rows = await self.row_repository.list_for_sheet(sheet_id)
        already_linked_ids = {r.linked_record_id for r in existing_rows if r.linked_record_id is not None}
        next_position = len(existing_rows)
        sibling_columns = await self.column_repository.list_for_sheet(sheet_id)

        created: list[PlanningRow] = []
        created_cells: list[PlanningCell] = []
        for record in records:
            if record.id in already_linked_ids:
                continue
            item_display = module.value_getter(record, sheet.item_source_field or "")
            label_val = str(item_display) if item_display is not None else f"{module.label} record"
            row_id = uuid.uuid4()
            row = PlanningRow(
                id=row_id,
                sheet_id=sheet_id,
                label=label_val,
                position=next_position,
                linked_record_id=record.id,
                created_by=user_id,
            )
            next_position += 1
            created.append(row)

            # Materialize cells for all matching LINKED_LOOKUP columns in batch
            for col in sibling_columns:
                if col.source_type == PlanningColumnSourceType.LINKED_LOOKUP and col.source_module == module.key:
                    val = module.value_getter(record, col.source_field or "")
                    if val is not None:
                        created_cells.append(
                            PlanningCell(
                                id=uuid.uuid4(),
                                row_id=row_id,
                                column_id=col.id,
                                value=str(val),
                            )
                        )

        if created:
            self.row_repository.session.add_all(created)
            if created_cells:
                self.cell_repository.session.add_all(created_cells)
            await self.row_repository.session.flush()

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

    async def compute_row_item_displays_for_all_rows(
        self, sheet: PlanningSheet, rows: list[PlanningRow]
    ) -> dict[uuid.UUID, str]:
        """
        Same result as calling ``compute_row_item_display`` once per row,
        but for LINKED_LOOKUP sheets (the default for every sheet now --
        see ``create_sheet``) it fetches every linked Product Master (or
        other module) record in ONE query instead of one ``get_by_id``
        per row.

        For a sheet auto-populated with 50 products, the per-row version
        made 50 separate database round trips just to resolve the ITEM
        column's display value -- the dominant cost behind "Loading
        grid..." never finishing. MANUAL and FORMULA sheets fall through
        to the ordinary per-row path unchanged (MANUAL has nothing to
        batch; FORMULA's cost is sibling-cell arithmetic, not a DB query
        per row, so batching wouldn't help there).
        """
        if sheet.item_source_type != PlanningColumnSourceType.LINKED_LOOKUP:
            return {row.id: await self.compute_row_item_display(sheet, row) for row in rows}

        module = source_registry.get_source_module(sheet.item_source_module or "")
        if module is None:
            return {row.id: row.label for row in rows}

        linked_ids = [row.linked_record_id for row in rows if row.linked_record_id is not None]
        repository = module.repository_factory(self.cell_repository.session)
        records_by_id = await repository.get_by_ids(linked_ids)

        result: dict[uuid.UUID, str] = {}
        for row in rows:
            record = records_by_id.get(row.linked_record_id) if row.linked_record_id is not None else None
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
            display = await self.compute_cell_display_value(
                pseudo_column, pseudo_cell, row_id=row.id, prefetched_record=record
            )
            result[row.id] = display if display else row.label
        return result

    async def compute_cell_display_value(
        self,
        column: PlanningColumn,
        cell: PlanningCell | None,
        *,
        row_id: uuid.UUID | None = None,
        prefetched_record: Any = _UNSET,
        prefetched_sibling_columns: Any = _UNSET,
        prefetched_row_cells: Any = _UNSET,
        row_linked_record_id: Any = _UNSET,
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

        ``prefetched_record`` lets a caller that already bulk-fetched
        every linked record for a whole sheet in one query (see
        ``compute_row_item_displays_for_all_rows``) hand the already-
        resolved record straight in, instead of this method doing its own
        ``get_by_id`` -- the difference between one query total for 50
        rows and 50 separate ones. Left as the sentinel ``_UNSET`` (not
        ``None``) for ordinary single-cell callers, since ``None`` is a
        legitimate "this row isn't linked to anything" value that must
        still fall through to the normal per-cell lookup path below it,
        not be mistaken for "already resolved, and it's nothing."

        ``row_linked_record_id`` is the FALLBACK record id for a
        LINKED_LOOKUP column whose own cell has never been explicitly
        linked (``cell.linked_record_id is None``) -- e.g. "Supplier
        Name" / "City" / "PKG QTY" columns pulling from the same Product
        Master record the row's ITEM cell already points to. Rows created
        via "Load More Products" (``auto_populate_rows_from_item_source``)
        only ever set ``PlanningRow.linked_record_id`` (ITEM's own link);
        nothing used to copy that down into every other LINKED_LOOKUP
        column's cell, so those columns stayed blank until someone
        manually ran "auto-link" on each one. Rather than relying on that
        one-time copy staying in sync forever, this falls back to the
        row's own link live, on every read -- consistent with this
        method's "never trust a stale value" philosophy for every other
        source type. Only used when the column's source_module matches
        the record actually being resolved; a column pulling from a
        totally different module (e.g. "supplier" while ITEM is "product")
        would resolve the wrong kind of record, so that case is guarded
        below and simply leaves the cell blank instead.
        """
        if column.source_type == PlanningColumnSourceType.MANUAL:
            return cell.value if cell else None

        if column.source_type == PlanningColumnSourceType.LINKED_LOOKUP:
            effective_record_id = cell.linked_record_id if cell is not None else None
            if effective_record_id is None and row_linked_record_id is not _UNSET and row_linked_record_id is not None:
                effective_record_id = row_linked_record_id
            if effective_record_id is None:
                return None
            module = source_registry.get_source_module(column.source_module or "")
            if module is None:
                return None
            if prefetched_record is not _UNSET:
                record = prefetched_record
            else:
                repository = module.repository_factory(self.cell_repository.session)
                record = await repository.get_by_id(effective_record_id)
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
            if effective_row_id is None:
                return None

            # Fixed formula, never the admin-typed formula_expression text --
            # see is_fixed_mum_derived_column's module-level docstring.
            mum_label = await self._get_mum_group_label(column.sheet_id)
            mum_derived = _mum_derived_kind_and_group(column.name, label=mum_label)
            if mum_derived is not None:
                return await self._compute_mum_derived_value(
                    column,
                    kind_and_group=mum_derived,
                    label=mum_label,
                    row_id=effective_row_id,
                    prefetched_sibling_columns=prefetched_sibling_columns,
                    prefetched_row_cells=prefetched_row_cells,
                    row_linked_record_id=row_linked_record_id,
                )

            if not column.formula_expression:
                return None

            if prefetched_row_cells is not _UNSET:
                cells_by_column_id = prefetched_row_cells
            else:
                row_cells = await self.cell_repository.list_for_rows([effective_row_id])
                cells_by_column_id = {rc.column_id: rc for rc in row_cells}

            if prefetched_sibling_columns is not _UNSET:
                sibling_columns = prefetched_sibling_columns
            else:
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
                raw_value = await self.compute_cell_display_value(
                    sibling,
                    sibling_cell,
                    row_id=effective_row_id,
                    prefetched_record=prefetched_record,
                    prefetched_sibling_columns=sibling_columns,
                    prefetched_row_cells=cells_by_column_id,
                    row_linked_record_id=row_linked_record_id,
                )
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

    async def recompute_and_store_cell(
        self,
        column: PlanningColumn,
        *,
        row_id: uuid.UUID,
        prefetched_sibling_columns: Any = _UNSET,
        prefetched_row_cells: Any = _UNSET,
        row_linked_record_id: Any = _UNSET,
    ) -> PlanningCell | None:
        """
        Recompute one (row, column) cell's effective value ONCE, right now,
        and persist it into ``PlanningCell.value`` -- the write-time half of
        the store-on-write architecture (see the module-level docstring
        note above ``compute_cell_display_value``). This is the ONLY place
        a LINKED_LOOKUP/AGGREGATE/FORMULA cell's stored value should ever be
        written; every other write path (a Product edit, a column
        reconfigured, a new row created, a sibling cell changing) calls
        this rather than recomputing inline, so there is exactly one
        function that ever decides "what does this cell currently equal".

        Grid reads (``PlanningService.get_grid`` / the grid route) then
        just read ``PlanningCell.value`` directly -- no computation on
        read, ever, which is the whole point: viewing/scrolling/opening a
        sheet costs one plain SELECT no matter how large it's grown,
        instead of recomputing every LINKED_LOOKUP/AGGREGATE/FORMULA cell
        fresh on every single page load.

        No-op (returns None, writes nothing) for MANUAL columns -- a
        MANUAL cell's value IS the stored value; there's nothing to
        "recompute" for it, and calling this on one would be a caller
        bug, not a legitimate state to silently handle.

        Returns the (created-or-updated) ``PlanningCell``, or ``None`` if
        the column is MANUAL or the computed value is ``None`` (an empty
        LINKED_LOOKUP/AGGREGATE/FORMULA cell has nothing to persist -- see
        the "clear existing cell" branch below for what happens to an
        existing stored value in that case).
        """
        if column.source_type == PlanningColumnSourceType.MANUAL:
            return None

        display_value = await self.compute_cell_display_value(
            column,
            None,
            row_id=row_id,
            prefetched_sibling_columns=prefetched_sibling_columns,
            prefetched_row_cells=prefetched_row_cells,
            row_linked_record_id=row_linked_record_id,
        )

        existing = await self.cell_repository.get_by_row_and_column(row_id, column.id)
        if display_value is None:
            # Nothing to store. If a cell row already exists (e.g. its
            # source record was deleted/unlinked since the last
            # computation), clear its stored value rather than leaving a
            # now-stale value sitting there forever -- a cell with no
            # computed value should read back as empty, not as whatever
            # it last successfully computed to.
            if existing is not None and existing.value is not None:
                await self.cell_repository.update(existing, value=None)
            return existing

        if existing is not None:
            await self.cell_repository.update(existing, value=display_value)
            return existing

        created = await self.cell_repository.create(row_id=row_id, column_id=column.id, value=display_value)
        return created

    async def recompute_and_store_row(
        self,
        sheet_id: uuid.UUID,
        row_id: uuid.UUID,
        *,
        columns: Any = _UNSET,
    ) -> None:
        """
        Recompute and persist EVERY non-MANUAL column's cell for one row.

        Used whenever a whole row's computed values need refreshing at
        once: a new row was just created/auto-populated (nothing has ever
        been computed for it yet), or the row's own linked-record changed
        (its ITEM link, or any per-column 🔗 link), which can affect
        several columns' values simultaneously, not just one.

        ``columns`` lets a caller that already fetched the sheet's column
        list (e.g. bulk row creation) pass it straight in instead of this
        method re-querying it per row.
        """
        sibling_columns = (
            prefetched_sibling_columns
            if (prefetched_sibling_columns := columns) is not _UNSET
            else await self.column_repository.list_for_sheet(sheet_id)
        )
        row_cells = await self.cell_repository.list_for_rows([row_id])
        cells_by_column_id = {rc.column_id: rc for rc in row_cells}
        row = await self.row_repository.get_by_id(row_id)
        row_linked_record_id = row.linked_record_id if row is not None else None

        for column in sibling_columns:
            if column.source_type == PlanningColumnSourceType.MANUAL:
                continue
            await self.recompute_and_store_cell(
                column,
                row_id=row_id,
                prefetched_sibling_columns=sibling_columns,
                prefetched_row_cells=cells_by_column_id,
                row_linked_record_id=row_linked_record_id,
            )

        # ITEM itself isn't a PlanningColumn (its config lives on the
        # sheet, its computed value is stored in PlanningRow.label, not a
        # PlanningCell -- see compute_row_item_display) but is
        # conceptually "one of this row's columns" the same as any other
        # non-MANUAL one, so it needs refreshing here too whenever the
        # rest of the row does.
        if row is not None:
            sheet = await self.get_sheet_or_raise(sheet_id)
            if sheet.item_source_type != PlanningColumnSourceType.MANUAL:
                new_label = await self.compute_row_item_display(sheet, row)
                if new_label and new_label != row.label:
                    await self.row_repository.update(row, label=new_label)

    async def recompute_and_store_column_for_all_rows(self, sheet_id: uuid.UUID, column: PlanningColumn) -> int:
        """
        Recompute and persist one column's cell across EVERY row on the sheet.

        Used when a column's own configuration just changed (source
        type/module/field/aggregate-fn/formula-expression edited, or the
        sheet's mum_group_label changed, which shifts which columns count
        as "fixed Mum-derived formulas") -- every existing row's cell for
        THIS column needs recomputing once, right now, since their stored
        values reflect the column's OLD configuration.

        Returns the number of rows whose cell was touched, purely for
        logging/change-log messages (see callers).
        """
        if column.source_type == PlanningColumnSourceType.MANUAL:
            return 0
        rows = await self.row_repository.list_for_sheet(sheet_id)
        sibling_columns = await self.column_repository.list_for_sheet(sheet_id)
        all_row_ids = [r.id for r in rows]
        all_cells = await self.cell_repository.list_for_rows(all_row_ids) if all_row_ids else []
        cells_by_row: dict[uuid.UUID, dict[uuid.UUID, PlanningCell]] = {}
        for c in all_cells:
            cells_by_row.setdefault(c.row_id, {})[c.column_id] = c

        touched = 0
        for row in rows:
            await self.recompute_and_store_cell(
                column,
                row_id=row.id,
                prefetched_sibling_columns=sibling_columns,
                prefetched_row_cells=cells_by_row.get(row.id, {}),
                row_linked_record_id=row.linked_record_id,
            )
            touched += 1
        return touched

    async def recompute_and_store_cells_referencing_record(
        self, source_module_key: str, record_id: uuid.UUID
    ) -> int:
        """
        Recompute every Planning cell that could be affected by a change
        to one record in ``source_module_key`` (e.g. a Product being
        edited) -- called by that module's own service after a
        successful save (see e.g. app.masters.products.service.update).

        Two independent things can go stale from one record edit:

        1. Every LINKED_LOOKUP cell (across every sheet) whose
           ``linked_record_id`` points at this exact record, OR whose row
           falls back to this record via its own ITEM link (see
           compute_cell_display_value's row_linked_record_id fallback) --
           these need recomputing because THIS SPECIFIC record's data
           changed.
        2. Every AGGREGATE cell (across every sheet) whose
           ``source_module`` is this module -- these need recomputing
           regardless of WHICH record in the module changed, since an
           aggregate summarizes across many records, not one linked one
           (confirmed as the intended behavior: aggregates recompute on
           ANY change to their source module, not just a targeted one).

        Any FORMULA column that references one of the above (directly or
        transitively) reads the now-freshly-stored sibling value the next
        time IT is recomputed -- this function does not need to chase
        that chain itself, because FORMULA cells are only ever recomputed
        by direct edits to a row (recompute_and_store_row) or a column
        reconfigure (recompute_and_store_column_for_all_rows), and those
        already recompute every non-MANUAL column on the affected row(s)
        together, formula included.

        Returns the number of cells touched, purely for logging.
        """
        touched = 0

        # If the source record was deleted or soft-deleted, clean up any planning rows and cells linked to it
        if source_module_key == "product":
            from app.masters.products.models import Product
            stmt_p = select(Product.id).where(Product.id == record_id, Product.deleted_at.is_(None))
            active_prod = (await self.row_repository.session.execute(stmt_p)).scalar_one_or_none()
            if active_prod is None:
                deleted_rows = await self.row_repository.soft_delete_linked_to_record(record_id)
                await self.cell_repository.unlink_or_clear_record(record_id)
                return deleted_rows

        # --- 1. LINKED_LOOKUP cells pointing at this exact record ---
        affected_cells = await self.cell_repository.list_linked_to_record(record_id)
        # Group by row so each row's sibling/row-link context is fetched once,
        # not once per affected cell (a row can have more than one
        # LINKED_LOOKUP column pointing at the same record, e.g. "Supplier
        # Name" and "City" both pulling from the same linked Product).
        rows_needing_recompute: dict[uuid.UUID, set[uuid.UUID]] = {}
        for cell in affected_cells:
            rows_needing_recompute.setdefault(cell.row_id, set()).add(cell.column_id)

        # Rows that fall back to this record via their OWN item link
        # (row.linked_record_id) rather than an explicit per-cell 🔗 --
        # e.g. "Supplier Name"/"City" columns that were never individually
        # linked, relying on the row's ITEM link instead (see
        # compute_cell_display_value's row_linked_record_id fallback).
        rows_linked_via_item = await self.row_repository.list_linked_to_record(record_id)
        for row in rows_linked_via_item:
            rows_needing_recompute.setdefault(row.id, set())

        if rows_needing_recompute:
            columns_by_sheet: dict[uuid.UUID, list[PlanningColumn]] = {}
            all_row_ids = list(rows_needing_recompute.keys())
            rows_by_id = await self.row_repository.get_by_ids(all_row_ids)
            all_cells_for_rows = await self.cell_repository.list_for_rows(all_row_ids)
            cells_by_row: dict[uuid.UUID, dict[uuid.UUID, PlanningCell]] = {}
            for c in all_cells_for_rows:
                cells_by_row.setdefault(c.row_id, {})[c.column_id] = c

            for row_id in all_row_ids:
                row = rows_by_id.get(row_id)
                if row is None:
                    continue
                if row.sheet_id not in columns_by_sheet:
                    columns_by_sheet[row.sheet_id] = await self.column_repository.list_for_sheet(row.sheet_id)
                sheet_columns = columns_by_sheet[row.sheet_id]
                for column in sheet_columns:
                    if column.source_type == PlanningColumnSourceType.MANUAL:
                        continue
                    # Only recompute columns that actually pull from this
                    # module -- a FORMULA column gets swept up too since it
                    # may reference an affected sibling; recomputing it is
                    # cheap and always safe (it just reads current stored
                    # sibling values), whereas skipping it risks leaving a
                    # formula's stored result referencing a now-stale
                    # sibling value.
                    if column.source_type in (
                        PlanningColumnSourceType.LINKED_LOOKUP,
                        PlanningColumnSourceType.AGGREGATE,
                    ) and column.source_module != source_module_key:
                        continue
                    await self.recompute_and_store_cell(
                        column,
                        row_id=row_id,
                        prefetched_sibling_columns=sheet_columns,
                        prefetched_row_cells=cells_by_row.get(row_id, {}),
                        row_linked_record_id=row.linked_record_id,
                    )
                    touched += 1

        # --- 2. AGGREGATE cells summarizing this module (any record) ---
        aggregate_columns = await self.column_repository.list_aggregate_columns_for_module(source_module_key)
        for column in aggregate_columns:
            rows = await self.row_repository.list_for_sheet(column.sheet_id)
            sibling_columns = await self.column_repository.list_for_sheet(column.sheet_id)
            for row in rows:
                await self.recompute_and_store_cell(
                    column,
                    row_id=row.id,
                    prefetched_sibling_columns=sibling_columns,
                    row_linked_record_id=row.linked_record_id,
                )
                touched += 1

        return touched

    async def _compute_mum_derived_value(
        self,
        column: PlanningColumn,
        *,
        kind_and_group: tuple[str, int],
        row_id: uuid.UUID,
        label: str = "Mum",
        prefetched_sibling_columns: Any = _UNSET,
        prefetched_row_cells: Any = _UNSET,
        row_linked_record_id: Any = _UNSET,
    ) -> str | None:
        """
        Compute one of the three fixed Mum-derived totals for one row.

        Fixed backend formula (see the module-level comment above
        ``is_fixed_mum_derived_column``), never the free-text
        ``formula_expression`` grammar:

            NO. OF PKG <LABEL><n>   = <Label> <n> / PKG QTY
            TOTAL WEIGHT <LABEL><n> = NO. OF PKG <LABEL><n> * UNIT WEIGHT/PKG (KG)
            TOTAL CBM <LABEL><n>    = NO. OF PKG <LABEL><n> * CBM/PKG (KG)

        ``label`` is the owning sheet's ``mum_group_label`` (default
        "Mum", matching the original hardcoded behavior) -- passed in by
        the caller (see ``compute_cell_display_value``) rather than
        looked up again here, since that caller already resolved it via
        the request-scoped ``_get_mum_group_label`` cache.

        PKG QTY / UNIT WEIGHT/PKG (KG) / CBM/PKG (KG) are read live off the
        row's linked Product Master record (via whichever sibling column
        on this sheet is configured as a LINKED_LOOKUP onto that Product
        field), so a later edit in Product Master is reflected immediately.
        Returns None (an empty cell, not an error) if the Mum column, the
        item's PKG QTY, or the item's per-package weight/CBM aren't
        available yet -- e.g. the item hasn't been linked to a Product
        Master record, or that product has no packaging data filled in.

        ``row_linked_record_id`` is forwarded to each sibling lookup below
        so PKG QTY / UNIT WEIGHT/PKG (KG) / CBM/PKG (KG) resolve even when
        THEIR OWN cell was never explicitly linked -- e.g. a row created
        via "Load More Products", which only sets the row's own ITEM
        link, not every sibling LINKED_LOOKUP column's cell. Without this,
        these three fixed totals silently stayed blank for every
        auto-populated row whose packaging columns hadn't separately been
        "auto-link"ed. See compute_cell_display_value's own docstring for
        the full explanation of this fallback.
        """
        kind, group_number = kind_and_group

        if prefetched_sibling_columns is not _UNSET:
            sibling_columns = prefetched_sibling_columns
        else:
            sibling_columns = await self.column_repository.list_for_sheet(column.sheet_id)

        if prefetched_row_cells is not _UNSET:
            cells_by_column_id = prefetched_row_cells
        else:
            row_cells = await self.cell_repository.list_for_rows([row_id])
            cells_by_column_id = {rc.column_id: rc for rc in row_cells}

        def _find_sibling(predicate) -> PlanningColumn | None:
            return next((c for c in sibling_columns if c.id != column.id and predicate(c)), None)

        mum_col = _find_sibling(
            lambda c: re.match(rf"^{re.escape(label)}\s*{group_number}$", c.name.strip(), re.IGNORECASE)
        )
        pkg_qty_col = _find_sibling(
            lambda c: c.source_type == PlanningColumnSourceType.LINKED_LOOKUP
            and c.source_module == "product"
            and c.source_field == "packaging_quantity"
        )
        unit_weight_col = _find_sibling(
            lambda c: c.source_type == PlanningColumnSourceType.LINKED_LOOKUP
            and c.source_module == "product"
            and c.source_field == "packaging_gross_weight"
        )
        cbm_col = _find_sibling(
            lambda c: c.source_type == PlanningColumnSourceType.LINKED_LOOKUP
            and c.source_module == "product"
            and c.source_field == "packaging_unit_cbm"
        )

        async def _numeric_value(sibling_column: PlanningColumn | None) -> float | None:
            if sibling_column is None:
                return None
            sibling_cell = cells_by_column_id.get(sibling_column.id)
            raw = await self.compute_cell_display_value(
                sibling_column,
                sibling_cell,
                row_id=row_id,
                prefetched_sibling_columns=sibling_columns,
                prefetched_row_cells=cells_by_column_id,
                row_linked_record_id=row_linked_record_id,
            )
            if raw is None:
                return None
            try:
                return float(raw)
            except ValueError:
                return None

        mum_value = await _numeric_value(mum_col)
        pkg_qty = await _numeric_value(pkg_qty_col)
        if mum_value is None or pkg_qty is None or pkg_qty == 0:
            return None
        pkg_count = mum_value / pkg_qty

        if kind == "pkg_count":
            return str(pkg_count)

        if kind == "total_weight":
            unit_weight = await _numeric_value(unit_weight_col)
            if unit_weight is None:
                return None
            return str(pkg_count * unit_weight)

        if kind == "total_cbm":
            cbm_per_pkg = await _numeric_value(cbm_col)
            if cbm_per_pkg is None:
                return None
            return str(pkg_count * cbm_per_pkg)

        return None

    async def get_row_formula_display_values(self, sheet_id: uuid.UUID, row_id: uuid.UUID) -> dict[str, Any]:
        """
        Recompute every FORMULA (and other non-manual) column's display value for one row.

        Used after a manual cell edit to tell every other connected tab
        what its dependent computed columns (e.g. "NO. OF PKG MUM1",
        "TOTAL WEIGHT MUM1", "TOTAL CBM MUM1") now show, without those
        tabs having to reload the whole grid -- keyed by column_id (as a
        string, JSON-friendly) so the frontend can patch each cell directly.

        The Approval Date column is the one deliberate exception: it's a
        MANUAL column (admins can still type over it), but when empty it
        auto-displays a Mum group's approval date (see
        ``get_mum_group_approval_dates_for_row``) -- typing into a Mum
        column changes that, so it must be included here too, or another
        viewer's Approval Date cell would only catch up on their next full
        reload instead of updating live like everything else.

        The return value also carries a special ``"__mum_approval_dates__"``
        key (a str(group_number) -> iso_date dict, never a real column id
        since column ids are UUIDs) so the frontend can redo its own
        hidden-aware "first visible Mum group" pick live, exactly as it
        does on initial grid load -- hiding is a per-user browser
        preference the backend has no concept of.
        """
        columns = await self.column_repository.list_for_sheet(sheet_id)
        row_cells = await self.cell_repository.list_for_rows([row_id])
        cells_by_column_id = {rc.column_id: rc for rc in row_cells}
        mum_approval_dates = await self.get_mum_group_approval_dates_for_row(sheet_id, row_id)
        result: dict[str, Any] = {"__mum_approval_dates__": {str(k): v for k, v in mum_approval_dates.items()}}
        # Needed so LINKED_LOOKUP columns whose OWN cell was never
        # explicitly linked (e.g. Supplier Name / City / PKG QTY on a row
        # created via "Load More Products") still resolve here too --
        # otherwise a live patch after editing one cell would show these
        # columns blank even though a full grid reload (which does have
        # this fallback -- see get_grid in routes.py) would show them
        # correctly, a confusing inconsistency between the two paths.
        row = await self._get_row_or_raise(sheet_id, row_id)
        sheet = await self.get_sheet_or_raise(sheet_id)
        mum_label = await self._get_mum_group_label(sheet_id)
        for column in columns:
            is_approval_date = column.name.strip().lower() == "approval date"
            is_remarks = bool(re.match(rf"^{re.escape(mum_label)}\s*\d+\s*remarks$", column.name.strip(), re.IGNORECASE))
            if column.source_type == PlanningColumnSourceType.MANUAL and not is_approval_date and not is_remarks:
                continue
            cell = cells_by_column_id.get(column.id)
            if is_remarks:
                result[str(column.id)] = cell.value if cell else None
            elif is_approval_date:
                result[str(column.id)] = (
                    mum_approval_dates[min(mum_approval_dates.keys())] if mum_approval_dates else None
                )
            else:
                # Always pass the row's real linked_record_id through, not
                # just when column.source_module matches the sheet's ITEM
                # module -- that guard makes sense for a LINKED_LOOKUP
                # column reading its OWN field, but a FORMULA column (e.g.
                # the fixed NO. OF PKG/TOTAL WEIGHT/TOTAL CBM totals) has
                # no source_module of its own at all, so
                # `column.source_module == sheet.item_source_module` is
                # always False for it -- that previously forced this to
                # None (a real "not linked" signal, not merely "omitted"),
                # which suppressed the SAME fallback for every LINKED_LOOKUP
                # column nested INSIDE the formula (PKG QTY, UNIT
                # WEIGHT/PKG, CBM/PKG) even when those columns display
                # correctly as their own top-level cells. The module match
                # is still correctly re-applied at the point each of those
                # nested lookups actually resolves a record (see
                # compute_cell_display_value's LINKED_LOOKUP branch), so
                # there's nothing to guard against here.
                result[str(column.id)] = await self.compute_cell_display_value(
                    column, cell, row_id=row_id, row_linked_record_id=row.linked_record_id
                )
        return result

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
        # AGGREGATE columns don't depend on this row's own data at all
        # (they show the same sheet-wide computed value for every row --
        # see compute_cell_display_value's AGGREGATE branch), so they can
        # be computed and stored immediately even though this brand-new
        # row has no linked record and no other cells yet. LINKED_LOOKUP
        # and FORMULA columns are left alone here -- they have nothing
        # meaningful to compute until the row is actually linked (see
        # link_row_to_item_source_record, which calls
        # recompute_and_store_row once that happens).
        sibling_columns = await self.column_repository.list_for_sheet(sheet_id)
        for sibling in sibling_columns:
            if sibling.source_type == PlanningColumnSourceType.AGGREGATE:
                await self.recompute_and_store_cell(sibling, row_id=row.id)
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
        user_permissions: "frozenset[str] | set[str] | None" = None,
    ) -> PlanningCell:
        row = await self._get_row_or_raise(sheet_id, row_id)
        column = await self._get_column_or_raise(sheet_id, column_id)
        if column.is_locked:
            raise ForbiddenException(f"Column '{column.name}' is locked and cannot be edited directly.")
        await self.check_column_role_lock(column_id, user_id=user_id)

        # Two of the sheet's default columns -- TEST(Y/N) and APPROVAL DATE --
        # each have their OWN, fully independent permission, with ZERO
        # dependency on the general planning.cell.edit. planning.cell.edit
        # itself means editing Mum group value cells and their Remarks cells,
        # or can act as an administrative super-permission for cell edits.
        col_name_check = column.name.strip().lower()
        is_test_yn_column = col_name_check.startswith("test") or ("test" in col_name_check and "y/n" in col_name_check)
        is_approval_date_column = col_name_check in ("approval date", "approval_date") or "approval" in col_name_check

        if user_permissions is not None:
            if is_test_yn_column:
                if "planning.textyn.edit" not in user_permissions and "planning.cell.edit" not in user_permissions:
                    raise ForbiddenException("This action requires the 'planning.textyn.edit' permission.")
            elif is_approval_date_column:
                if "planning.approvaldate.edit" not in user_permissions and "planning.cell.edit" not in user_permissions:
                    raise ForbiddenException("This action requires the 'planning.approvaldate.edit' permission.")
            else:
                # Every other column -- the Mum group value cells and their
                # Remarks cells -- is what planning.cell.edit actually means.
                # A user holding only planning.textyn.edit and/or
                # planning.approvaldate.edit must NOT be able to edit these.
                if "planning.cell.edit" not in user_permissions:
                    raise ForbiddenException("This action requires the 'planning.cell.edit' permission.")

        mum_label = await self._get_mum_group_label(sheet_id)

        # Remarks column check: only accept remarks if corresponding Mum main column has an active number (> 0)
        remarks_match = re.match(rf"^{re.escape(mum_label)}\s*(\d+)\s*remarks$", column.name.strip(), re.IGNORECASE)
        if remarks_match:
            group_num = int(remarks_match.group(1))
            sibling_columns = await self.column_repository.list_for_sheet(sheet_id)
            mum_main_col = next(
                (c for c in sibling_columns if mum_num_from_column_name(c.name, label=mum_label) == group_num),
                None,
            )
            if mum_main_col is not None:
                mum_main_cell = await self.cell_repository.get_by_row_and_column(row_id, mum_main_col.id)
                mum_has_number = False
                if mum_main_cell and mum_main_cell.value is not None and mum_main_cell.value.strip():
                    try:
                        num_val = float(mum_main_cell.value.strip())
                        if num_val > 0:
                            mum_has_number = True
                    except ValueError:
                        mum_has_number = True
                if not mum_has_number and value is not None and value.strip():
                    raise BadRequestException(
                        f"Cannot add remarks for '{column.name}' because '{mum_main_col.name}' has no active number."
                    )

        cell = await self.cell_repository.get_by_row_and_column(row_id, column_id)
        col_name_cleaned = column.name.strip().lower()
        if col_name_cleaned.startswith("test") and ("y/n" in col_name_cleaned or "(y/n)" in col_name_cleaned or col_name_cleaned == "test"):
            if value is not None and value.strip():
                val_upper = value.strip().upper()
                if val_upper not in ("Y", "N"):
                    raise BadRequestException("Only 'Y' or 'N' is allowed for TEST(Y/N).")
                value = val_upper

        is_mum_col = _is_pure_mum_column(column.name, label=mum_label)
        is_zero_or_blank = False
        if is_mum_col:
            if value is None or not value.strip():
                is_zero_or_blank = True
                value = None
            else:
                try:
                    if float(value.strip()) == 0:
                        is_zero_or_blank = True
                        value = None
                    else:
                        value = value.strip()
                except ValueError:
                    value = value.strip()

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
            # If written 0 or removed number: clear status, store blank, and clear any group remarks
            if is_mum_col:
                if is_zero_or_blank:
                    try:
                        cell = await self.set_cell_status(
                            sheet_id,
                            row_id,
                            column_id,
                            status_color=None,
                            custom_status_tag_id=None,
                            user_id=user_id,
                            username=username,
                            user_permissions=user_permissions,
                            check_permissions=False,
                        )
                    except (BadRequestException, ForbiddenException):
                        pass
                    mum_num = mum_num_from_column_name(column.name, label=mum_label)
                    sibling_columns = await self.column_repository.list_for_sheet(sheet_id)
                    if mum_num is not None:
                        remarks_col = next(
                            (
                                c
                                for c in sibling_columns
                                if re.match(rf"^{re.escape(mum_label)}\s*{mum_num}\s*remarks$", c.name.strip(), re.IGNORECASE)
                            ),
                            None,
                        )
                        if remarks_col:
                            remarks_cell = await self.cell_repository.get_by_row_and_column(row_id, remarks_col.id)
                            if remarks_cell and remarks_cell.value:
                                await self.cell_repository.update(remarks_cell, value=None, updated_by=user_id)

                    # Check if any Mum group has an active number remaining on this row; if none, clear auto Approval Date
                    remaining_mum_dates = await self.get_mum_group_approval_dates_for_row(sheet_id, row_id)
                    if not remaining_mum_dates:
                        approval_col = next((c for c in sibling_columns if c.name.strip().lower() == "approval date"), None)
                        if approval_col:
                            appr_cell = await self.cell_repository.get_by_row_and_column(row_id, approval_col.id)
                            if appr_cell and appr_cell.value:
                                await self.cell_repository.update(appr_cell, value=None, updated_by=user_id)
                elif value is not None and value.strip():
                    if not cell.status_color:
                        try:
                            cell = await self.set_cell_status(
                                sheet_id,
                                row_id,
                                column_id,
                                status_color=PlanningCellStatusColor.BLUE_ORDERED,
                                custom_status_tag_id=None,
                                user_id=user_id,
                                username=username,
                                user_permissions=user_permissions,
                                check_permissions=False,
                            )
                        except (BadRequestException, ForbiddenException):
                            pass
            elif value is not None and value.strip() and column.enable_status_color and not cell.status_color:
                if not is_test_yn_column and not is_approval_date_column:
                    try:
                        cell = await self.set_cell_status(
                            sheet_id,
                            row_id,
                            column_id,
                            status_color=PlanningCellStatusColor.BLUE_ORDERED,
                            custom_status_tag_id=None,
                            user_id=user_id,
                            username=username,
                            user_permissions=user_permissions,
                            check_permissions=False,
                        )
                    except (BadRequestException, ForbiddenException):
                        pass

            await self.recompute_and_store_row(sheet_id, row_id)
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
        user_permissions: "frozenset[str] | set[str] | None" = None,
        check_permissions: bool = True,
    ) -> PlanningCell:
        """
        Attach/clear a CRM-style status tag on any cell (admin's choice of cell, not restricted to a fixed column).

        ``status_color=None`` clears the tag. ``status_color=CUSTOM`` requires
        ``custom_status_tag_id`` pointing at an admin-defined
        :class:`~app.planning.models.PlanningStatusTag`.
        """
        row = await self._get_row_or_raise(sheet_id, row_id)
        column = await self._get_column_or_raise(sheet_id, column_id)

        if check_permissions:
            await self.check_column_role_lock(column_id, user_id=user_id)

            # Red and Green each have their OWN, fully independent permission,
            # with ZERO dependency on the general planning.cell.edit. Blue,
            # CUSTOM, and clearing a status (status_color=None) are what
            # planning.cell.edit governs -- only Red/Green were split into their
            # own standalone permissions.
            if user_permissions is not None:
                if status_color == PlanningCellStatusColor.RED_REQUIREMENT:
                    if "planning.colorstatusred.edit" not in user_permissions:
                        raise ForbiddenException("This action requires the 'planning.colorstatusred.edit' permission.")
                elif status_color == PlanningCellStatusColor.GREEN_PURCHASED:
                    if "planning.colorstatusgreen.edit" not in user_permissions:
                        raise ForbiddenException("This action requires the 'planning.colorstatusgreen.edit' permission.")
                else:
                    # Blue, CUSTOM, or clearing the tag entirely (status_color=None).
                    if "planning.cell.edit" not in user_permissions:
                        raise ForbiddenException("This action requires the 'planning.cell.edit' permission.")

        mum_label = await self._get_mum_group_label(sheet_id)
        is_mum_col = _is_pure_mum_column(column.name, label=mum_label)
        if is_mum_col and not column.enable_status_color:
            column = await self.column_repository.update(column, enable_status_color=True, updated_by=user_id)

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

        if status_color is not None:
            has_active_value = False
            if cell is not None and cell.value is not None and cell.value.strip():
                val_str = cell.value.strip()
                if val_str != "0":
                    try:
                        num_val = float(val_str)
                        if num_val > 0:
                            has_active_value = True
                    except ValueError:
                        has_active_value = True
            if not has_active_value:
                raise BadRequestException(
                    f"Cannot set a status color for '{column.name}' because this cell has no quantity or value entered."
                )

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
        await self.check_column_role_lock(column_id, user_id=user_id)

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

    async def set_column_description(
        self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, description: str | None, user_id: uuid.UUID, username: str
    ) -> PlanningColumn:
        """
        Set or clear a column's single header-level free-text note.

        Unlike ``set_cell_description``, there is exactly one of these per
        column (shown via the pencil button on the column header), not
        one per row -- the whole column shares a single note.
        """
        column = await self._get_column_or_raise(sheet_id, column_id)
        mum_label = await self._get_mum_group_label(sheet_id)
        if not _is_pure_mum_column(column.name, label=mum_label):
            raise BadRequestException(f"Column descriptions are only allowed on {mum_label} N columns.")
        old_description = column.description

        column = await self.column_repository.update(column, description=description, updated_by=user_id)

        if old_description != description:
            await self._record_change(
                action=PlanningChangeAction.CELL_DESCRIPTION_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                column_id=column_id,
                old_value=old_description,
                new_value=description,
                description=f"Updated description on column '{column.name}'.",
            )
        return column

    async def set_item_column_description(
        self, sheet_id: uuid.UUID, *, description: str | None, user_id: uuid.UUID, username: str
    ) -> PlanningSheet:
        """Set or clear the sheet's built-in ITEM column header-level note. Mirrors set_column_description."""
        sheet = await self.get_sheet_or_raise(sheet_id)
        old_description = sheet.item_description

        sheet = await self.sheet_repository.update(sheet, item_description=description)

        if old_description != description:
            await self._record_change(
                action=PlanningChangeAction.CELL_DESCRIPTION_CHANGED,
                sheet_id=sheet_id,
                user_id=user_id,
                username=username,
                old_value=old_description,
                new_value=description,
                description="Updated description on the ITEM column.",
            )
        return sheet

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

        A chronological list of every status-color change on that row's Mum-series columns
        (e.g. "Mum 1", "Mum 2", "Mum 3", ...), showing column, old/new color, time, and user.
        Includes a fallback for existing cells with Mum values that were created prior to status logging.
        """
        await self._get_row_or_raise(sheet_id, row_id)
        columns = await self.column_repository.list_for_sheet(sheet_id)
        mum_label = await self._get_mum_group_label(sheet_id)
        label_lower = mum_label.strip().lower()
        mum_column_names = {
            c.id: c.name for c in columns
            if c.name.strip().lower().startswith(label_lower)
            and not c.name.strip().lower().startswith(("no. of pkg", "total"))
        }
        if not mum_column_names:
            return []

        entries = await self.change_log_repository.list_for_row(row_id, limit=limit)
        results = []
        recorded_col_ids = set()

        for entry in entries:
            if entry.column_id in mum_column_names:
                recorded_col_ids.add(entry.column_id)
                if entry.action == PlanningChangeAction.CELL_STATUS_CHANGED:
                    results.append(
                        {
                            "column_id": str(entry.column_id),
                            "column_name": mum_column_names[entry.column_id],
                            "entry_type": "status",
                            "old_status": entry.old_value,
                            "new_status": entry.new_value,
                            "old_value": None,
                            "new_value": None,
                            "changed_at": entry.created_at.isoformat() if hasattr(entry.created_at, "isoformat") else str(entry.created_at),
                            "changed_by_username": entry.changed_by_username_snapshot,
                        }
                    )
                elif entry.action == PlanningChangeAction.CELL_VALUE_CHANGED:
                    results.append(
                        {
                            "column_id": str(entry.column_id),
                            "column_name": mum_column_names[entry.column_id],
                            "entry_type": "value",
                            "old_status": None,
                            "new_status": None,
                            "old_value": entry.old_value,
                            "new_value": entry.new_value,
                            "changed_at": entry.created_at.isoformat() if hasattr(entry.created_at, "isoformat") else str(entry.created_at),
                            "changed_by_username": entry.changed_by_username_snapshot,
                        }
                    )

        # Fallback for existing cells that have Mum values (e.g. 9, 7, 5) but no change_log status entry yet
        for col_id, col_name in mum_column_names.items():
            if col_id not in recorded_col_ids:
                cell = await self.cell_repository.get_by_row_and_column(row_id, col_id)
                if cell and cell.value and cell.value.strip():
                    status = cell.status_color.value if cell.status_color else PlanningCellStatusColor.BLUE_ORDERED.value
                    ts = cell.updated_at or cell.created_at
                    ts_str = ts.isoformat() if hasattr(ts, "isoformat") else str(ts)
                    results.append(
                        {
                            "column_id": str(col_id),
                            "column_name": col_name,
                            "entry_type": "value",
                            "old_status": None,
                            "new_status": None,
                            "old_value": None,
                            "new_value": cell.value,
                            "changed_at": ts_str,
                            "changed_by_username": "system",
                        }
                    )
                    results.append(
                        {
                            "column_id": str(col_id),
                            "column_name": col_name,
                            "entry_type": "status",
                            "old_status": None,
                            "new_status": status,
                            "old_value": None,
                            "new_value": None,
                            "changed_at": ts_str,
                            "changed_by_username": "system",
                        }
                    )

        results.sort(key=lambda x: x["changed_at"], reverse=True)
        return results

    async def get_mum_group_approval_dates_for_all_rows(
        self, sheet_id: uuid.UUID, *, columns: list[PlanningColumn], rows: list[PlanningRow]
    ) -> dict[uuid.UUID, dict[int, str]]:
        """
        Same result as calling ``get_mum_group_approval_dates_for_row`` once
        per row, but computed for every row on the sheet in ONE pass --
        one column list and one change-log fetch total, not one of each
        per row.

        This is a required fast-path, not an optional micro-optimization:
        ``get_grid`` calls the per-row version for every row in the sheet,
        and that method itself re-fetches every column plus up to 200
        change-log entries from the database on every single call. For a
        sheet auto-populated with 50 products (see the ITEM
        auto-populate default), that was 50+ *sequential* round trips
        just for this one piece of the response, before any of the other
        per-cell computation even started -- the exact cause of "Loading
        grid..." never finishing. Callers pass in the already-loaded
        ``columns``/``rows`` (get_grid loads both once already) so this
        adds only one additional query for the whole sheet, not per row.
        """
        mum_label = await self._get_mum_group_label(sheet_id)
        mum_cols: list[tuple[int, uuid.UUID]] = []
        for c in columns:
            num = mum_num_from_column_name(c.name, label=mum_label)
            if num is not None:
                mum_cols.append((num, c.id))

        if not mum_cols:
            return {row.id: {} for row in rows}

        # One change-log fetch for the WHOLE sheet (not per row): every
        # entry already carries its own row_id, so a single pass below
        # buckets them by (row_id, column_id) instead of asking the
        # database separately for each row's slice of the same table.
        # limit=200 per row, scaled by row count, is a generous ceiling --
        # status-color changes on Mum columns are infrequent relative to
        # other planning activity, so this rarely gets close to that ceiling
        # in practice even for a sheet with many rows.
        entries = await self.change_log_repository.list_for_sheet(sheet_id, limit=max(200, len(rows) * 20))
        blue_by_row_and_col: dict[tuple[uuid.UUID, uuid.UUID], Any] = {}
        for entry in entries:
            if (
                entry.action == PlanningChangeAction.CELL_STATUS_CHANGED
                and entry.new_value == PlanningCellStatusColor.BLUE_ORDERED.value
                and entry.row_id is not None
                and entry.column_id is not None
            ):
                key = (entry.row_id, entry.column_id)
                if key not in blue_by_row_and_col or entry.created_at < blue_by_row_and_col[key]:
                    blue_by_row_and_col[key] = entry.created_at

        result: dict[uuid.UUID, dict[int, str]] = {}
        for row in rows:
            cells_by_column_id = {cell.column_id: cell for cell in row.cells}
            row_result: dict[int, str] = {}
            for num, col_id in mum_cols:
                cell = cells_by_column_id.get(col_id)
                if not cell or not cell.value or not cell.value.strip():
                    continue
                try:
                    if float(cell.value.strip()) <= 0:
                        continue
                except ValueError:
                    pass

                blue_at = blue_by_row_and_col.get((row.id, col_id))
                if blue_at is not None:
                    row_result[num] = _format_date_dd_mm_yyyy(blue_at)
                    continue
                ts = cell.updated_at or cell.created_at
                if ts:
                    row_result[num] = _format_date_dd_mm_yyyy(ts)
            result[row.id] = row_result
        return result

    async def get_mum_group_approval_dates_for_row(self, sheet_id: uuid.UUID, row_id: uuid.UUID) -> dict[int, str]:
        """
        Return {mum_group_number: iso_date_string} for every Mum group on
        this row that has an active number (> 0) -- one entry per
        group number, keyed by the same number used everywhere else
        (frontend's ``mumGroupNumber``, the eye popover, delete/hide
        cascade).
        """
        columns = await self.column_repository.list_for_sheet(sheet_id)
        mum_label = await self._get_mum_group_label(sheet_id)

        mum_cols: list[tuple[int, uuid.UUID]] = []
        for c in columns:
            num = mum_num_from_column_name(c.name, label=mum_label)
            if num is not None:
                mum_cols.append((num, c.id))

        if not mum_cols:
            return {}

        entries = await self.change_log_repository.list_for_row(row_id, limit=200)
        blue_by_col: dict[uuid.UUID, Any] = {}
        for entry in entries:
            if (
                entry.action == PlanningChangeAction.CELL_STATUS_CHANGED
                and entry.new_value == PlanningCellStatusColor.BLUE_ORDERED.value
            ):
                if entry.column_id not in blue_by_col or entry.created_at < blue_by_col[entry.column_id]:
                    blue_by_col[entry.column_id] = entry.created_at

        result: dict[int, str] = {}
        for num, col_id in mum_cols:
            cell = await self.cell_repository.get_by_row_and_column(row_id, col_id)
            if not cell or not cell.value or not cell.value.strip():
                continue
            try:
                if float(cell.value.strip()) <= 0:
                    continue
            except ValueError:
                pass

            if col_id in blue_by_col:
                changed_at = blue_by_col[col_id]
                result[num] = _format_date_dd_mm_yyyy(changed_at)
                continue
            ts = cell.updated_at or cell.created_at
            if ts:
                result[num] = _format_date_dd_mm_yyyy(ts)
        return result

    async def get_latest_mum_approval_date_for_row(self, sheet_id: uuid.UUID, row_id: uuid.UUID) -> str | None:
        """
        Return an ISO date string for the approval date of the row.

        Shows the date when the FIRST active (non-deleted) Mum-series column
        (Mum 1, or Mum 2 if Mum 1 was deleted) turned blue (BLUE_ORDERED) or has a value.

        This is a thin convenience wrapper around
        ``get_mum_group_approval_dates_for_row`` for callers that don't
        need per-group breakdown (e.g. the initial grid load, before the
        frontend has hidden-column state to apply) -- it has no concept of
        hidden columns, so a viewer with Mum 1 hidden still briefly sees
        Mum 1's date here until the frontend's own hidden-aware
        recalculation (using the per-group dict) overrides it.
        """
        dates = await self.get_mum_group_approval_dates_for_row(sheet_id, row_id)
        if not dates:
            return None
        first_group_num = min(dates.keys())
        return dates[first_group_num]

    async def get_column_history(self, sheet_id: uuid.UUID, column_id: uuid.UUID, *, limit: int = 100):
        await self._get_column_or_raise(sheet_id, column_id)
        return await self.change_log_repository.list_for_column(column_id, limit=limit)