"""
Organization Structure Dependencies. FastAPI DI wiring for Position and Reporting services.

Department was merged into ``app.rbac.models.Role`` -- there is no
``get_department_service`` here anymore; use ``app.rbac.dependencies.get_rbac_service``
for department (Role) management. Employee was merged into
``app.users.models.User`` -- these services take a ``UserRepository``,
not a dropped ``EmployeeRepository``.
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import get_db_session
from app.org_structure.assignments_repository import (
    DepartmentLeadershipAssignmentRepository,
    EmployeePositionAssignmentRepository,
    EmployeeReportingRelationshipRepository,
)
from app.org_structure.position_service import PositionService
from app.org_structure.reporting_service import ReportingService
from app.org_structure.repository import PositionRepository
from app.rbac.repository import RoleRepository
from app.users.repository import UserRepository


def get_position_service(db: AsyncSession = Depends(get_db_session)) -> PositionService:
    """Build a request-scoped :class:`PositionService`."""
    return PositionService(
        PositionRepository(db),
        EmployeePositionAssignmentRepository(db),
        UserRepository(db),
        RoleRepository(db),
    )


def get_reporting_service(db: AsyncSession = Depends(get_db_session)) -> ReportingService:
    """Build a request-scoped :class:`ReportingService`."""
    return ReportingService(EmployeeReportingRelationshipRepository(db), UserRepository(db))


def get_department_leadership_repository(db: AsyncSession = Depends(get_db_session)) -> DepartmentLeadershipAssignmentRepository:
    """Build a request-scoped :class:`DepartmentLeadershipAssignmentRepository` (used directly by department_routes)."""
    return DepartmentLeadershipAssignmentRepository(db)