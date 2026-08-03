"""Department Dependencies. FastAPI DI wiring for the departments module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.departments.repository import DepartmentRepository
from app.departments.service import DepartmentService


def get_department_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> DepartmentService:
    """Build a request-scoped :class:`DepartmentService`."""
    return DepartmentService(DepartmentRepository(db), db, cache_manager)
