"""
Department Routes.

Implements: Department CRUD, employee<->department assignment management,
and department leadership assignment management (Parts 2 and 4 of the
upgrade brief).
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.org_structure.dependencies import get_department_service
from app.org_structure.department_service import DepartmentService
from app.org_structure.schemas import (
    DepartmentAssignmentCreate,
    DepartmentAssignmentRead,
    DepartmentCreate,
    DepartmentRead,
    DepartmentUpdate,
    LeadershipAssignmentCreate,
    LeadershipAssignmentRead,
)
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/org-departments", tags=["Organization - Departments"])


async def _record_action(
    *, audit_service: AuditService, request: Request, action: AuditAction, actor: CurrentUser,
    entity_type: str, entity_id: uuid.UUID | str, description: str, new_values: dict | None = None,
) -> None:
    """Shared helper: record a department/leadership/assignment action and mark the request as logged."""
    await audit_service.record(
        action=action, module="org_structure", user_id=actor.id, username_snapshot=actor.username,
        entity_type=entity_type, entity_id=str(entity_id), new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"), request_id=request.state.request_id,
        http_method=request.method, endpoint=request.url.path, response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


# --- Department CRUD ---------------------------------------------------------------------
@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a department")
async def create_department(
    payload: DepartmentCreate, request: Request,
    service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new organizational department."""
    department = await service.create(**payload.model_dump())
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.CREATE, actor=current_user,
        entity_type="Department", entity_id=department.id,
        description=f"Created department {department.name!r}.", new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List departments")
async def list_departments(
    request: Request, query: ListQueryParams = Depends(get_list_query_params),
    service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(require_permission("orgdepartment.view")),
) -> dict:
    """List departments, with search/sort/filter/pagination."""
    departments, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [DepartmentRead.model_validate(d).model_dump(mode="json") for d in departments]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/all", summary="List every department (unpaginated, for dropdowns/tree)")
async def list_all_departments(
    request: Request, service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(require_permission("orgdepartment.view")),
) -> dict:
    """Return every department, for dropdowns and the nested department tree."""
    departments = await service.list_all()
    data = [DepartmentRead.model_validate(d).model_dump(mode="json") for d in departments]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{department_id}", summary="Get a department")
async def get_department(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch a single department by ID."""
    department = await service.get_by_id_or_raise(department_id)
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{department_id}", summary="Update a department")
async def update_department(
    department_id: uuid.UUID, payload: DepartmentUpdate, request: Request,
    service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update a department. Rejects a ``parent_department_id`` change that would create a cycle."""
    department = await service.update(department_id, **payload.model_dump())
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Department", entity_id=department.id,
        description=f"Updated department {department.name!r}.", new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{department_id}/activate", summary="Activate a department")
async def activate_department(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a department's status to ACTIVE."""
    department = await service.activate(department_id)
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Department", entity_id=department.id, description=f"Activated department {department.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{department_id}/deactivate", summary="Deactivate a department")
async def deactivate_department(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a department's status to INACTIVE (a lighter-weight toggle than archive; does not require an empty roster)."""
    department = await service.deactivate(department_id)
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Department", entity_id=department.id, description=f"Deactivated department {department.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{department_id}/archive", summary="Archive a department")
async def archive_department(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Archive a department. Refuses (409) if it still has active employee or leadership assignments."""
    department = await service.archive(department_id)
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Department", entity_id=department.id, description=f"Archived department {department.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{department_id}", summary="Delete a department")
async def delete_department(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a department. Refuses (409) if it still has active assignments."""
    await service.delete(department_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE, actor=current_user,
        entity_type="Department", entity_id=department_id, description="Deleted department.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# --- Employee <-> Department assignments --------------------------------------------------
@router.get("/{department_id}/roster", summary="List a department's active employee roster")
async def get_department_roster(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(require_permission("orgdepartment.view")),
) -> dict:
    """List every employee currently actively assigned to this department."""
    assignments = await service.list_department_roster(department_id)
    data = [DepartmentAssignmentRead.model_validate(a).model_dump(mode="json") for a in assignments]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/assignments", status_code=status.HTTP_201_CREATED, summary="Assign an employee to a department")
async def create_department_assignment(
    payload: DepartmentAssignmentCreate, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Assign an employee to a department (Part 2). An employee may hold several department assignments at once."""
    assignment = await service.assign_employee(**payload.model_dump())
    data = DepartmentAssignmentRead.model_validate(assignment).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DEPARTMENT_ASSIGNMENT_ADDED, actor=current_user,
        entity_type="EmployeeDepartmentAssignment", entity_id=assignment.id,
        description=f"Assigned employee {payload.employee_id} to department {payload.department_id} ({payload.assignment_type.value}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.delete("/assignments/{assignment_id}", summary="Remove an employee's department assignment")
async def remove_department_assignment(
    assignment_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """End an employee's department assignment (marks it INACTIVE; history is preserved)."""
    await service.remove_employee_assignment(assignment_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DEPARTMENT_ASSIGNMENT_REMOVED, actor=current_user,
        entity_type="EmployeeDepartmentAssignment", entity_id=assignment_id, description="Removed department assignment.",
    )
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)


# --- Department Leadership ------------------------------------------------------------------
@router.get("/{department_id}/leadership", summary="List a department's active leadership")
async def get_department_leadership(
    department_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(require_permission("orgdepartment.view")),
) -> dict:
    """List every active leadership assignment (head/managers) for this department."""
    leadership = await service.list_leadership(department_id)
    data = [LeadershipAssignmentRead.model_validate(l).model_dump(mode="json") for l in leadership]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/leadership", status_code=status.HTTP_201_CREATED, summary="Assign department leadership")
async def create_leadership_assignment(
    payload: LeadershipAssignmentCreate, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Assign an employee a leadership role over a department (Part 4). The same employee may lead several departments."""
    assignment = await service.assign_leadership(**payload.model_dump())
    data = LeadershipAssignmentRead.model_validate(assignment).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.LEADERSHIP_ASSIGNMENT_ADDED, actor=current_user,
        entity_type="DepartmentLeadershipAssignment", entity_id=assignment.id,
        description=f"Assigned {payload.leadership_type.value} of department {payload.department_id} to employee {payload.employee_id}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.delete("/leadership/{leadership_id}", summary="Remove a department leadership assignment")
async def remove_leadership_assignment(
    leadership_id: uuid.UUID, request: Request, service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("orgdepartment.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """End a department leadership assignment (marks it INACTIVE; history is preserved)."""
    await service.remove_leadership(leadership_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.LEADERSHIP_ASSIGNMENT_REMOVED, actor=current_user,
        entity_type="DepartmentLeadershipAssignment", entity_id=leadership_id, description="Removed leadership assignment.",
    )
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)
