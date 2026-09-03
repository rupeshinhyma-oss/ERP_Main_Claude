"""Position Routes. Implements Position CRUD and employee<->position assignment management (Part 3)."""

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
from app.org_structure.dependencies import get_position_service
from app.org_structure.position_service import PositionService
from app.org_structure.schemas import (
    PositionAssignmentCreate,
    PositionAssignmentRead,
    PositionCreate,
    PositionRead,
    PositionUpdate,
)
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/positions", tags=["Organization - Positions"])


async def _record_action(
    *, audit_service: AuditService, request: Request, action: AuditAction, actor: CurrentUser,
    entity_type: str, entity_id: uuid.UUID | str, description: str, new_values: dict | None = None,
) -> None:
    """Shared helper: record a position/assignment action and mark the request as logged."""
    await audit_service.record(
        action=action, module="org_structure", user_id=actor.id, username_snapshot=actor.username,
        entity_type=entity_type, entity_id=str(entity_id), new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"), request_id=request.state.request_id,
        http_method=request.method, endpoint=request.url.path, response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a position")
async def create_position(
    payload: PositionCreate, request: Request, service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new position/designation."""
    position = await service.create(**payload.model_dump())
    data = PositionRead.model_validate(position).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.CREATE, actor=current_user,
        entity_type="Position", entity_id=position.id, description=f"Created position {position.name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List positions")
async def list_positions(
    request: Request, query: ListQueryParams = Depends(get_list_query_params),
    service: PositionService = Depends(get_position_service),
    _current_user: CurrentUser = Depends(require_permission("position.view")),
) -> dict:
    """List positions, with search/sort/filter/pagination and employee counts."""
    positions, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    pos_ids = [p.id for p in positions]
    counts = await service.get_employee_counts(pos_ids)
    data = []
    for p in positions:
        item = PositionRead.model_validate(p).model_dump(mode="json")
        item["employee_count"] = counts.get(p.id, 0)
        data.append(item)
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/all", summary="List every position (unpaginated, for dropdowns)")
async def list_all_positions(
    request: Request, service: PositionService = Depends(get_position_service),
    _current_user: CurrentUser = Depends(require_permission("position.view")),
) -> dict:
    """Return every position, for assignment-form dropdowns."""
    positions = await service.list_all()
    pos_ids = [p.id for p in positions]
    counts = await service.get_employee_counts(pos_ids)
    data = []
    for p in positions:
        item = PositionRead.model_validate(p).model_dump(mode="json")
        item["employee_count"] = counts.get(p.id, 0)
        data.append(item)
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{position_id}", summary="Get a position")
async def get_position(
    position_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch a single position by ID."""
    position = await service.get_by_id_or_raise(position_id)
    counts = await service.get_employee_counts([position.id])
    data = PositionRead.model_validate(position).model_dump(mode="json")
    data["employee_count"] = counts.get(position.id, 0)
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{position_id}", summary="Update a position")
async def update_position(
    position_id: uuid.UUID, payload: PositionUpdate, request: Request,
    service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update a position/designation."""
    position = await service.update(position_id, **payload.model_dump())
    data = PositionRead.model_validate(position).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Position", entity_id=position.id, description=f"Updated position {position.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{position_id}/activate", summary="Activate a position")
async def activate_position(
    position_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a position's status to ACTIVE."""
    position = await service.activate(position_id)
    data = PositionRead.model_validate(position).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Position", entity_id=position.id, description=f"Activated position {position.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{position_id}/deactivate", summary="Deactivate a position")
async def deactivate_position(
    position_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a position's status to INACTIVE."""
    position = await service.deactivate(position_id)
    data = PositionRead.model_validate(position).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE, actor=current_user,
        entity_type="Position", entity_id=position.id, description=f"Deactivated position {position.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{position_id}", summary="Delete a position")
async def delete_position(
    position_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a position. Refuses (409) if any employee currently holds it."""
    await service.delete(position_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE, actor=current_user,
        entity_type="Position", entity_id=position_id, description="Deleted position.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


@router.get("/{position_id}/holders", summary="List employees currently holding this position")
async def get_position_holders(
    position_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    _current_user: CurrentUser = Depends(require_permission("position.view")),
) -> dict:
    """List every active assignment of employees to this position."""
    assignments = await service.list_position_holders(position_id)
    data = [PositionAssignmentRead.model_validate(a).model_dump(mode="json") for a in assignments]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/holders-for-user/{user_id}", summary="List position assignments held by a user")
async def get_user_positions(
    user_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    _current_user: CurrentUser = Depends(require_permission("position.view")),
) -> dict:
    """List every position assignment held by this person, for their profile view."""
    assignments = await service.list_employee_positions(user_id)
    data = [PositionAssignmentRead.model_validate(a).model_dump(mode="json") for a in assignments]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/assignments", status_code=status.HTTP_201_CREATED, summary="Assign an employee to a position")
async def create_position_assignment(
    payload: PositionAssignmentCreate, request: Request, service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Assign an employee to a position (Part 3). An employee may hold several position assignments at once."""
    assignment = await service.assign_employee(**payload.model_dump())
    data = PositionAssignmentRead.model_validate(assignment).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.POSITION_ASSIGNMENT_ADDED, actor=current_user,
        entity_type="EmployeePositionAssignment", entity_id=assignment.id,
        description=f"Assigned employee {payload.employee_id} to position {payload.position_id} ({payload.assignment_type.value}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.delete("/assignments/{assignment_id}", summary="Remove an employee's position assignment")
async def remove_position_assignment(
    assignment_id: uuid.UUID, request: Request, service: PositionService = Depends(get_position_service),
    current_user: CurrentUser = Depends(require_permission("position.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """End an employee's position assignment (marks it INACTIVE; history is preserved)."""
    await service.remove_employee_assignment(assignment_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.POSITION_ASSIGNMENT_REMOVED, actor=current_user,
        entity_type="EmployeePositionAssignment", entity_id=assignment_id, description="Removed position assignment.",
    )
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)