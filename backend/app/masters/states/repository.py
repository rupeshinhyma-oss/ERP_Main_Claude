"""State Repository. Query-specific extensions for ``states``."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.states.models import State


class StateRepository(BaseRepository[State]):
    """Repository for state rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status", "country_id")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``State`` model."""
        super().__init__(session, State)

    async def name_exists_in_country(
        self, country_id: uuid.UUID, name: str, *, exclude_id: uuid.UUID | None = None
    ) -> bool:
        """Return True if another (non-deleted) state in this country already uses this name."""
        stmt = (
            self._base_select()
            .with_only_columns(State.id)
            .where(State.country_id == country_id, State.name == name)
        )
        if exclude_id is not None:
            stmt = stmt.where(State.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[State]:
        """Return every non-deleted state, ordered by name."""
        stmt = self._base_select().order_by(State.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, state_id: uuid.UUID) -> bool:
        """Return True if any city references this state (blocks delete)."""
        from app.masters.cities.models import City

        stmt = select(City.id).where(City.state_id == state_id, City.deleted_at.is_(None)).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None
