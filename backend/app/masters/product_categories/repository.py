"""Product Category Repository. Query-specific extensions for ``product_categories``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.product_categories.models import ProductCategory


class ProductCategoryRepository(BaseRepository[ProductCategory]):
    """Repository for product category rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``ProductCategory`` model."""
        super().__init__(session, ProductCategory)

    async def get_by_code(self, code: str) -> ProductCategory | None:
        """Fetch a product category by its unique code."""
        stmt = self._base_select().where(ProductCategory.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) category already uses this code."""
        stmt = self._base_select().with_only_columns(ProductCategory.id).where(ProductCategory.code == code)
        if exclude_id is not None:
            stmt = stmt.where(ProductCategory.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def name_exists(self, name: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) category already uses this name."""
        stmt = self._base_select().with_only_columns(ProductCategory.id).where(ProductCategory.name == name)
        if exclude_id is not None:
            stmt = stmt.where(ProductCategory.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name(self, name: str, *, exclude_id: uuid.UUID | None = None) -> ProductCategory | None:
        """Fetch the record with this name, if one exists (for duplicate-compare)."""
        stmt = self._base_select().where(ProductCategory.name == name)
        if exclude_id is not None:
            stmt = stmt.where(ProductCategory.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[ProductCategory]:
        """Return every non-deleted category, ordered by name."""
        stmt = self._base_select().order_by(ProductCategory.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, category_id: uuid.UUID) -> bool:
        """Return True if any sub-category or product references this category (blocks delete)."""
        from sqlalchemy import select

        from app.masters.product_sub_categories.models import ProductSubCategory
        from app.masters.products.models import Product

        sub_stmt = select(ProductSubCategory.id).where(
            ProductSubCategory.category_id == category_id, ProductSubCategory.deleted_at.is_(None)
        ).limit(1)
        if (await self.session.execute(sub_stmt)).scalar_one_or_none() is not None:
            return True

        product_stmt = select(Product.id).where(
            Product.category_id == category_id, Product.deleted_at.is_(None)
        ).limit(1)
        return (await self.session.execute(product_stmt)).scalar_one_or_none() is not None
