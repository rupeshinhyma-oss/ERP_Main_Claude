"""
Shipment Planning Repositories.

One repository class per table, each extending :class:`BaseRepository` for
the standard CRUD it provides, plus grid-specific query methods (fetching
a whole sheet's rows/columns/cells in one shot, re-sequencing positions on
insert/delete/move, and reading recent change-log history).
"""

from __future__ import annotations

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.base_repository import BaseRepository
from app.planning.models import (
    PlanningCell,
    PlanningChangeLog,
    PlanningColumn,
    PlanningColumnRoleLock,
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