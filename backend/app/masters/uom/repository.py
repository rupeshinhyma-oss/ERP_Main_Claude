"""Unit of Measurement Repository. Query-specific extensions for ``units_of_measurement``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.uom.models import UnitOfMeasurement


class UomRepository(BaseRepository[UnitOfMeasurement]):
    """Repository for unit-of-measurement rows."""

    searchable_fields = ("name", "code", "short_name")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``UnitOfMeasurement`` model."""
        super().__init__(session, UnitOfMeasurement)

    async def get_by_code(self, code: str) -> UnitOfMeasurement | None:
        """Fetch a UOM by its unique code."""
        stmt = self._base_select().where(UnitOfMeasurement.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) UOM already uses this code."""
        stmt = self._base_select().with_only_columns(UnitOfMeasurement.id).where(UnitOfMeasurement.code == code)
        if exclude_id is not None:
            stmt = stmt.where(UnitOfMeasurement.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def name_exists(self, name: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) UOM already uses this name."""
        stmt = self._base_select().with_only_columns(UnitOfMeasurement.id).where(UnitOfMeasurement.name == name)
        if exclude_id is not None:
            stmt = stmt.where(UnitOfMeasurement.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[UnitOfMeasurement]:
        """Return every non-deleted UOM, ordered by name."""
        stmt = self._base_select().order_by(UnitOfMeasurement.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, uom_id: uuid.UUID) -> bool:
        """Return True if any product references this UOM (blocks delete)."""
        from app.masters.products.models import Product

        from sqlalchemy import select

        stmt = select(Product.id).where(Product.uom_id == uom_id, Product.deleted_at.is_(None)).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None
