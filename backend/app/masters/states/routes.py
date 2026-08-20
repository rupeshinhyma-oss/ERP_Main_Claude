"""
State Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the State list
page receives real-time updates from other users without a full-page reload.
Uses the shared global WebSocket infrastructure via ``module:states``.
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
from app.masters.states.dependencies import get_state_service
from app.masters.states.schemas import StateRead, StateCreate, StateUpdate, ImportSummaryRead
from app.masters.states.service import StateService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/states", tags=["Masters - States"])


async def _publish_state_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    state_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``state.*`` live event on ``module:states``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="states",
        entity="state",
        entity_id=state_id,
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
    """Shared helper: record a state action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.states",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="State",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a state")
async def create_state(
    payload: StateCreate,
    request: Request,
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new state."""
    state = await service.create(**payload.model_dump())
    data = StateRead.model_validate(state).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=state.id,
        description=f"Created state {state.name!r} ({state.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_state_event(
        db=db, dispatcher=dispatcher, event_type="state.created",
        state_id=state.id, user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List states")
async def list_states(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: StateService = Depends(get_state_service),
    _current_user: CurrentUser = Depends(require_permission("state.view")),
) -> dict:
    """List states, with search/sort/filter/pagination."""
    states, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [StateRead.model_validate(b).model_dump(mode="json") for b in states]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export states to CSV/Excel")
async def export_states(
    request: Request,
    format: str = "csv",
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every state as a CSV or XLSX file."""
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.EXPORT,
        actor=current_user, entity_id="bulk",
        description=f"Exported states as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"states.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import states from CSV/Excel")
async def import_states(
    request: Request,
    file: UploadFile = File(...),
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import states from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.IMPORT,
        actor=current_user, entity_id="bulk",
        description=f"Imported states: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{state_id}", summary="Get a state")
async def get_state(
    state_id: uuid.UUID,
    request: Request,
    service: StateService = Depends(get_state_service),
    _current_user: CurrentUser = Depends(require_permission("state.view")),
) -> dict:
    """Fetch a single state by ID."""
    state = await service.get_by_id_or_raise(state_id)
    data = StateRead.model_validate(state).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{state_id}", summary="Update a state")
async def update_state(
    state_id: uuid.UUID,
    payload: StateUpdate,
    request: Request,
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing state."""
    state = await service.update(state_id, **payload.model_dump())
    data = StateRead.model_validate(state).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=state.id,
        description=f"Updated state {state.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_state_event(
        db=db, dispatcher=dispatcher, event_type="state.updated",
        state_id=state.id, user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{state_id}/activate", summary="Activate a state")
async def activate_state(
    state_id: uuid.UUID,
    request: Request,
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a state's status to active."""
    state = await service.activate(state_id)
    data = StateRead.model_validate(state).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=state.id,
        description=f"Activated state {state.name!r}.",
    )
    await _publish_state_event(
        db=db, dispatcher=dispatcher, event_type="state.updated",
        state_id=state.id, user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{state_id}/deactivate", summary="Deactivate a state")
async def deactivate_state(
    state_id: uuid.UUID,
    request: Request,
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a state's status to inactive."""
    state = await service.deactivate(state_id)
    data = StateRead.model_validate(state).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=state.id,
        description=f"Deactivated state {state.name!r}.",
    )
    await _publish_state_event(
        db=db, dispatcher=dispatcher, event_type="state.updated",
        state_id=state.id, user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{state_id}", summary="Delete a state")
async def delete_state(
    state_id: uuid.UUID,
    request: Request,
    service: StateService = Depends(get_state_service),
    current_user: CurrentUser = Depends(require_permission("state.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a state."""
    await service.delete(state_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE,
        actor=current_user, entity_id=state_id,
        description="Deleted state.",
    )
    await _publish_state_event(
        db=db, dispatcher=dispatcher, event_type="state.deleted",
        state_id=state_id, user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)