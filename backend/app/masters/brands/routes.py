"""
Brand Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the Brand list
page receives real-time updates from other users without a full-page reload.
Uses the shared global WebSocket infrastructure via ``module:brands``.
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
from app.masters.brands.dependencies import get_brand_service
from app.masters.brands.schemas import BrandRead, BrandCreate, BrandUpdate, ImportSummaryRead
from app.masters.brands.service import BrandService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/brands", tags=["Masters - Brands"])


async def _publish_brand_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    brand_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``brand.*`` live event on ``module:brands``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="brands",
        entity="brand",
        entity_id=brand_id,
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
    """Shared helper: record a brand action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.brands",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Brand",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a brand")
async def create_brand(
    payload: BrandCreate,
    request: Request,
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new brand."""
    brand = await service.create(**payload.model_dump())
    data = BrandRead.model_validate(brand).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=brand.id,
        description=f"Created brand {brand.name!r} ({brand.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_brand_event(
        db=db, dispatcher=dispatcher, event_type="brand.created",
        brand_id=brand.id, user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List brands")
async def list_brands(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: BrandService = Depends(get_brand_service),
    _current_user: CurrentUser = Depends(require_permission("brand.view")),
) -> dict:
    """List brands, with search/sort/filter/pagination."""
    brands, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [BrandRead.model_validate(b).model_dump(mode="json") for b in brands]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export brands to CSV/Excel")
async def export_brands(
    request: Request,
    format: str = "csv",
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every brand as a CSV or XLSX file."""
    file_format = format.lower()
    if file_format not in ("csv", "xlsx"):
        file_format = "csv"
    content = await service.export_file(file_format)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.EXPORT,
        actor=current_user, entity_id="bulk",
        description=f"Exported brands as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"brands.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import brands from CSV/Excel")
async def import_brands(
    request: Request,
    file: UploadFile = File(...),
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import brands from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.IMPORT,
        actor=current_user, entity_id="bulk",
        description=f"Imported brands: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{brand_id}", summary="Get a brand")
async def get_brand(
    brand_id: uuid.UUID,
    request: Request,
    service: BrandService = Depends(get_brand_service),
    _current_user: CurrentUser = Depends(require_permission("brand.view")),
) -> dict:
    """Fetch a single brand by ID."""
    brand = await service.get_by_id_or_raise(brand_id)
    data = BrandRead.model_validate(brand).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{brand_id}", summary="Update a brand")
async def update_brand(
    brand_id: uuid.UUID,
    payload: BrandUpdate,
    request: Request,
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing brand."""
    brand = await service.update(brand_id, **payload.model_dump())
    data = BrandRead.model_validate(brand).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=brand.id,
        description=f"Updated brand {brand.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_brand_event(
        db=db, dispatcher=dispatcher, event_type="brand.updated",
        brand_id=brand.id, user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{brand_id}/activate", summary="Activate a brand")
async def activate_brand(
    brand_id: uuid.UUID,
    request: Request,
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a brand's status to active."""
    brand = await service.activate(brand_id)
    data = BrandRead.model_validate(brand).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=brand.id,
        description=f"Activated brand {brand.name!r}.",
    )
    await _publish_brand_event(
        db=db, dispatcher=dispatcher, event_type="brand.updated",
        brand_id=brand.id, user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{brand_id}/deactivate", summary="Deactivate a brand")
async def deactivate_brand(
    brand_id: uuid.UUID,
    request: Request,
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a brand's status to inactive."""
    brand = await service.deactivate(brand_id)
    data = BrandRead.model_validate(brand).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.UPDATE,
        actor=current_user, entity_id=brand.id,
        description=f"Deactivated brand {brand.name!r}.",
    )
    await _publish_brand_event(
        db=db, dispatcher=dispatcher, event_type="brand.updated",
        brand_id=brand.id, user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{brand_id}", summary="Delete a brand")
async def delete_brand(
    brand_id: uuid.UUID,
    request: Request,
    service: BrandService = Depends(get_brand_service),
    current_user: CurrentUser = Depends(require_permission("brand.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a brand."""
    await service.delete(brand_id)
    await _record_action(
        audit_service=audit_service, request=request, action=AuditAction.DELETE,
        actor=current_user, entity_id=brand_id,
        description="Deleted brand.",
    )
    await _publish_brand_event(
        db=db, dispatcher=dispatcher, event_type="brand.deleted",
        brand_id=brand_id, user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)