"""BuyerType Repository."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.buyer_types.models import BuyerType


class BuyerTypeRepository(BaseRepository[BuyerType]):
    """Repository for buyer_type rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session."""
        super().__init__(session, BuyerType)

    async def get_by_code(self, code: str) -> BuyerType | None:
        """Fetch a buyer type by its code."""
        stmt = self._base_select().where(BuyerType.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Check if code exists."""
        stmt = self._base_select().with_only_columns(BuyerType.id).where(BuyerType.code == code)
        if exclude_id is not None:
            stmt = stmt.where(BuyerType.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name(self, name: str, *, exclude_id: uuid.UUID | None = None) -> BuyerType | None:
        """Fetch by name."""
        stmt = self._base_select().where(BuyerType.name == name)
        if exclude_id is not None:
            stmt = stmt.where(BuyerType.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[BuyerType]:
        """Return all non-deleted buyer types ordered by name."""
        stmt = self._base_select().order_by(BuyerType.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, buyer_type_id: uuid.UUID) -> bool:
        """Check if referenced."""
        return False
