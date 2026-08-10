"""Company List Dependencies."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.company_list.repository import CompanyRepository
from app.masters.company_list.service import CompanyService


def get_company_service(
    session: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> CompanyService:
    """Provide a CompanyService instance."""
    repository = CompanyRepository(session)
    return CompanyService(repository, cache_manager)
