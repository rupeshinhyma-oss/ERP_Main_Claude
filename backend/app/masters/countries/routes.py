"""Country Routes. Standard CRUD + activate/deactivate + import/export, with audit logging."""

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
from app.masters.countries.dependencies import get_country_service
from app.masters.countries.schemas import CountryCreate, CountryRead, CountryUpdate, ImportSummaryRead
from app.masters.countries.service import CountryService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/countries", tags=["Masters - Countries"])


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
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List countries")
async def list_countries(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: CountryService = Depends(get_country_service),
    _current_user: CurrentUser = Depends(require_permission("country.read")),
) -> dict:
    """List countries, with search/sort/filter/pagination."""
    countries, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [CountryRead.model_validate(c).model_dump(mode="json") for c in countries]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export countries to CSV/Excel")
async def export_countries(
    request: Request,
    format: str = "csv",
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every country as a CSV or XLSX file."""
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
        description=f"Exported countries as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"countries.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import countries from CSV/Excel")
async def import_countries(
    request: Request,
    file: UploadFile = File(...),
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import countries from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported countries: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{country_id}", summary="Get a country")
async def get_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    _current_user: CurrentUser = Depends(require_permission("country.read")),
) -> dict:
    """Fetch a single country by ID."""
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
) -> dict:
    """Update an existing country."""
    country = await service.update(country_id, **payload.model_dump())
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=country.id,
        description=f"Updated country {country.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{country_id}/activate", summary="Activate a country")
async def activate_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a country's status to active."""
    country = await service.activate(country_id)
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=country.id,
        description=f"Activated country {country.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{country_id}/deactivate", summary="Deactivate a country")
async def deactivate_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a country's status to inactive."""
    country = await service.deactivate(country_id)
    data = CountryRead.model_validate(country).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=country.id,
        description=f"Deactivated country {country.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{country_id}", summary="Delete a country")
async def delete_country(
    country_id: uuid.UUID,
    request: Request,
    service: CountryService = Depends(get_country_service),
    current_user: CurrentUser = Depends(require_permission("country.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a country."""
    await service.delete(country_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=country_id,
        description="Deleted country.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
