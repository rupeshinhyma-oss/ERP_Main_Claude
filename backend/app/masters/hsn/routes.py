"""
Hsn Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the Hsn list
page receives real-time updates from other users without a full-page reload.
Uses the shared global WebSocket infrastructure via ``module:hsn``.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.events.dependencies import get_event_dispatcher
from app.events.dispatcher import EventDispatcher
from app.masters.hsn.dependencies import get_hsn_service
from app.masters.hsn.schemas import HsnRead, HsnCreate, HsnUpdate, ImportSummaryRead
from app.masters.hsn.service import HsnService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/hsn", tags=["Masters - HSN"])


async def _publish_hsn_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    hsn_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``hsn.*`` live event on ``module:hsn``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="hsn",
        entity="hsn",
        entity_id=hsn_id,
        event_type=event_type,
        version=None,
        user_id=user_id,
        changes=changes,
    )


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
    """Shared helper: record a hsn action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.hsn",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Hsn",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a hsn")
async def create_hsn(
    payload: HsnCreate,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new hsn."""
    hsn = await service.create(**payload.model_dump())
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=hsn.id,
        description=f"Created hsn {hsn.code!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_hsn_event(
        db=db, dispatcher=dispatcher, event_type="hsn.created",
        hsn_id=hsn.id, user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List hsns")
async def list_hsns(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: HsnService = Depends(get_hsn_service),
    _current_user: CurrentUser = Depends(require_permission("hsn.read")),
) -> dict:
    """List hsns, with search/sort/filter/pagination."""
    hsns, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [HsnRead.model_validate(b).model_dump(mode="json") for b in hsns]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export hsns to CSV/Excel")
async def export_hsns(
    request: Request,
    format: str = "csv",
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every hsn as a CSV or XLSX file."""
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.EXPORT,
        actor=current_user, entity_id="bulk",
        description=f"Exported hsns as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"hsns.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import hsns from CSV/Excel")
async def import_hsns(
    request: Request,
    file: UploadFile = File(...),
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import hsns from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.IMPORT,
        actor=current_user, entity_id="bulk",
        description=f"Imported hsns: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{hsn_id}", summary="Get a hsn")
async def get_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    _current_user: CurrentUser = Depends(require_permission("hsn.read")),
) -> dict:
    """Fetch a single hsn by ID."""
    hsn = await service.get_by_id_or_raise(hsn_id)
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{hsn_id}", summary="Update a hsn")
async def update_hsn(
    hsn_id: uuid.UUID,
    payload: HsnUpdate,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing hsn."""
    hsn = await service.update(hsn_id, **payload.model_dump())
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=hsn.id,
        description=f"Updated hsn {hsn.code!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_hsn_event(
        db=db, dispatcher=dispatcher, event_type="hsn.updated",
        hsn_id=hsn.id, user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{hsn_id}/activate", summary="Activate a hsn")
async def activate_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a hsn's status to active."""
    hsn = await service.activate(hsn_id)
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=hsn.id,
        description=f"Activated hsn {hsn.code!r}.",
    )
    await _publish_hsn_event(
        db=db, dispatcher=dispatcher, event_type="hsn.updated",
        hsn_id=hsn.id, user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{hsn_id}/deactivate", summary="Deactivate a hsn")
async def deactivate_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a hsn's status to inactive."""
    hsn = await service.deactivate(hsn_id)
    data = HsnRead.model_validate(hsn).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=hsn.id,
        description=f"Deactivated hsn {hsn.code!r}.",
    )
    await _publish_hsn_event(
        db=db, dispatcher=dispatcher, event_type="hsn.updated",
        hsn_id=hsn.id, user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{hsn_id}", summary="Delete a hsn")
async def delete_hsn(
    hsn_id: uuid.UUID,
    request: Request,
    service: HsnService = Depends(get_hsn_service),
    current_user: CurrentUser = Depends(require_permission("hsn.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a hsn."""
    await service.delete(hsn_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE,
        actor=current_user, entity_id=hsn_id,
        description="Deleted hsn.",
    )
    await _publish_hsn_event(
        db=db, dispatcher=dispatcher, event_type="hsn.deleted",
        hsn_id=hsn_id, user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)