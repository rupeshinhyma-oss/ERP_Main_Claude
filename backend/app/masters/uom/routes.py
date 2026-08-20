"""
Uom Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the Uom list
page receives real-time updates from other users without a full-page reload.
Uses the shared global WebSocket infrastructure via ``module:uom``.
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
from app.masters.uom.dependencies import get_uom_service
from app.masters.uom.schemas import UomRead, UomCreate, UomUpdate, ImportSummaryRead
from app.masters.uom.service import UomService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/uom", tags=["Masters - UoM"])


async def _publish_uom_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    uom_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``uom.*`` live event on ``module:uom``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="uom",
        entity="uom",
        entity_id=uom_id,
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
    """Shared helper: record a uom action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.uom",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Uom",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a uom")
async def create_uom(
    payload: UomCreate,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new uom."""
    uom = await service.create(**payload.model_dump())
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=uom.id,
        description=f"Created uom {uom.name!r} ({uom.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_uom_event(
        db=db, dispatcher=dispatcher, event_type="uom.created",
        uom_id=uom.id, user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List uoms")
async def list_uoms(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: UomService = Depends(get_uom_service),
    _current_user: CurrentUser = Depends(require_permission("uom.view")),
) -> dict:
    """List uoms, with search/sort/filter/pagination."""
    uoms, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [UomRead.model_validate(b).model_dump(mode="json") for b in uoms]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export uoms to CSV/Excel")
async def export_uoms(
    request: Request,
    format: str = "csv",
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every uom as a CSV or XLSX file."""
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.EXPORT,
        actor=current_user, entity_id="bulk",
        description=f"Exported uoms as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"uoms.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import uoms from CSV/Excel")
async def import_uoms(
    request: Request,
    file: UploadFile = File(...),
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import uoms from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.IMPORT,
        actor=current_user, entity_id="bulk",
        description=f"Imported uoms: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{uom_id}", summary="Get a uom")
async def get_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    _current_user: CurrentUser = Depends(require_permission("uom.view")),
) -> dict:
    """Fetch a single uom by ID."""
    uom = await service.get_by_id_or_raise(uom_id)
    data = UomRead.model_validate(uom).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{uom_id}", summary="Update a uom")
async def update_uom(
    uom_id: uuid.UUID,
    payload: UomUpdate,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing uom."""
    uom = await service.update(uom_id, **payload.model_dump())
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=uom.id,
        description=f"Updated uom {uom.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_uom_event(
        db=db, dispatcher=dispatcher, event_type="uom.updated",
        uom_id=uom.id, user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{uom_id}/activate", summary="Activate a uom")
async def activate_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a uom's status to active."""
    uom = await service.activate(uom_id)
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=uom.id,
        description=f"Activated uom {uom.name!r}.",
    )
    await _publish_uom_event(
        db=db, dispatcher=dispatcher, event_type="uom.updated",
        uom_id=uom.id, user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{uom_id}/deactivate", summary="Deactivate a uom")
async def deactivate_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a uom's status to inactive."""
    uom = await service.deactivate(uom_id)
    data = UomRead.model_validate(uom).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=uom.id,
        description=f"Deactivated uom {uom.name!r}.",
    )
    await _publish_uom_event(
        db=db, dispatcher=dispatcher, event_type="uom.updated",
        uom_id=uom.id, user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{uom_id}", summary="Delete a uom")
async def delete_uom(
    uom_id: uuid.UUID,
    request: Request,
    service: UomService = Depends(get_uom_service),
    current_user: CurrentUser = Depends(require_permission("uom.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a uom."""
    await service.delete(uom_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE,
        actor=current_user, entity_id=uom_id,
        description="Deleted uom.",
    )
    await _publish_uom_event(
        db=db, dispatcher=dispatcher, event_type="uom.deleted",
        uom_id=uom_id, user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)