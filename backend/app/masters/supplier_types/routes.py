"""SupplierType Routes."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import Response

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.masters.supplier_types.dependencies import get_supplier_type_service
from app.masters.supplier_types.schemas import (
    ImportSummaryRead,
    SupplierTypeCreate,
    SupplierTypeRead,
    SupplierTypeUpdate,
)
from app.masters.supplier_types.service import SupplierTypeService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/supplier-types", tags=["Masters - Supplier Types"])


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
        module="masters.supplier_types",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="SupplierType",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create supplier type")
async def create_supplier_type(
    payload: SupplierTypeCreate,
    request: Request,
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.create(**payload.model_dump())
    data = SupplierTypeRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=item.id,
        description=f"Created supplier type {item.name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List supplier types")
async def list_supplier_types(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: SupplierTypeService = Depends(get_supplier_type_service),
    _current_user: CurrentUser = Depends(require_permission("suppliertype.view")),
) -> dict:
    items, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [SupplierTypeRead.model_validate(b).model_dump(mode="json") for b in items]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export supplier types to CSV/Excel")
async def export_supplier_types(
    request: Request,
    format: str = "csv",
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.export")),
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
        description=f"Exported supplier types as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"supplier_types.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import supplier types from CSV/Excel")
async def import_supplier_types(
    request: Request,
    file: UploadFile = File(...),
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.import")),
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
        description=f"Imported supplier types: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{supplier_type_id}", summary="Get a supplier type")
async def get_supplier_type(
    supplier_type_id: uuid.UUID,
    request: Request,
    service: SupplierTypeService = Depends(get_supplier_type_service),
    _current_user: CurrentUser = Depends(require_permission("suppliertype.view")),
) -> dict:
    item = await service.get_by_id_or_raise(supplier_type_id)
    data = SupplierTypeRead.model_validate(item).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_type_id}", summary="Update a supplier type")
async def update_supplier_type(
    supplier_type_id: uuid.UUID,
    payload: SupplierTypeUpdate,
    request: Request,
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.update(supplier_type_id, **payload.model_dump())
    data = SupplierTypeRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=item.id,
        description=f"Updated supplier type {item.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{supplier_type_id}/activate", summary="Activate a supplier type")
async def activate_supplier_type(
    supplier_type_id: uuid.UUID,
    request: Request,
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.activate(supplier_type_id)
    data = SupplierTypeRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=item.id,
        description=f"Activated supplier type {item.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{supplier_type_id}/deactivate", summary="Deactivate a supplier type")
async def deactivate_supplier_type(
    supplier_type_id: uuid.UUID,
    request: Request,
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    item = await service.deactivate(supplier_type_id)
    data = SupplierTypeRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=item.id,
        description=f"Deactivated supplier type {item.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{supplier_type_id}", summary="Delete a supplier type")
async def delete_supplier_type(
    supplier_type_id: uuid.UUID,
    request: Request,
    service: SupplierTypeService = Depends(get_supplier_type_service),
    current_user: CurrentUser = Depends(require_permission("suppliertype.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    await service.delete(supplier_type_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=supplier_type_id,
        description="Deleted supplier type.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)