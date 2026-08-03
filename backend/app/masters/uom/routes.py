"""Unit of Measurement Routes. Standard CRUD + activate/deactivate + import/export, with audit logging."""

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
from app.masters.uom.dependencies import get_uom_service
from app.masters.uom.schemas import ImportSummaryRead, UomCreate, UomRead, UomUpdate
from app.masters.uom.service import UomService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/uom", tags=["Masters - UOM"])


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
    """Shared helper: record a UOM action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.uom",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="UnitOfMeasurement",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a unit of measurement")
async def create_uom(
    payload: UomCreate,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new unit of measurement."""
    uom = await service.create(**payload.model_dump())
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=uom.id,
        description=f"Created UOM {uom.name!r} ({uom.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List units of measurement")
async def list_uoms(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: UomService = Depends(get_uom_service),
    _current_user: CurrentUser = Depends(require_permission("uom.read")),
) -> dict:
    """List units of measurement, with search/sort/filter/pagination."""
    uoms, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [UomRead.model_validate(u).model_dump(mode="json") for u in uoms]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export units of measurement to CSV/Excel")
async def export_uoms(
    request: Request,
    format: str = "csv",
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every UOM as a CSV or XLSX file."""
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
        description=f"Exported UOMs as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"uom.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import units of measurement from CSV/Excel")
async def import_uoms(
    request: Request,
    file: UploadFile = File(...),
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import UOMs from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported UOMs: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{uom_id}", summary="Get a unit of measurement")
async def get_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    _current_user: CurrentUser = Depends(require_permission("uom.read")),
) -> dict:
    """Fetch a single UOM by ID."""
    uom = await service.get_by_id_or_raise(uom_id)
    data = UomRead.model_validate(uom).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{uom_id}", summary="Update a unit of measurement")
async def update_uom(
    uom_id: uuid.UUID,
    payload: UomUpdate,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing UOM."""
    uom = await service.update(uom_id, **payload.model_dump())
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=uom.id,
        description=f"Updated UOM {uom.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{uom_id}/activate", summary="Activate a unit of measurement")
async def activate_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a UOM's status to active."""
    uom = await service.activate(uom_id)
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=uom.id,
        description=f"Activated UOM {uom.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{uom_id}/deactivate", summary="Deactivate a unit of measurement")
async def deactivate_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a UOM's status to inactive."""
    uom = await service.deactivate(uom_id)
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=uom.id,
        description=f"Deactivated UOM {uom.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{uom_id}", summary="Delete a unit of measurement")
async def delete_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a UOM."""
    await service.delete(uom_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=uom_id,
        description="Deleted UOM.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
