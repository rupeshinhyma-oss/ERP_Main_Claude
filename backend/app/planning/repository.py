"""
Shipment Planning Repositories.

One repository class per table, each extending :class:`BaseRepository` for
the standard CRUD it provides, plus grid-specific query methods (fetching
a whole sheet's rows/columns/cells in one shot, re-sequencing positions on
insert/delete/move, and reading recent change-log history).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import and_, exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.base_repository import BaseRepository
from app.planning.models import (
    PlanningCell,
    PlanningChangeLog,
    PlanningColumn,
    PlanningColumnRoleLock,
    PlanningColumnSourceType,
    PlanningRow,
    PlanningSheet,
    PlanningStatusTag,
)


class PlanningSheetRepository(BaseRepository[PlanningSheet]):
    """Repository for ``planning_sheets`` (branch tabs)."""

    searchable_fields = ("name",)
    sortable_fields = ("name", "position", "created_at")
    filterable_fields = ()

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningSheet)

    async def get_by_name(self, name: str) -> PlanningSheet | None:
        stmt = select(PlanningSheet).where(PlanningSheet.name == name, PlanningSheet.deleted_at.is_(None))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_active(self) -> list[PlanningSheet]:
        stmt = (
            select(PlanningSheet)
            .where(PlanningSheet.deleted_at.is_(None))
            .order_by(PlanningSheet.position, PlanningSheet.created_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def next_position(self) -> int:
        sheets = await self.list_active()
        return (max((s.position for s in sheets), default=-1)) + 1


@dataclass
class ColumnSearchFilter:
    """
    One column's search/filter condition, server-side equivalent of the
    frontend's per-column Excel-style filter state (see
    `activeColumnFilters` in Planning.tsx).

    ``column_id`` is ``None`` for the ITEM column (which has no
    ``PlanningColumn``/``PlanningCell`` of its own -- see
    ``_apply_search_column_filters`` for how that special case is
    matched against ``PlanningRow.label`` instead).
    """

    column_id: uuid.UUID | None
    text_query: str | None = None
    selected_values: list[str] | None = None


class PlanningRowRepository(BaseRepository[PlanningRow]):
    """Repository for ``planning_rows`` (item lines within a sheet)."""

    searchable_fields = ("label",)
    sortable_fields = ("label", "position", "created_at")
    filterable_fields = ("sheet_id",)

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningRow)

    async def list_for_sheet(self, sheet_id: uuid.UUID) -> list[PlanningRow]:
        stmt = (
            select(PlanningRow)
            .where(PlanningRow.sheet_id == sheet_id, PlanningRow.deleted_at.is_(None))
            .options(selectinload(PlanningRow.cells))
            .order_by(PlanningRow.position, PlanningRow.created_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_linked_to_record(self, record_id: uuid.UUID) -> list[PlanningRow]:
        """
        Every row (across every sheet) whose own ITEM link
        (``linked_record_id``) points at ``record_id`` -- distinct from a
        per-cell 🔗 link (see PlanningCellRepository.list_linked_to_record
        for that case). A LINKED_LOOKUP column with no explicit link of
        its own falls back to the row's ITEM link (see
        compute_cell_display_value's row_linked_record_id docstring), so
        these rows also need their non-MANUAL cells recomputed when
        ``record_id`` changes, even though no PlanningCell row explicitly
        names it.
        """
        stmt = select(PlanningRow).where(
            PlanningRow.linked_record_id == record_id, PlanningRow.deleted_at.is_(None)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def soft_delete_linked_to_record(self, record_id: uuid.UUID) -> int:
        """Soft-delete all PlanningRow records whose linked_record_id equals record_id."""
        from datetime import datetime, timezone
        stmt = (
            update(PlanningRow)
            .where(PlanningRow.linked_record_id == record_id, PlanningRow.deleted_at.is_(None))
            .values(deleted_at=datetime.now(timezone.utc))
        )
        result = await self.session.execute(stmt)
        await self.session.flush()
        return result.rowcount

    async def cleanup_orphaned_product_rows(self, sheet_id: uuid.UUID | None = None) -> int:
        """
        Soft-delete any planning rows whose linked_record_id points to a
        product that does not exist or has deleted_at IS NOT NULL.
        """
        from datetime import datetime, timezone
        from app.masters.products.models import Product

        active_product_ids = select(Product.id).where(Product.deleted_at.is_(None))
        conditions = [
            PlanningRow.deleted_at.is_(None),
            PlanningRow.linked_record_id.is_not(None),
            PlanningRow.linked_record_id.not_in(active_product_ids),
        ]
        if sheet_id is not None:
            conditions.append(PlanningRow.sheet_id == sheet_id)
        stmt = (
            update(PlanningRow)
            .where(*conditions)
            .values(deleted_at=datetime.now(timezone.utc))
        )
        result = await self.session.execute(stmt)
        await self.session.flush()
        return result.rowcount

    async def _linked_record_ids_for_organization(
        self, organization_id: uuid.UUID, *, branch_id: str | None = None
    ) -> set[uuid.UUID] | None:
        """
        Resolve which Product Master IDs belong to ``organization_id``,
        optionally further restricted to ``branch_id``.

        The Organization filter (see ``list_page_for_sheet``/``count_for_sheet``)
        is never a real column on ``planning_rows`` -- it's read straight off
        the row's linked Product Master record's ``organization_ids`` (a JSON
        array of organization UUIDs, multi-select on the Product Master form;
        see ``app.masters.products.models.Product.organization_ids``), the
        exact same "extract from Product Master, never store a stale copy"
        pattern every other Shipment Planning lookup column already uses
        (see ``app.planning.source_registry``). Membership is checked in
        Python rather than via a dialect-specific JSON operator so this stays
        correct on both the Postgres deployment and the SQLite test suite
        (see ``app.database.base``'s dual-dialect ``GUID`` type for the same
        portability concern elsewhere in this codebase).

        ``branch_id`` (optional) further restricts to products whose
        ``branch_ids`` (also JSON, see ``Product.branch_ids``) contains that
        exact branch id -- this is what a sheet LINKED to a specific branch
        (``PlanningSheet.branch_id``) uses for its row auto-population, per
        the "only load products in this exact branch" requirement (stricter
        than the old organization-only filter, which matched any product in
        ANY branch of that organization).

        Returns ``None`` (meaning "no organization filter") only if
        ``organization_id`` wasn't actually passed by the caller -- callers
        that DO pass one always get a concrete (possibly empty) set back,
        since "no products belong to this org/branch" should filter every
        row out, not disable the filter.
        """
        ids = await self._all_product_ids_for_organization(organization_id, branch_id=branch_id)
        return set(ids)

    async def _all_product_ids_for_organization(
        self, organization_id: uuid.UUID | None, *, branch_id: str | None = None
    ) -> list[uuid.UUID]:
        """
        Return every live Product Master ID, ordered by Sub Category (so
        products cluster together by sub-category, in sub-category name
        order -- mirroring how Product Master's own list naturally reads
        when products were entered sub-category-by-sub-category), then by
        ``created_at``/``id`` as the tiebreaker within each sub-category
        group. Optionally restricted to those whose ``organization_ids``
        contains ``organization_id`` AND (if given) whose ``branch_ids``
        contains ``branch_id``.

        Products with no ``sub_category_id`` set sort last, after every
        named sub-category group, rather than interleaving with them.

        This ordering is what makes Shipment Planning's ITEM column (when
        LINKED_LOOKUP onto "product") list/auto-populate items clustered
        by Sub Category, matching the requirement that the ITEM list
        "should be completely based on Sub categories" the same way
        Product Master's list already reads.

        Line up 1:1 with what ``PlanningService.auto_populate_rows_from_item_source``
        pulls (same ordering is applied there too, see that method) --
        important because both the "how many rows COULD this sheet have"
        count and the "create the next N rows" action need to agree on
        which record is #1, #2, #51, etc., or a page boundary could skip
        or duplicate a record.
        """
        from sqlalchemy import func
        from app.masters.product_sub_categories.models import ProductSubCategory
        from app.masters.products.models import Product

        stmt = (
            select(Product.id, Product.organization_ids, Product.branch_ids)
            .outerjoin(ProductSubCategory, ProductSubCategory.id == Product.sub_category_id)
            .where(Product.deleted_at.is_(None))
            .order_by(
                ProductSubCategory.name.is_(None),  # False (has a sub-category) sorts before True (none)
                func.lower(ProductSubCategory.name).asc(),
                func.lower(func.coalesce(Product.product_name_tally, Product.product_name)).asc(),
                func.lower(Product.product_code).asc(),
                Product.id,
            )
        )
        result = await self.session.execute(stmt)
        rows = result.all()
        if organization_id is None:
            return [row[0] for row in rows]
        org_str = str(organization_id)
        matching = [
            (product_id, branch_ids)
            for product_id, organization_ids, branch_ids in rows
            if organization_ids and org_str in [str(x) for x in organization_ids]
        ]
        if branch_id is None:
            return [product_id for product_id, _ in matching]
        return [
            product_id
            for product_id, branch_ids in matching
            if branch_ids and branch_id in [str(x) for x in branch_ids]
        ]

    def _apply_search_column_filters(
        self, stmt, sheet_id: uuid.UUID, search_column_filters: list["ColumnSearchFilter"] | None
    ):
        """
        AND together one SQL condition per entry in ``search_column_filters``
        onto ``stmt`` (a query already selecting/filtering ``PlanningRow``),
        mirroring the frontend's client-side ``filteredRows`` logic (see
        Planning.tsx) exactly -- same per-column combination of substring
        `text_query` and/or exact-match `selected_values` -- but running
        server-side against every row on the sheet via ``PlanningCell.value``
        (now always the current, already-computed value -- see
        ``PlanningService.recompute_and_store_cell`` and every write path
        that keeps it fresh), not just whichever page the browser has
        already fetched.

        Each filter becomes its own ``EXISTS`` subquery (ITEM's own column
        is matched against ``PlanningRow.label`` directly instead, since it
        has no ``PlanningCell`` of its own) -- one EXISTS per filtered
        column, ANDed together, so a row must satisfy EVERY active column
        filter simultaneously, exactly like the old client-side version's
        `for ... if not match: return False` loop.
        """
        if not search_column_filters:
            return stmt
        for filt in search_column_filters:
            text_query = (filt.text_query or "").strip()
            selected_values = filt.selected_values or []
            if not text_query and not selected_values:
                continue

            if filt.column_id is None:
                # ITEM column -- matched directly against PlanningRow.label,
                # no PlanningCell involved.
                conditions = []
                if text_query:
                    conditions.append(PlanningRow.label.ilike(f"%{text_query}%"))
                if selected_values:
                    # "(Blanks)" is the frontend's sentinel for "empty" --
                    # match it against a null/empty label, exactly like the
                    # client-side version's `val = row.label || "(Blanks)"`.
                    real_values = [v for v in selected_values if v != "(Blanks)"]
                    value_conditions = []
                    if real_values:
                        value_conditions.append(PlanningRow.label.in_(real_values))
                    if "(Blanks)" in selected_values:
                        value_conditions.append(
                            (PlanningRow.label.is_(None)) | (PlanningRow.label == "")
                        )
                    if value_conditions:
                        combined_values = value_conditions[0]
                        for extra in value_conditions[1:]:
                            combined_values = combined_values | extra
                        conditions.append(combined_values)
                if conditions:
                    combined = conditions[0]
                    for c in conditions[1:]:
                        combined = combined & c
                    stmt = stmt.where(combined)
                continue

            # Ordinary column -- matched via an EXISTS subquery against
            # PlanningCell (row_id = outer row's id, column_id = this
            # filter's column, value matching the same rules as above).
            cell_conditions = [
                PlanningCell.row_id == PlanningRow.id,
                PlanningCell.column_id == filt.column_id,
            ]
            value_match_conditions = []
            if text_query:
                value_match_conditions.append(PlanningCell.value.ilike(f"%{text_query}%"))
            if selected_values:
                real_values = [v for v in selected_values if v != "(Blanks)"]
                sub_conditions = []
                if real_values:
                    sub_conditions.append(PlanningCell.value.in_(real_values))
                if "(Blanks)" in selected_values:
                    sub_conditions.append((PlanningCell.value.is_(None)) | (PlanningCell.value == ""))
                if sub_conditions:
                    combined_sub = sub_conditions[0]
                    for c in sub_conditions[1:]:
                        combined_sub = combined_sub | c
                    value_match_conditions.append(combined_sub)
            if not value_match_conditions:
                continue
            combined_value_match = value_match_conditions[0]
            for c in value_match_conditions[1:]:
                combined_value_match = combined_value_match & c
            cell_conditions.append(combined_value_match)
            stmt = stmt.where(exists(select(PlanningCell.id).where(*cell_conditions)))
        return stmt

    async def list_page_for_sheet(
        self,
        sheet_id: uuid.UUID,
        *,
        offset: int = 0,
        limit: int | None = 50,
        organization_id: uuid.UUID | None = None,
        branch_id: str | None = None,
        search_column_filters: list["ColumnSearchFilter"] | None = None,
    ) -> list[PlanningRow]:
        """
        Same ordering/eager-loading as ``list_for_sheet``, but only one page.

        Added for the grid-read endpoint (``PlanningService.get_grid``),
        which used to call ``list_for_sheet`` and pull every row on the
        sheet on every load -- the dominant cost once a sheet has more
        than ~100 rows. Every OTHER caller of ``list_for_sheet`` (moving a
        row, computing next_position, auto-populate de-dupe, etc.) still
        needs the FULL unpaginated list and is deliberately left calling
        the original method unchanged.

        ``organization_id`` (optional) restricts the page to rows whose
        linked Product Master record belongs to that organization -- see
        ``_linked_record_ids_for_organization``. ``branch_id`` (optional,
        only meaningful together with ``organization_id``) further
        restricts to that organization's specific branch -- this is what a
        sheet LINKED to a branch (``PlanningSheet.branch_id``) always
        passes. Applied server-side (not left to the frontend to filter
        the already-loaded page) so the filter searches the WHOLE sheet,
        not just whichever page happens to be loaded already.

        ``search_column_filters`` (optional) is the server-side equivalent
        of the frontend's per-column Excel-style filter panel -- see
        ``_apply_search_column_filters`` for how each filter is applied.
        Unlike the client-side version (which only ever searched whatever
        page of rows the browser had already fetched), this searches EVERY
        row on the sheet, matching the requirement that searching should
        surface matches from the whole dataset, not just what's currently
        scrolled into view.
        """
        stmt = (
            select(PlanningRow)
            .where(PlanningRow.sheet_id == sheet_id, PlanningRow.deleted_at.is_(None))
            .options(selectinload(PlanningRow.cells))
        )
        if organization_id is not None:
            matching_ids = await self._linked_record_ids_for_organization(organization_id, branch_id=branch_id)
            if not matching_ids:
                return []
            stmt = stmt.where(PlanningRow.linked_record_id.in_(matching_ids))
        stmt = self._apply_search_column_filters(stmt, sheet_id, search_column_filters)
        stmt = stmt.order_by(PlanningRow.position, PlanningRow.created_at).offset(offset)
        if limit is not None:
            stmt = stmt.limit(limit)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count_for_sheet(
        self,
        sheet_id: uuid.UUID,
        *,
        organization_id: uuid.UUID | None = None,
        branch_id: str | None = None,
        search_column_filters: list[ColumnSearchFilter] | None = None,
    ) -> int:
        """
        Total live row count for a sheet, used for the grid's pagination footer.

        ``organization_id``/``branch_id`` (optional) mirror
        ``list_page_for_sheet`` -- when set, only rows whose linked Product
        Master belongs to that organization (and, if given, that specific
        branch) are counted, so "Showing X-Y of N" stays accurate for a
        branch-linked sheet. ``search_column_filters`` (optional) mirrors
        the same parameter on ``list_page_for_sheet`` -- with a search
        active, this becomes "how many rows MATCH the search", not the
        sheet's total row count.
        """
        stmt = select(func.count(PlanningRow.id)).where(
            PlanningRow.sheet_id == sheet_id, PlanningRow.deleted_at.is_(None)
        )
        if organization_id is not None:
            matching_ids = await self._linked_record_ids_for_organization(organization_id, branch_id=branch_id)
            if not matching_ids:
                return 0
            stmt = stmt.where(PlanningRow.linked_record_id.in_(matching_ids))
        stmt = self._apply_search_column_filters(stmt, sheet_id, search_column_filters)
        result = await self.session.execute(stmt)
        return int(result.scalar_one())

    async def next_position(self, sheet_id: uuid.UUID) -> int:
        rows = await self.list_for_sheet(sheet_id)
        return (max((r.position for r in rows), default=-1)) + 1

    async def shift_positions_after(self, sheet_id: uuid.UUID, from_position: int, delta: int) -> None:
        """Shift every row at or after ``from_position`` by ``delta`` (used on insert/delete/move)."""
        stmt = (
            update(PlanningRow)
            .where(PlanningRow.sheet_id == sheet_id, PlanningRow.position >= from_position, PlanningRow.deleted_at.is_(None))
            .values(position=PlanningRow.position + delta)
        )
        await self.session.execute(stmt)


class PlanningColumnRepository(BaseRepository[PlanningColumn]):
    """Repository for ``planning_columns`` (admin-defined, unlimited, positioned)."""

    searchable_fields = ("name",)
    sortable_fields = ("name", "position", "created_at")
    filterable_fields = ("sheet_id",)

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningColumn)

    async def list_for_sheet(self, sheet_id: uuid.UUID) -> list[PlanningColumn]:
        stmt = (
            select(PlanningColumn)
            .where(PlanningColumn.sheet_id == sheet_id, PlanningColumn.deleted_at.is_(None))
            .order_by(PlanningColumn.position, PlanningColumn.created_at)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_by_name(self, sheet_id: uuid.UUID, name: str) -> PlanningColumn | None:
        stmt = select(PlanningColumn).where(
            PlanningColumn.sheet_id == sheet_id,
            PlanningColumn.name == name,
            PlanningColumn.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_aggregate_columns_for_module(self, source_module_key: str) -> list[PlanningColumn]:
        """
        Every AGGREGATE column (across every sheet) pulling from
        ``source_module_key`` -- e.g. every "count of active products in
        category X" style column, regardless of which sheet it's on.

        Used by
        PlanningService.recompute_and_store_cells_referencing_record: an
        aggregate summarizes across many records in its source module, so
        it must recompute whenever ANY record in that module changes, not
        just one specific linked record (confirmed as the intended
        behavior, unlike LINKED_LOOKUP which only cares about ITS OWN
        linked record).
        """
        stmt = select(PlanningColumn).where(
            PlanningColumn.source_type == PlanningColumnSourceType.AGGREGATE,
            PlanningColumn.source_module == source_module_key,
            PlanningColumn.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def next_position(self, sheet_id: uuid.UUID) -> int:
        columns = await self.list_for_sheet(sheet_id)
        return (max((c.position for c in columns), default=-1)) + 1

    async def shift_positions_after(self, sheet_id: uuid.UUID, from_position: int, delta: int) -> None:
        """Shift every column at or after ``from_position`` by ``delta`` (used on insert/delete/move)."""
        stmt = (
            update(PlanningColumn)
            .where(
                PlanningColumn.sheet_id == sheet_id,
                PlanningColumn.position >= from_position,
                PlanningColumn.deleted_at.is_(None),
            )
            .values(position=PlanningColumn.position + delta)
        )
        await self.session.execute(stmt)

    async def list_role_lock_ids(self, column_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every role_id locking this column, or an empty list if unlocked (the common case)."""
        stmt = select(PlanningColumnRoleLock.role_id).where(PlanningColumnRoleLock.column_id == column_id)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class PlanningColumnRoleLockRepository(BaseRepository[PlanningColumnRoleLock]):
    """Repository for ``planning_column_role_locks`` (optional per-column role restriction)."""

    searchable_fields = ()
    sortable_fields = ("created_at",)
    filterable_fields = ("column_id", "role_id")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningColumnRoleLock)

    async def replace_for_column(self, column_id: uuid.UUID, role_ids: list[uuid.UUID], *, created_by: uuid.UUID) -> None:
        """Replace a column's role locks with exactly the given set (empty list == fully unlocked)."""
        existing = await self.session.execute(
            select(PlanningColumnRoleLock).where(PlanningColumnRoleLock.column_id == column_id)
        )
        for lock in existing.scalars().all():
            await self.session.delete(lock)
        await self.session.flush()
        seen: set[uuid.UUID] = set()
        for role_id in role_ids:
            if role_id in seen:
                continue
            seen.add(role_id)
            self.session.add(PlanningColumnRoleLock(column_id=column_id, role_id=role_id, created_by=created_by))
        await self.session.flush()


