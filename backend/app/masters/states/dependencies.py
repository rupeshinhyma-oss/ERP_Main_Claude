"""State Dependencies. FastAPI DI wiring for the states module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.countries.repository import CountryRepository
from app.masters.states.repository import StateRepository
from app.masters.states.service import StateService


def get_state_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> StateService:
    """Build a request-scoped :class:`StateService`."""
    return StateService(StateRepository(db), CountryRepository(db), cache_manager)
