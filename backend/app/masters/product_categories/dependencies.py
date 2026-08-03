"""Product Category Dependencies. FastAPI DI wiring for the product_categories module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_categories.service import ProductCategoryService


def get_product_category_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> ProductCategoryService:
    """Build a request-scoped :class:`ProductCategoryService`."""
    return ProductCategoryService(ProductCategoryRepository(db), cache_manager)
