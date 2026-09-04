"""
Department Leadership Routes.

Restores create/remove management of ``DepartmentLeadershipAssignment``
rows (who is the DEPARTMENT_HEAD / PRIMARY_MANAGER / ASSISTANT_MANAGER /
ACTING_MANAGER of a department) -- lives here, in ``org_structure``,
rather than in ``app.rbac``, because a leadership assignment always
references a department's ``Role`` id but the assignment record itself is
purely organizational (who manages whom), not a permission grant. See
``app.org_structure.models`` for why ``department_id`` on this table
points at ``roles.id`` (Department/Role merge).

History note: this functionality previously lived in a
``department_service.py`` / ``department_routes.py`` pair that also
handled real estate now owned by ``app.rbac`` (department CRUD, employee
department assignment) after the Department/Role merge. Those two files
were deleted as part of that merge, but leadership-assignment management
was accidentally deleted along with them rather than migrated -- this
file restores just that piece, reusing the same
``DepartmentLeadershipAssignmentRepository`` (never removed) and the same
validation rules (duplicate prevention, optional single-active-
PRIMARY_MANAGER-per-department enforcement) the original service had.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.core.exceptions import ConflictException, NotFoundException
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.org_structure.assignments_repository import DepartmentLeadershipAssignmentRepository
from app.org_structure.dependencies import get_department_leadership_repository
from app.org_structure.models import DepartmentLeadershipAssignment, LeadershipType, OrgRecordStatus
from app.org_structure.schemas import LeadershipAssignmentCreate, LeadershipAssignmentRead
from app.rbac.dependencies import require_permission
from app.rbac.repository import RoleRepository
from app.users.repository import UserRepository

router = APIRouter(prefix="/department-leadership", tags=["Organization - Department Leadership"])


async def _record_action(
    *, audit_service: AuditService, request: Request, action: AuditAction, actor: CurrentUser,
    entity_id: uuid.UUID | str, description: str, new_values: dict | None = None,
) -> None:
    """Shared helper: record a leadership-assignment action and mark the request as logged."""
    await audit_service.record(
        action=action, module="org_structure", user_id=actor.id, username_snapshot=actor.username,
        entity_type="DepartmentLeadershipAssignment", entity_id=str(entity_id), new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"), request_id=request.state.request_id,
        http_method=request.method, endpoint=request.url.path, response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


@router.get("/{department_id}", summary="List a department's active leadership")
async def list_department_leadership(
    department_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db_session),
    leadership_repo: DepartmentLeadershipAssignmentRepository = Depends(get_department_leadership_repository),
    _current_user: CurrentUser = Depends(require_permission("roles_permissions.view")),
) -> dict:
    """List every active leadership assignment (head/managers) for this department."""
    role = await RoleRepository(db).get_by_id(department_id)
    if role is None:
        raise NotFoundException("Department not found.")
    assignments = await leadership_repo.list_for_department(department_id)
    data = [LeadershipAssignmentRead.model_validate(a).model_dump(mode="json") for a in assignments]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("", status_code=status.HTTP_201_CREATED, summary="Assign department leadership")
async def create_leadership_assignment(
    payload: LeadershipAssignmentCreate, request: Request, db: AsyncSession = Depends(get_db_session),
    leadership_repo: DepartmentLeadershipAssignmentRepository = Depends(get_department_leadership_repository),
    current_user: CurrentUser = Depends(require_permission("roles_permissions.action")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Assign a person a leadership role over a department (the same person
    may lead several departments; a department may have several
    leadership assignments of different types -- e.g. one PRIMARY_MANAGER
    plus several ASSISTANT_MANAGERs -- simultaneously).
    """
    role_repo = RoleRepository(db)
    user_repo = UserRepository(db)

    role = await role_repo.get_by_id(payload.department_id)
    if role is None:
        raise NotFoundException("Department not found.")
    user = await user_repo.get_by_id(payload.employee_id)
    if user is None:
        raise NotFoundException("User not found.")

    existing = await leadership_repo.get_exact(payload.department_id, payload.employee_id, payload.leadership_type)
    if existing is not None and existing.status == OrgRecordStatus.ACTIVE:
        raise ConflictException(
            f"This person already holds an active {payload.leadership_type.value} assignment on this department."
        )

    if payload.enforce_single_primary_manager and payload.leadership_type == LeadershipType.PRIMARY_MANAGER:
        current_primaries = await leadership_repo.get_active_by_type(payload.department_id, LeadershipType.PRIMARY_MANAGER)
        if current_primaries:
            raise ConflictException(
                "This department already has an active Primary Manager. Remove the existing "
                "assignment first, or use ASSISTANT_MANAGER/ACTING_MANAGER instead."
            )

    if existing is not None:
        assignment = await leadership_repo.update(
            existing, status=OrgRecordStatus.ACTIVE, is_primary=payload.is_primary,
            effective_from=payload.effective_from, effective_to=payload.effective_to,
        )
    else:
        assignment = await leadership_repo.create(
            department_id=payload.department_id,
            employee_id=payload.employee_id,
            leadership_type=payload.leadership_type,
            is_primary=payload.is_primary,
            effective_from=payload.effective_from,
            effective_to=payload.effective_to,
            status=OrgRecordStatus.ACTIVE,
        )

    data = LeadershipAssignmentRead.model_validate(assignment).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.LEADERSHIP_ASSIGNMENT_ADDED, actor=current_user,
        entity_id=assignment.id,
        description=f"Assigned {payload.leadership_type.value} of department {payload.department_id} to user {payload.employee_id}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.delete("/{leadership_id}", summary="Remove a department leadership assignment")
async def remove_leadership_assignment(
    leadership_id: uuid.UUID, request: Request,
    leadership_repo: DepartmentLeadershipAssignmentRepository = Depends(get_department_leadership_repository),
    current_user: CurrentUser = Depends(require_permission("roles_permissions.action")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """End a department leadership assignment (marks it INACTIVE; history is preserved)."""
    assignment = await leadership_repo.get_by_id(leadership_id)
    if assignment is None:
        raise NotFoundException("Leadership assignment not found.")
    await leadership_repo.update(assignment, status=OrgRecordStatus.INACTIVE)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.LEADERSHIP_ASSIGNMENT_REMOVED, actor=current_user,
        entity_id=leadership_id, description="Removed leadership assignment.",
    )
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)
