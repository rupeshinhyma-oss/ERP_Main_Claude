"""
Country Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the Country list
page receives real-time updates from other users without a full-page reload.
Uses the shared global WebSocket infrastructure via ``module:countries``.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, File, Request, UploadFile, status
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.events.dependencies import get_event_dispatcher
from app.events.dispatcher import EventDispatcher
from app.masters.countries.dependencies import get_country_service
from app.masters.countries.schemas import CountryRead, CountryCreate, CountryUpdate, ImportSummaryRead
from app.masters.countries.service import CountryService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/countries", tags=["Masters - Countries"])


async def _publish_country_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    country_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``country.*`` live event on ``module:countries``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="countries",
        entity="country",
        entity_id=country_id,
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
    """Shared helper: record a country action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.countries",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Country",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a country")
async def create_country(
    payload: CountryCreate,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new country."""
    country = await service.create(**payload.model_dump())
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=country.id,
        description=f"Created country {country.name!r} ({country.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_country_event(
        db=db, dispatcher=dispatcher, event_type="country.created",
        country_id=country.id, user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List countrys")
async def list_countrys(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: CountryService = Depends(get_country_service),
    _current_user: CurrentUser = Depends(require_permission("country.view")),
) -> dict:
    """List countrys, with search/sort/filter/pagination."""
    countrys, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [CountryRead.model_validate(b).model_dump(mode="json") for b in countrys]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export countrys to CSV/Excel")
async def export_countrys(
    request: Request,
    format: str = "csv",
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every country as a CSV or XLSX file."""
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.EXPORT,
        actor=current_user, entity_id="bulk",
        description=f"Exported countrys as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"countrys.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import countrys from CSV/Excel")
async def import_countrys(
    request: Request,
    file: UploadFile = File(...),
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import countrys from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.IMPORT,
        actor=current_user, entity_id="bulk",
        description=f"Imported countrys: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{country_id}", summary="Get a country")
async def get_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch a single country by ID (authenticated lookup)."""
    country = await service.get_by_id_or_raise(country_id)
    data = CountryRead.model_validate(country).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{country_id}", summary="Update a country")
async def update_country(
    country_id: uuid.UUID,
    payload: CountryUpdate,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing country."""
    country = await service.update(country_id, **payload.model_dump())
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=country.id,
        description=f"Updated country {country.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_country_event(
        db=db, dispatcher=dispatcher, event_type="country.updated",
        country_id=country.id, user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{country_id}/activate", summary="Activate a country")
async def activate_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a country's status to active."""
    country = await service.activate(country_id)
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=country.id,
        description=f"Activated country {country.name!r}.",
    )
    await _publish_country_event(
        db=db, dispatcher=dispatcher, event_type="country.updated",
        country_id=country.id, user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{country_id}/deactivate", summary="Deactivate a country")
async def deactivate_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a country's status to inactive."""
    country = await service.deactivate(country_id)
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=country.id,
        description=f"Deactivated country {country.name!r}.",
    )
    await _publish_country_event(
        db=db, dispatcher=dispatcher, event_type="country.updated",
        country_id=country.id, user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{country_id}", summary="Delete a country")
async def delete_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a country."""
    await service.delete(country_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE,
        actor=current_user, entity_id=country_id,
        description="Deleted country.",
    )
    await _publish_country_event(
        db=db, dispatcher=dispatcher, event_type="country.deleted",
        country_id=country_id, user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)