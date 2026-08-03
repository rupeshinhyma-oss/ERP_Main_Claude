"""Currency Routes. Standard CRUD + activate/deactivate + import/export, with audit logging."""

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
from app.masters.currencies.dependencies import get_currency_service
from app.masters.currencies.schemas import CurrencyCreate, CurrencyRead, CurrencyUpdate, ImportSummaryRead
from app.masters.currencies.service import CurrencyService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/currencies", tags=["Masters - Currencies"])


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
    """Shared helper: record a currency action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.currencies",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Currency",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a currency")
async def create_currency(
    payload: CurrencyCreate,
    request: Request,
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new currency."""
    currency = await service.create(**payload.model_dump())
    data = CurrencyRead.model_validate(currency).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=currency.id,
        description=f"Created currency {currency.name!r} ({currency.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List currencies")
async def list_currencies(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: CurrencyService = Depends(get_currency_service),
    _current_user: CurrentUser = Depends(require_permission("currency.read")),
) -> dict:
    """List currencies, with search/sort/filter/pagination."""
    currencies, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [CurrencyRead.model_validate(c).model_dump(mode="json") for c in currencies]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export currencies to CSV/Excel")
async def export_currencies(
    request: Request,
    format: str = "csv",
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every currency as a CSV or XLSX file."""
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
        description=f"Exported currencies as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"currencies.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import currencies from CSV/Excel")
async def import_currencies(
    request: Request,
    file: UploadFile = File(...),
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import currencies from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported currencies: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{currency_id}", summary="Get a currency")
async def get_currency(
    currency_id: uuid.UUID,
    request: Request,
    service: CurrencyService = Depends(get_currency_service),
    _current_user: CurrentUser = Depends(require_permission("currency.read")),
) -> dict:
    """Fetch a single currency by ID."""
    currency = await service.get_by_id_or_raise(currency_id)
    data = CurrencyRead.model_validate(currency).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{currency_id}", summary="Update a currency")
async def update_currency(
    currency_id: uuid.UUID,
    payload: CurrencyUpdate,
    request: Request,
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing currency."""
    currency = await service.update(currency_id, **payload.model_dump())
    data = CurrencyRead.model_validate(currency).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=currency.id,
        description=f"Updated currency {currency.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{currency_id}/activate", summary="Activate a currency")
async def activate_currency(
    currency_id: uuid.UUID,
    request: Request,
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a currency's status to active."""
    currency = await service.activate(currency_id)
    data = CurrencyRead.model_validate(currency).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=currency.id,
        description=f"Activated currency {currency.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{currency_id}/deactivate", summary="Deactivate a currency")
async def deactivate_currency(
    currency_id: uuid.UUID,
    request: Request,
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a currency's status to inactive."""
    currency = await service.deactivate(currency_id)
    data = CurrencyRead.model_validate(currency).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=currency.id,
        description=f"Deactivated currency {currency.name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{currency_id}", summary="Delete a currency")
async def delete_currency(
    currency_id: uuid.UUID,
    request: Request,
    service: CurrencyService = Depends(get_currency_service),
    current_user: CurrentUser = Depends(require_permission("currency.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Soft-delete a currency."""
    await service.delete(currency_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=currency_id,
        description="Deleted currency.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