class PlanningCellRepository(BaseRepository[PlanningCell]):
    """Repository for ``planning_cells`` (the (row, column) value + status color)."""

    searchable_fields = ()
    sortable_fields = ("created_at",)
    filterable_fields = ("row_id", "column_id")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningCell)

    async def get_by_row_and_column(self, row_id: uuid.UUID, column_id: uuid.UUID) -> PlanningCell | None:
        stmt = select(PlanningCell).where(PlanningCell.row_id == row_id, PlanningCell.column_id == column_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_for_rows(self, row_ids: list[uuid.UUID]) -> list[PlanningCell]:
        if not row_ids:
            return []
        stmt = select(PlanningCell).where(PlanningCell.row_id.in_(row_ids))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_linked_to_record(self, record_id: uuid.UUID) -> list[PlanningCell]:
        """
        Every cell (across every sheet) explicitly linked to ``record_id``
        via its own ``linked_record_id`` (the per-cell 🔗 link, distinct
        from a row's own ITEM link -- see PlanningRowRepository's
        equivalent method for that case).

        Used by PlanningService.recompute_and_store_cells_referencing_record
        to find exactly which LINKED_LOOKUP cells need recomputing after a
        source-module record (e.g. a Product) is edited, rather than
        rescanning every cell on every sheet.
        """
        stmt = select(PlanningCell).where(PlanningCell.linked_record_id == record_id)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def unlink_or_clear_record(self, record_id: uuid.UUID) -> int:
        """Clear linked_record_id and value on any PlanningCell pointing to record_id."""
        stmt = (
            update(PlanningCell)
            .where(PlanningCell.linked_record_id == record_id)
            .values(linked_record_id=None, value=None)
        )
        result = await self.session.execute(stmt)
        await self.session.flush()
        return result.rowcount


class PlanningStatusTagRepository(BaseRepository[PlanningStatusTag]):
    """Repository for ``planning_status_tags`` (admin-defined custom colors)."""

    searchable_fields = ("label",)
    sortable_fields = ("label", "created_at")
    filterable_fields = ()

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningStatusTag)

    async def list_active(self) -> list[PlanningStatusTag]:
        stmt = select(PlanningStatusTag).where(PlanningStatusTag.deleted_at.is_(None)).order_by(PlanningStatusTag.label)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_by_label(self, label: str) -> PlanningStatusTag | None:
        stmt = select(PlanningStatusTag).where(PlanningStatusTag.label == label, PlanningStatusTag.deleted_at.is_(None))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()


