"""Designation Dependencies. FastAPI DI wiring for the designations module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.designations.repository import DesignationRepository
from app.designations.service import DesignationService


def get_designation_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> DesignationService:
    """Build a request-scoped :class:`DesignationService`."""
    return DesignationService(DesignationRepository(db), cache_manager)
