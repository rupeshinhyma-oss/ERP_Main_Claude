"""Currency Dependencies. FastAPI DI wiring for the currencies module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.currencies.repository import CurrencyRepository
from app.masters.currencies.service import CurrencyService


def get_currency_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> CurrencyService:
    """Build a request-scoped :class:`CurrencyService`."""
    return CurrencyService(CurrencyRepository(db), cache_manager)
