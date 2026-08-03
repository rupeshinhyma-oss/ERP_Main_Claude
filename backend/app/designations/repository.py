"""Designation Repository. Query-specific extensions for ``designations``."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.designations.models import Designation


class DesignationRepository(BaseRepository[Designation]):
    """Repository for designation rows."""

    searchable_fields = ("code", "title")
    sortable_fields = ("code", "title", "level", "created_at", "updated_at")
    filterable_fields = ("status", "level")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Designation`` model."""
        super().__init__(session, Designation)

    async def get_by_code(self, code: str) -> Designation | None:
        """Fetch a designation by its unique code."""
        stmt = select(Designation).where(Designation.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another designation already uses this code."""
        stmt = select(Designation.id).where(Designation.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Designation.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[Designation]:
        """Return every designation, ordered by title (used for cached dropdown data)."""
        stmt = select(Designation).order_by(Designation.title)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())
