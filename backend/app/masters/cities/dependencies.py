"""City Dependencies. FastAPI DI wiring for the cities module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.cities.repository import CityRepository
from app.masters.cities.service import CityService
from app.masters.countries.repository import CountryRepository
from app.masters.states.repository import StateRepository


def get_city_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> CityService:
    """Build a request-scoped :class:`CityService`."""
    return CityService(CityRepository(db), StateRepository(db), CountryRepository(db), cache_manager)
