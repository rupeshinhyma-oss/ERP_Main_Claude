"""Unit of Measurement Dependencies. FastAPI DI wiring for the UOM module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.uom.repository import UomRepository
from app.masters.uom.service import UomService


def get_uom_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> UomService:
    """Build a request-scoped :class:`UomService`."""
    return UomService(UomRepository(db), cache_manager)
