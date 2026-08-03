"""HSN Dependencies. FastAPI DI wiring for the HSN module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.hsn.repository import HsnRepository
from app.masters.hsn.service import HsnService


def get_hsn_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> HsnService:
    """Build a request-scoped :class:`HsnService`."""
    return HsnService(HsnRepository(db), cache_manager)
