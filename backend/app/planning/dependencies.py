"""Planning Dependencies. FastAPI DI wiring for the planning module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.database.session import get_db_session
from app.planning.repository import (
    PlanningCellRepository,
    PlanningChangeLogRepository,
    PlanningColumnRepository,
    PlanningColumnRoleLockRepository,
    PlanningRowRepository,
    PlanningSheetRepository,
    PlanningStatusTagRepository,
)
from app.planning.service import PlanningService
from app.rbac.repository import UserRoleRepository
from app.masters.company_list.repository import CompanyRepository


def get_planning_service(
    db: AsyncSession = Depends(get_db_session),
    audit_service: AuditService = Depends(get_audit_service),
) -> PlanningService:
    """Build a request-scoped :class:`PlanningService`, wired to every repository it needs."""
    return PlanningService(
        PlanningSheetRepository(db),
        PlanningRowRepository(db),
        PlanningColumnRepository(db),
        PlanningCellRepository(db),
        PlanningStatusTagRepository(db),
        PlanningChangeLogRepository(db),
        audit_service,
        PlanningColumnRoleLockRepository(db),
        user_role_repository=UserRoleRepository(db),
        company_repository=CompanyRepository(db),
    )