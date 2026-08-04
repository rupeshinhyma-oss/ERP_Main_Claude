"""Country Repository. Query-specific extensions for ``countries``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.countries.models import Country


class CountryRepository(BaseRepository[Country]):
    """Repository for country rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Country`` model."""
        super().__init__(session, Country)

    async def get_by_code(self, code: str) -> Country | None:
        """Fetch a country by its unique ISO code."""
        stmt = self._base_select().where(Country.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) country already uses this code."""
        stmt = self._base_select().with_only_columns(Country.id).where(Country.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Country.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def name_exists(self, name: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) country already uses this name."""
        stmt = self._base_select().with_only_columns(Country.id).where(Country.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Country.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name(self, name: str, *, exclude_id: uuid.UUID | None = None) -> Country | None:
        """Fetch the record with this name, if one exists (for duplicate-compare)."""
        stmt = self._base_select().where(Country.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Country.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Country]:
        """Return every non-deleted country, ordered by name (used for cached dropdown data)."""
        stmt = self._base_select().order_by(Country.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, country_id: uuid.UUID) -> bool:
        """Return True if any state references this country (blocks delete)."""
        from app.masters.states.models import State

        stmt = self._base_select_other(State).where(State.country_id == country_id, State.deleted_at.is_(None))
        result = await self.session.execute(stmt.with_only_columns(State.id).limit(1))
        return result.scalar_one_or_none() is not None

    def _base_select_other(self, model):
        """Build a bare SELECT for a foreign model (helper for cross-table reference checks)."""
        from sqlalchemy import select

        return select(model)
