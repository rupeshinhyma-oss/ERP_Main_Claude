"""Department Routes. Standard CRUD for departments, with audit logging on every mutation."""

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
from app.departments.dependencies import get_department_service
from app.departments.schemas import DepartmentCreate, DepartmentRead, DepartmentUpdate
from app.departments.service import DepartmentService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/departments", tags=["Departments"])


async def _record_department_action(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    department_id: uuid.UUID,
    description: str,
    new_values: dict | None = None,
) -> None:
    """Shared helper: record a department action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="departments",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Department",
        entity_id=str(department_id),
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a department")
async def create_department(
    payload: DepartmentCreate,
    request: Request,
    department_service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("department.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new department."""
    department = await department_service.create(**payload.model_dump())
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_department_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        department_id=department.id,
        description=f"Created department {department.name!r} ({department.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List departments")
async def list_departments(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    department_service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(require_permission("department.read")),
) -> dict:
    """List departments, with search/sort/filter/pagination."""
    departments, total = await department_service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [DepartmentRead.model_validate(d).model_dump(mode="json") for d in departments]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/{department_id}", summary="Get a department")
async def get_department(
    department_id: uuid.UUID,
    request: Request,
    department_service: DepartmentService = Depends(get_department_service),
    _current_user: CurrentUser = Depends(require_permission("department.read")),
) -> dict:
    """Fetch a single department by ID."""
    department = await department_service.get_by_id_or_raise(department_id)
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{department_id}", summary="Update a department")
async def update_department(
    department_id: uuid.UUID,
    payload: DepartmentUpdate,
    request: Request,
    department_service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("department.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing department."""
    department = await department_service.update(department_id, **payload.model_dump())
    data = DepartmentRead.model_validate(department).model_dump(mode="json")
    await _record_department_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        department_id=department.id,
        description=f"Updated department {department.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{department_id}", summary="Delete a department")
async def delete_department(
    department_id: uuid.UUID,
    request: Request,
    department_service: DepartmentService = Depends(get_department_service),
    current_user: CurrentUser = Depends(require_permission("department.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a department."""
    await department_service.delete(department_id)
    await _record_department_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        department_id=department_id,
        description="Deleted department.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
