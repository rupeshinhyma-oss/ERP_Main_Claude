"""Department Repository. Query-specific extensions for ``departments``."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.departments.models import Department


class DepartmentRepository(BaseRepository[Department]):
    """Repository for department rows."""

    searchable_fields = ("code", "name")
    sortable_fields = ("code", "name", "created_at", "updated_at")
    filterable_fields = ("status", "parent_department_id", "manager_id")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Department`` model."""
        super().__init__(session, Department)

    async def get_by_code(self, code: str) -> Department | None:
        """Fetch a department by its unique code."""
        stmt = self._base_select().where(Department.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) department already uses this code."""
        stmt = self._base_select().with_only_columns(Department.id).where(Department.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Department.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[Department]:
        """Return every non-deleted department, ordered by name (used for cached dropdown data)."""
        stmt = self._base_select().order_by(Department.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_descendant_ids(self, department_id: uuid.UUID, *, max_depth: int = 50) -> set[uuid.UUID]:
        """
        Return the set of department IDs reachable by walking DOWN from ``department_id``.

        Used to prevent circular parent assignment: a department cannot be
        made a descendant of itself.
        """
        descendants: set[uuid.UUID] = set()
        frontier = {department_id}
        for _ in range(max_depth):
            if not frontier:
                break
            stmt = select(Department.id).where(Department.parent_department_id.in_(frontier))
            result = await self.session.execute(stmt)
            children = set(result.scalars().all())
            new_children = children - descendants
            if not new_children:
                break
            descendants |= new_children
            frontier = new_children
        return descendants
