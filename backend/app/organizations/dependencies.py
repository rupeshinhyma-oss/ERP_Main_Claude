"""Organization Dependencies. FastAPI DI wiring for the organizations module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.organizations.repository import OrganizationRepository
from app.organizations.service import OrganizationService


def get_organization_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> OrganizationService:
    """Build a request-scoped :class:`OrganizationService`."""
    return OrganizationService(OrganizationRepository(db), cache_manager)
