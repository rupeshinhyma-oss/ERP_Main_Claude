"""
Employee Routes.

Standard CRUD plus the dedicated actions called out in the Phase 6 spec:
transfer department, change designation, assign manager, link user,
deactivate/reactivate. Every mutation is audited explicitly (rather than
relying solely on the generic audit middleware) so the audit trail carries
a specific, human-readable description of what changed.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.employees.dependencies import get_employee_service
from app.employees.schemas import (
    AssignManagerRequest,
    ChangeDesignationRequest,
    EmployeeCreate,
    EmployeeDetailRead,
    EmployeeRead,
    EmployeeUpdate,
    LinkUserRequest,
    TransferDepartmentRequest,
)
from app.employees.service import EmployeeService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/employees", tags=["Employees"])


async def _record_employee_action(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    employee_id: uuid.UUID,
    description: str,
    new_values: dict | None = None,
) -> None:
    """Shared helper: record an employee action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="employees",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Employee",
        entity_id=str(employee_id),
        new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create an employee")
async def create_employee(
    payload: EmployeeCreate,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new employee profile with an auto-generated employee code."""
    employee = await employee_service.create(created_by=current_user.id, **payload.model_dump())
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Created employee {employee.display_name!r} ({employee.employee_code}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List employees")
async def list_employees(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    employee_service: EmployeeService = Depends(get_employee_service),
    _current_user: CurrentUser = Depends(require_permission("employee.read")),
) -> dict:
    """List employees, with search/sort/filter/pagination."""
    employees, total = await employee_service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [EmployeeRead.model_validate(e).model_dump(mode="json") for e in employees]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/{employee_id}", summary="Get an employee (detail view)")
async def get_employee(
    employee_id: uuid.UUID,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    _current_user: CurrentUser = Depends(require_permission("employee.read")),
) -> dict:
    """Fetch a single employee, enriched with department/designation/manager display names."""
    employee = await employee_service.get_by_id_or_raise(employee_id)
    enrichment = await employee_service.get_enrichment(employee)
    data = EmployeeDetailRead(
        **EmployeeRead.model_validate(employee).model_dump(), **enrichment
    ).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{employee_id}", summary="Update an employee's profile")
async def update_employee(
    employee_id: uuid.UUID,
    payload: EmployeeUpdate,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an employee's core profile fields."""
    employee = await employee_service.update(
        employee_id, updated_by=current_user.id, **payload.model_dump()
    )
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Updated profile for employee {employee.display_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{employee_id}", summary="Delete an employee")
async def delete_employee(
    employee_id: uuid.UUID,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete an employee profile."""
    await employee_service.delete(employee_id)
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        employee_id=employee_id,
        description="Deleted employee.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


@router.post("/{employee_id}/transfer-department", summary="Transfer an employee to a different department")
async def transfer_department(
    employee_id: uuid.UUID,
    payload: TransferDepartmentRequest,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Move an employee to a different department."""
    employee = await employee_service.transfer_department(
        employee_id, payload.department_id, updated_by=current_user.id
    )
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Transferred employee {employee.display_name!r} to a new department.",
        new_values={"department_id": str(payload.department_id)},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{employee_id}/change-designation", summary="Change an employee's designation")
async def change_designation(
    employee_id: uuid.UUID,
    payload: ChangeDesignationRequest,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Change an employee's designation."""
    employee = await employee_service.change_designation(
        employee_id, payload.designation_id, updated_by=current_user.id
    )
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Changed designation for employee {employee.display_name!r}.",
        new_values={"designation_id": str(payload.designation_id)},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{employee_id}/assign-manager", summary="Assign (or clear) an employee's manager")
async def assign_manager(
    employee_id: uuid.UUID,
    payload: AssignManagerRequest,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Assign a new manager, or clear the manager entirely with ``manager_id: null``."""
    employee = await employee_service.assign_manager(
        employee_id, payload.manager_id, updated_by=current_user.id
    )
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Changed manager for employee {employee.display_name!r}.",
        new_values={"manager_id": str(payload.manager_id) if payload.manager_id else None},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{employee_id}/link-user", summary="Link an employee profile to a user account")
async def link_user(
    employee_id: uuid.UUID,
    payload: LinkUserRequest,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Link an employee profile to an existing user account (at most one link each way)."""
    employee = await employee_service.link_user(employee_id, payload.user_id, updated_by=current_user.id)
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Linked employee {employee.display_name!r} to a user account.",
        new_values={"user_id": str(payload.user_id)},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{employee_id}/deactivate", summary="Deactivate an employee")
async def deactivate_employee(
    employee_id: uuid.UUID,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Deactivate an employee (sets ``employment_status`` to ``INACTIVE``)."""
    employee = await employee_service.deactivate(employee_id, updated_by=current_user.id)
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Deactivated employee {employee.display_name!r}.",
        new_values={"employment_status": employee.employment_status.value},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{employee_id}/reactivate", summary="Reactivate an employee")
async def reactivate_employee(
    employee_id: uuid.UUID,
    request: Request,
    employee_service: EmployeeService = Depends(get_employee_service),
    current_user: CurrentUser = Depends(require_permission("employee.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Reactivate a previously deactivated employee."""
    employee = await employee_service.reactivate(employee_id, updated_by=current_user.id)
    data = EmployeeRead.model_validate(employee).model_dump(mode="json")
    await _record_employee_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        employee_id=employee.id,
        description=f"Reactivated employee {employee.display_name!r}.",
        new_values={"employment_status": employee.employment_status.value},
    )
    return build_success_response(data=data, request_id=request.state.request_id)
