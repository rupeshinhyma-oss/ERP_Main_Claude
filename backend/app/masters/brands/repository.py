"""Brand Repository. Query-specific extensions for ``brands``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.brands.models import Brand


class BrandRepository(BaseRepository[Brand]):
    """Repository for brand rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Brand`` model."""
        super().__init__(session, Brand)

    async def get_by_code(self, code: str) -> Brand | None:
        """Fetch a brand by its unique code."""
        stmt = self._base_select().where(Brand.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) brand already uses this code."""
        stmt = self._base_select().with_only_columns(Brand.id).where(Brand.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Brand.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def name_exists(self, name: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) brand already uses this name."""
        stmt = self._base_select().with_only_columns(Brand.id).where(Brand.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Brand.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name(self, name: str, *, exclude_id: uuid.UUID | None = None) -> Brand | None:
        """Fetch the record with this name, if one exists (for duplicate-compare)."""
        stmt = self._base_select().where(Brand.name == name)
        if exclude_id is not None:
            stmt = stmt.where(Brand.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Brand]:
        """Return every non-deleted brand, ordered by name."""
        stmt = self._base_select().order_by(Brand.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, brand_id: uuid.UUID) -> bool:
        """Return True if any product references this brand (blocks delete)."""
        from sqlalchemy import select

        from app.masters.products.models import Product

        stmt = select(Product.id).where(Product.brand_id == brand_id, Product.deleted_at.is_(None)).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None
