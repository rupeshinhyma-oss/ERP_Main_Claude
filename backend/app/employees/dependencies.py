"""Employee Dependencies. FastAPI DI wiring for the employees module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.departments.repository import DepartmentRepository
from app.designations.repository import DesignationRepository
from app.employees.repository import EmployeeRepository
from app.employees.service import EmployeeService
from app.users.repository import UserRepository


def get_employee_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> EmployeeService:
    """Build a request-scoped :class:`EmployeeService` wired to its collaborating repositories."""
    return EmployeeService(
        repository=EmployeeRepository(db),
        department_repository=DepartmentRepository(db),
        designation_repository=DesignationRepository(db),
        user_repository=UserRepository(db),
        session=db,
        cache_manager=cache_manager,
    )
