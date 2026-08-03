"""Product Sub-Category Dependencies. FastAPI DI wiring for the product_sub_categories module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository
from app.masters.product_sub_categories.service import ProductSubCategoryService


def get_product_sub_category_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> ProductSubCategoryService:
    """Build a request-scoped :class:`ProductSubCategoryService`."""
    return ProductSubCategoryService(
        ProductSubCategoryRepository(db), ProductCategoryRepository(db), cache_manager
    )
