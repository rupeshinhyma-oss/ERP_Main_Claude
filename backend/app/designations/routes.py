"""Designation Routes. Standard CRUD for designations, with audit logging on every mutation."""

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
from app.designations.dependencies import get_designation_service
from app.designations.schemas import DesignationCreate, DesignationRead, DesignationUpdate
from app.designations.service import DesignationService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/designations", tags=["Designations"])


async def _record_designation_action(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    designation_id: uuid.UUID,
    description: str,
    new_values: dict | None = None,
) -> None:
    """Shared helper: record a designation action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="designations",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Designation",
        entity_id=str(designation_id),
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a designation")
async def create_designation(
    payload: DesignationCreate,
    request: Request,
    designation_service: DesignationService = Depends(get_designation_service),
    current_user: CurrentUser = Depends(require_permission("designation.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new designation."""
    designation = await designation_service.create(**payload.model_dump())
    data = DesignationRead.model_validate(designation).model_dump(mode="json")
    await _record_designation_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        designation_id=designation.id,
        description=f"Created designation {designation.title!r} ({designation.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List designations")
async def list_designations(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    designation_service: DesignationService = Depends(get_designation_service),
    _current_user: CurrentUser = Depends(require_permission("designation.read")),
) -> dict:
    """List designations, with search/sort/filter/pagination."""
    designations, total = await designation_service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [DesignationRead.model_validate(d).model_dump(mode="json") for d in designations]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/{designation_id}", summary="Get a designation")
async def get_designation(
    designation_id: uuid.UUID,
    request: Request,
    designation_service: DesignationService = Depends(get_designation_service),
    _current_user: CurrentUser = Depends(require_permission("designation.read")),
) -> dict:
    """Fetch a single designation by ID."""
    designation = await designation_service.get_by_id_or_raise(designation_id)
    data = DesignationRead.model_validate(designation).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{designation_id}", summary="Update a designation")
async def update_designation(
    designation_id: uuid.UUID,
    payload: DesignationUpdate,
    request: Request,
    designation_service: DesignationService = Depends(get_designation_service),
    current_user: CurrentUser = Depends(require_permission("designation.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing designation."""
    designation = await designation_service.update(designation_id, **payload.model_dump())
    data = DesignationRead.model_validate(designation).model_dump(mode="json")
    await _record_designation_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        designation_id=designation.id,
        description=f"Updated designation {designation.title!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{designation_id}", summary="Delete a designation")
async def delete_designation(
    designation_id: uuid.UUID,
    request: Request,
    designation_service: DesignationService = Depends(get_designation_service),
    current_user: CurrentUser = Depends(require_permission("designation.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Delete a designation."""
    await designation_service.delete(designation_id)
    await _record_designation_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        designation_id=designation_id,
        description="Deleted designation.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
