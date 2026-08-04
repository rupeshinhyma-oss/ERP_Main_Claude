"""Product Repository. Query-specific extensions for ``products``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.products.models import Product


class ProductRepository(BaseRepository[Product]):
    """Repository for product rows."""

    searchable_fields = ("product_code", "product_name", "barcode")
    sortable_fields = ("product_code", "product_name", "created_at", "updated_at", "standard_price")
    filterable_fields = ("status", "category_id", "sub_category_id", "brand_id", "hsn_id", "uom_id")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Product`` model."""
        super().__init__(session, Product)

    async def get_by_code(self, product_code: str) -> Product | None:
        """Fetch a product by its unique code."""
        stmt = self._base_select().where(Product.product_code == product_code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, product_code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another product already uses this code."""
        from sqlalchemy import select
        stmt = select(Product.id).where(Product.product_code == product_code)
        if exclude_id is not None:
            stmt = stmt.where(Product.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[Product]:
        """Return every non-deleted product, ordered by name."""
        stmt = self._base_select().order_by(Product.product_name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, product_id: uuid.UUID) -> bool:
        """
        Return True if any other module references this product.

        No consumers exist yet (Products is the leaf/richest master here);
        this is a documented extension point for future modules
        (Inventory, Sales, Purchase) to check against before allowing
        deletion.
        """
        return False
