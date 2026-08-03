"""City Routes. Standard CRUD + activate/deactivate + import/export, with audit logging."""

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
from app.masters.cities.dependencies import get_city_service
from app.masters.cities.schemas import CityCreate, CityRead, CityUpdate, ImportSummaryRead
from app.masters.cities.service import CityService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/cities", tags=["Masters - Cities"])


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
    """Shared helper: record a city action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.cities",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="City",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a city")
async def create_city(
    payload: CityCreate,
    request: Request,
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new city."""
    city = await service.create(**payload.model_dump())
    data = CityRead.model_validate(city).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=city.id,
        description=f"Created city {city.name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List cities")
async def list_cities(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: CityService = Depends(get_city_service),
    _current_user: CurrentUser = Depends(require_permission("city.read")),
) -> dict:
    """List cities, with search/sort/filter/pagination."""
    cities, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [CityRead.model_validate(c).model_dump(mode="json") for c in cities]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export cities to CSV/Excel")
async def export_cities(
    request: Request,
    format: str = "csv",
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every city as a CSV or XLSX file."""
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
        description=f"Exported cities as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"cities.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import cities from CSV/Excel")
async def import_cities(
    request: Request,
    file: UploadFile = File(...),
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import cities from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported cities: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{city_id}", summary="Get a city")
async def get_city(
    city_id: uuid.UUID,
    request: Request,
    service: CityService = Depends(get_city_service),
    _current_user: CurrentUser = Depends(require_permission("city.read")),
) -> dict:
    """Fetch a single city by ID."""
    city = await service.get_by_id_or_raise(city_id)
    data = CityRead.model_validate(city).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{city_id}", summary="Update a city")
async def update_city(
    city_id: uuid.UUID,
    payload: CityUpdate,
    request: Request,
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing city."""
    city = await service.update(city_id, **payload.model_dump())
    data = CityRead.model_validate(city).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=city.id,
        description=f"Updated city {city.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{city_id}/activate", summary="Activate a city")
async def activate_city(
    city_id: uuid.UUID,
    request: Request,
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a city's status to active."""
    city = await service.activate(city_id)
    data = CityRead.model_validate(city).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=city.id,
        description=f"Activated city {city.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{city_id}/deactivate", summary="Deactivate a city")
async def deactivate_city(
    city_id: uuid.UUID,
    request: Request,
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a city's status to inactive."""
    city = await service.deactivate(city_id)
    data = CityRead.model_validate(city).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=city.id,
        description=f"Deactivated city {city.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{city_id}", summary="Delete a city")
async def delete_city(
    city_id: uuid.UUID,
    request: Request,
    service: CityService = Depends(get_city_service),
    current_user: CurrentUser = Depends(require_permission("city.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a city."""
    await service.delete(city_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=city_id,
        description="Deleted city.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
