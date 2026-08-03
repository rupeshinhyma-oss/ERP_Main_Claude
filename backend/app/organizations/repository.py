"""
Organization Repository.

Query-specific extensions for the ``organizations`` table. Since this ERP
is single-company only, the interesting method here is :meth:`get_singleton`
rather than anything list-oriented.
"""

from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.organizations.models import Organization


class OrganizationRepository(BaseRepository[Organization]):
    """Repository for the single organization row."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Organization`` model."""
        super().__init__(session, Organization)

    async def get_singleton(self) -> Organization | None:
        """Return the single organization row, or None if it hasn't been created yet."""
        stmt = select(Organization).order_by(Organization.created_at.asc()).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def count_rows(self) -> int:
        """Return the total number of organization rows (should never exceed 1)."""
        stmt = select(func.count()).select_from(Organization)
        result = await self.session.execute(stmt)
        return int(result.scalar_one())
