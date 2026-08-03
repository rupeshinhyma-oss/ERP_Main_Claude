"""HSN Routes. Standard CRUD + activate/deactivate + import/export, with audit logging."""

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
from app.masters.hsn.dependencies import get_hsn_service
from app.masters.hsn.schemas import HsnCreate, HsnRead, HsnUpdate, ImportSummaryRead
from app.masters.hsn.service import HsnService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/hsn", tags=["Masters - HSN"])


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
    """Shared helper: record an HSN action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.hsn",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="HsnCode",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create an HSN code")
async def create_hsn(
    payload: HsnCreate,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new HSN code."""
    hsn = await service.create(**payload.model_dump())
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=hsn.id,
        description=f"Created HSN code {hsn.code!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List HSN codes")
async def list_hsn(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: HsnService = Depends(get_hsn_service),
    _current_user: CurrentUser = Depends(require_permission("hsn.read")),
) -> dict:
    """List HSN codes, with search/sort/filter/pagination."""
    hsn_codes, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [HsnRead.model_validate(h).model_dump(mode="json") for h in hsn_codes]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export HSN codes to CSV/Excel")
async def export_hsn(
    request: Request,
    format: str = "csv",
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every HSN code as a CSV or XLSX file."""
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
        description=f"Exported HSN codes as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"hsn.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import HSN codes from CSV/Excel")
async def import_hsn(
    request: Request,
    file: UploadFile = File(...),
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import HSN codes from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported HSN codes: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{hsn_id}", summary="Get an HSN code")
async def get_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    _current_user: CurrentUser = Depends(require_permission("hsn.read")),
) -> dict:
    """Fetch a single HSN code by ID."""
    hsn = await service.get_by_id_or_raise(hsn_id)
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{hsn_id}", summary="Update an HSN code")
async def update_hsn(
    hsn_id: uuid.UUID,
    payload: HsnUpdate,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing HSN code."""
    hsn = await service.update(hsn_id, **payload.model_dump())
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=hsn.id,
        description=f"Updated HSN code {hsn.code!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{hsn_id}/activate", summary="Activate an HSN code")
async def activate_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set an HSN code's status to active."""
    hsn = await service.activate(hsn_id)
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=hsn.id,
        description=f"Activated HSN code {hsn.code!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{hsn_id}/deactivate", summary="Deactivate an HSN code")
async def deactivate_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set an HSN code's status to inactive."""
    hsn = await service.deactivate(hsn_id)
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=hsn.id,
        description=f"Deactivated HSN code {hsn.code!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{hsn_id}", summary="Delete an HSN code")
async def delete_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete an HSN code."""
    await service.delete(hsn_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=hsn_id,
        description="Deleted HSN code.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
