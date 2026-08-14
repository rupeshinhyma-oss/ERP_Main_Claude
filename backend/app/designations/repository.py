"""Designation Repository. Query-specific extensions for ``designations``."""

from __future__ import annotations

import uuid

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
        """Fetch a designation by its unique code (excludes soft-deleted rows)."""
        stmt = self._base_select().where(Designation.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """
        Return True if another (non-deleted) designation already uses this code.

        Uses ``_base_select()`` rather than a bare ``select(Designation.id)``
        so a soft-deleted designation's old code doesn't block reuse of
        that code by a new record -- now that ``Designation`` has
        ``SoftDeleteMixin``, a plain ``select()`` here would otherwise
        incorrectly report the code as taken forever, even after the
        record holding it was deleted.
        """
        stmt = self._base_select().with_only_columns(Designation.id).where(Designation.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Designation.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[Designation]:
        """Return every non-deleted designation, ordered by title (used for cached dropdown data)."""
        stmt = self._base_select().order_by(Designation.title)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())