"""Brand Dependencies. FastAPI DI wiring for the brands module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.brands.repository import BrandRepository
from app.masters.brands.service import BrandService


def get_brand_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> BrandService:
    """Build a request-scoped :class:`BrandService`."""
    return BrandService(BrandRepository(db), cache_manager)
