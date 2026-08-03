"""Product Sub-Category Repository. Query-specific extensions for ``product_sub_categories``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.product_sub_categories.models import ProductSubCategory


class ProductSubCategoryRepository(BaseRepository[ProductSubCategory]):
    """Repository for product sub-category rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status", "category_id")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``ProductSubCategory`` model."""
        super().__init__(session, ProductSubCategory)

    async def get_by_code(self, code: str) -> ProductSubCategory | None:
        """Fetch a sub-category by its unique code."""
        stmt = self._base_select().where(ProductSubCategory.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) sub-category already uses this code."""
        stmt = (
            self._base_select().with_only_columns(ProductSubCategory.id).where(ProductSubCategory.code == code)
        )
        if exclude_id is not None:
            stmt = stmt.where(ProductSubCategory.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def name_exists_in_category(
        self, category_id: uuid.UUID, name: str, *, exclude_id: uuid.UUID | None = None
    ) -> bool:
        """Return True if another (non-deleted) sub-category in this category already uses this name."""
        stmt = (
            self._base_select()
            .with_only_columns(ProductSubCategory.id)
            .where(ProductSubCategory.category_id == category_id, ProductSubCategory.name == name)
        )
        if exclude_id is not None:
            stmt = stmt.where(ProductSubCategory.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[ProductSubCategory]:
        """Return every non-deleted sub-category, ordered by name."""
        stmt = self._base_select().order_by(ProductSubCategory.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, sub_category_id: uuid.UUID) -> bool:
        """Return True if any product references this sub-category (blocks delete)."""
        from sqlalchemy import select

        from app.masters.products.models import Product

        stmt = select(Product.id).where(
            Product.sub_category_id == sub_category_id, Product.deleted_at.is_(None)
        ).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None
