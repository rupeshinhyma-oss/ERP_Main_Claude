"""
Organization Structure Repository -- Position.

Department was merged into ``app.rbac.models.Role``; its repository logic
(including the parent-department cycle check) now lives in
``app.rbac.repository.RoleRepository.would_create_cycle``. Assignment-table
repositories (EmployeePositionAssignment, DepartmentLeadershipAssignment,
EmployeeReportingRelationship) live in
``app.org_structure.assignments_repository``.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.org_structure.models import Position


class PositionRepository(BaseRepository[Position]):
    """Repository for position/designation rows."""

    searchable_fields = ("name", "code", "description")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Position`` model."""
        super().__init__(session, Position)

    async def get_by_name(self, name: str, *, exclude_id: uuid.UUID | None = None) -> Position | None:
        """Fetch the position with this name, if one exists."""
        stmt = self._base_select().where(Position.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Position.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def name_exists(self, name: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) position already uses this name."""
        return await self.get_by_name(name, exclude_id=exclude_id) is not None

    async def list_all(self) -> list[Position]:
        """Return every non-deleted position, ordered by name."""
        stmt = self._base_select().order_by(Position.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())