class PlanningChangeLogRepository(BaseRepository[PlanningChangeLog]):
    """
    Repository for ``planning_change_log`` (dedicated who/when history).

    Append-only: no ``update``/``delete`` are ever called against this
    table from application code, only ``create`` and the read methods
    below.
    """

    searchable_fields = ()
    sortable_fields = ("created_at",)
    filterable_fields = ("sheet_id", "row_id", "column_id", "cell_id", "action")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, PlanningChangeLog)

    async def list_for_sheet(self, sheet_id: uuid.UUID, *, limit: int = 200) -> list[PlanningChangeLog]:
        stmt = (
            select(PlanningChangeLog)
            .where(PlanningChangeLog.sheet_id == sheet_id)
            .order_by(PlanningChangeLog.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_for_row(self, row_id: uuid.UUID, *, limit: int = 100) -> list[PlanningChangeLog]:
        stmt = (
            select(PlanningChangeLog)
            .where(PlanningChangeLog.row_id == row_id)
            .order_by(PlanningChangeLog.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_for_column(self, column_id: uuid.UUID, *, limit: int = 100) -> list[PlanningChangeLog]:
        stmt = (
            select(PlanningChangeLog)
            .where(PlanningChangeLog.column_id == column_id)
            .order_by(PlanningChangeLog.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_for_cell(self, cell_id: uuid.UUID, *, limit: int = 100) -> list[PlanningChangeLog]:
        stmt = (
            select(PlanningChangeLog)
            .where(PlanningChangeLog.cell_id == cell_id)
            .order_by(PlanningChangeLog.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())