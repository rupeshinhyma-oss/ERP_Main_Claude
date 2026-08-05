"""City Repository. Query-specific extensions for ``cities``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.cities.models import City


class CityRepository(BaseRepository[City]):
    """Repository for city rows."""

    searchable_fields = ("name",)
    sortable_fields = ("name", "created_at", "updated_at")
    filterable_fields = ("status", "country_id", "state_id")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``City`` model."""
        super().__init__(session, City)

    async def name_exists_in_state(
        self, state_id: uuid.UUID, name: str, *, exclude_id: uuid.UUID | None = None
    ) -> bool:
        """Return True if another (non-deleted) city in this state already uses this name."""
        stmt = (
            self._base_select().with_only_columns(City.id).where(City.state_id == state_id, City.name == name)
        )
        if exclude_id is not None:
            stmt = stmt.where(City.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def city_exists(
        self, country_id: uuid.UUID, state_id: uuid.UUID | None, name: str, *, exclude_id: uuid.UUID | None = None
    ) -> bool:
        """Return True if another city in this state or country already uses this name."""
        stmt = self._base_select().with_only_columns(City.id).where(City.country_id == country_id, City.name == name)
        if state_id is not None:
            stmt = stmt.where(City.state_id == state_id)
        else:
            stmt = stmt.where(City.state_id.is_(None))
        if exclude_id is not None:
            stmt = stmt.where(City.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name_in_state(
        self, state_id: uuid.UUID, name: str, *, exclude_id: uuid.UUID | None = None
    ) -> City | None:
        """Fetch the city in this state with this name, if one exists (for duplicate-compare)."""
        stmt = self._base_select().where(City.state_id == state_id, City.name == name)
        if exclude_id is not None:
            stmt = stmt.where(City.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[City]:
        """Return every non-deleted city, ordered by name."""
        stmt = self._base_select().order_by(City.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, city_id: uuid.UUID) -> bool:
        """
        Return True if any other module references this city.

        No consumers exist yet within Master Data itself (cities are a
        leaf in the geography hierarchy); this is a documented extension
        point for future modules (e.g. supplier/buyer addresses) to check
        against before allowing deletion.
        """
        return False
