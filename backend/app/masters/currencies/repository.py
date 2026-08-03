"""Currency Repository. Query-specific extensions for ``currencies``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.currencies.models import Currency


class CurrencyRepository(BaseRepository[Currency]):
    """Repository for currency rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Currency`` model."""
        super().__init__(session, Currency)

    async def get_by_code(self, code: str) -> Currency | None:
        """Fetch a currency by its unique ISO code."""
        stmt = self._base_select().where(Currency.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) currency already uses this code."""
        stmt = self._base_select().with_only_columns(Currency.id).where(Currency.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Currency.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def name_exists(self, name: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) currency already uses this name."""
        stmt = self._base_select().with_only_columns(Currency.id).where(Currency.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Currency.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[Currency]:
        """Return every non-deleted currency, ordered by name."""
        stmt = self._base_select().order_by(Currency.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, currency_id: uuid.UUID) -> bool:
        """Return True if this currency is referenced elsewhere (e.g. future finance modules)."""
        return False
