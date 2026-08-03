"""Country Dependencies. FastAPI DI wiring for the countries module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.countries.repository import CountryRepository
from app.masters.countries.service import CountryService


def get_country_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> CountryService:
    """Build a request-scoped :class:`CountryService`."""
    return CountryService(CountryRepository(db), cache_manager)
