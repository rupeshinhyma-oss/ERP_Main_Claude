"""BuyerType Routes."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import Response

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.masters.buyer_types.dependencies import get_buyer_type_service
from app.masters.buyer_types.schemas import (
    BuyerTypeCreate,
    BuyerTypeRead,
    BuyerTypeUpdate,
    ImportSummaryRead,
)
from app.masters.buyer_types.service import BuyerTypeService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/buyer-types", tags=["Masters - Buyer Types"])


async def _record_action(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    entity_id: uuid.UUID | str,
    description: str,
    new_values: dict | None = None,
) -> None:
    await audit_service.record(
        action=action,
        module="masters.buyer_types",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="BuyerType",
        entity_id=str(entity_id),
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create buyer type")
async def create_buyer_type(
    payload: BuyerTypeCreate,
    request: Request,
    service: BuyerTypeService = Depends(get_buyer_type_service),
    current_user: CurrentUser = Depends(require_permission("buyertype.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.create(**payload.model_dump())
    data = BuyerTypeRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=item.id,
        description=f"Created buyer type {item.name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List buyer types")
async def list_buyer_types(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: BuyerTypeService = Depends(get_buyer_type_service),
    _current_user: CurrentUser = Depends(require_permission("buyertype.view")),
) -> dict:
    items, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [BuyerTypeRead.model_validate(b).model_dump(mode="json") for b in items]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export buyer types to CSV/Excel")
async def export_buyer_types(
    request: Request,
    format: str = "csv",
    service: BuyerTypeService = Depends(get_buyer_type_service),
    current_user: CurrentUser = Depends(require_permission("buyertype.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.EXPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Exported buyer types as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"buyer_types.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import buyer types from CSV/Excel")
async def import_buyer_types(
    request: Request,
    file: UploadFile = File(...),
    service: BuyerTypeService = Depends(get_buyer_type_service),
    current_user: CurrentUser = Depends(require_permission("buyertype.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported {summary.created} buyer types from {file.filename!r}.",
    )
    data = ImportSummaryRead.model_validate(summary).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id, message="Import complete.")


@router.get("/{buyer_type_id}", summary="Get buyer type details")
async def get_buyer_type(
    buyer_type_id: uuid.UUID,
    request: Request,
    service: BuyerTypeService = Depends(get_buyer_type_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch a single buyer type by ID (authenticated lookup)."""
    item = await service.get_by_id_or_raise(buyer_type_id)
    data = BuyerTypeRead.model_validate(item).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{buyer_type_id}", summary="Update buyer type")
async def update_buyer_type(
    buyer_type_id: uuid.UUID,
    payload: BuyerTypeUpdate,
    request: Request,
    service: BuyerTypeService = Depends(get_buyer_type_service),
    current_user: CurrentUser = Depends(require_permission("buyertype.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.update(buyer_type_id, **payload.model_dump(exclude_unset=True))
    data = BuyerTypeRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer_type_id,
        description=f"Updated buyer type {item.name!r}.",
        new_values=payload.model_dump(exclude_unset=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{buyer_type_id}", status_code=status.HTTP_200_OK, summary="Delete buyer type")
async def delete_buyer_type(
    buyer_type_id: uuid.UUID,
    request: Request,
    service: BuyerTypeService = Depends(get_buyer_type_service),
    current_user: CurrentUser = Depends(require_permission("buyertype.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.get_by_id_or_raise(buyer_type_id)
    await service.delete(buyer_type_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=buyer_type_id,
        description=f"Deleted buyer type {item.name!r}.",
    )
    return build_success_response(data={"id": str(buyer_type_id)}, request_id=request.state.request_id, message="Resource deleted successfully.")