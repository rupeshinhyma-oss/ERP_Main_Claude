"""Product Dependencies. FastAPI DI wiring for the products module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.brands.repository import BrandRepository
from app.masters.hsn.repository import HsnRepository
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository
from app.masters.products.repository import ProductRepository
from app.masters.products.service import ProductService
from app.masters.uom.repository import UomRepository


def get_product_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> ProductService:
    """Build a request-scoped :class:`ProductService`, wired to every master it references."""
    return ProductService(
        ProductRepository(db),
        ProductCategoryRepository(db),
        ProductSubCategoryRepository(db),
        BrandRepository(db),
        HsnRepository(db),
        UomRepository(db),
        cache_manager,
    )
