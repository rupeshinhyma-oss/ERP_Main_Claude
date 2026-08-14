"""
Product Sub-Category Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the Sub
Categories list page receives real-time updates from other users without
a manual refresh. Uses ``module:subcategories`` (entity="subcategory"),
registered in ``app.events.channels.MODULE_CHANNEL_PERMISSIONS`` ->
``subcategory.read``.
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
from app.masters.product_sub_categories.dependencies import get_product_sub_category_service
from app.masters.product_sub_categories.schemas import (
    ImportSummaryRead,
    ProductSubCategoryCreate,
    ProductSubCategoryRead,
    ProductSubCategoryUpdate,
)
from app.masters.product_sub_categories.service import ProductSubCategoryService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/product-sub-categories", tags=["Masters - Product Sub-Categories"])


async def _publish_sub_category_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    sub_category_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``subcategory.*`` live event on ``module:subcategories``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="subcategories",
        entity="subcategory",
        entity_id=sub_category_id,
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
    """Shared helper: record a product sub-category action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.product_sub_categories",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="ProductSubCategory",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a product sub-category")
async def create_sub_category(
    payload: ProductSubCategoryCreate,
    request: Request,
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new product sub-category."""
    sub_category = await service.create(**payload.model_dump())
    data = ProductSubCategoryRead.model_validate(sub_category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=sub_category.id,
        description=f"Created product sub-category {sub_category.name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_sub_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="subcategory.created",
        sub_category_id=sub_category.id,
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List product sub-categories")
async def list_sub_categories(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    _current_user: CurrentUser = Depends(require_permission("subcategory.read")),
) -> dict:
    """List product sub-categories, with search/sort/filter/pagination."""
    sub_categories, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [ProductSubCategoryRead.model_validate(c).model_dump(mode="json") for c in sub_categories]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export product sub-categories to CSV/Excel")
async def export_sub_categories(
    request: Request,
    format: str = "csv",
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.read")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every product sub-category as a CSV or XLSX file."""
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
        description=f"Exported product sub-categories as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"product_sub_categories.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import product sub-categories from CSV/Excel")
async def import_sub_categories(
    request: Request,
    file: UploadFile = File(...),
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import product sub-categories from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported product sub-categories: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{sub_category_id}", summary="Get a product sub-category")
async def get_sub_category(
    sub_category_id: uuid.UUID,
    request: Request,
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    _current_user: CurrentUser = Depends(require_permission("subcategory.read")),
) -> dict:
    """Fetch a single product sub-category by ID."""
    sub_category = await service.get_by_id_or_raise(sub_category_id)
    data = ProductSubCategoryRead.model_validate(sub_category).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{sub_category_id}", summary="Update a product sub-category")
async def update_sub_category(
    sub_category_id: uuid.UUID,
    payload: ProductSubCategoryUpdate,
    request: Request,
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing product sub-category."""
    sub_category = await service.update(sub_category_id, **payload.model_dump())
    data = ProductSubCategoryRead.model_validate(sub_category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=sub_category.id,
        description=f"Updated product sub-category {sub_category.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_sub_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="subcategory.updated",
        sub_category_id=sub_category.id,
        user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{sub_category_id}/activate", summary="Activate a product sub-category")
async def activate_sub_category(
    sub_category_id: uuid.UUID,
    request: Request,
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a product sub-category's status to active."""
    sub_category = await service.activate(sub_category_id)
    data = ProductSubCategoryRead.model_validate(sub_category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=sub_category.id,
        description=f"Activated product sub-category {sub_category.name!r}.",
    )
    await _publish_sub_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="subcategory.updated",
        sub_category_id=sub_category.id,
        user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{sub_category_id}/deactivate", summary="Deactivate a product sub-category")
async def deactivate_sub_category(
    sub_category_id: uuid.UUID,
    request: Request,
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a product sub-category's status to inactive."""
    sub_category = await service.deactivate(sub_category_id)
    data = ProductSubCategoryRead.model_validate(sub_category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=sub_category.id,
        description=f"Deactivated product sub-category {sub_category.name!r}.",
    )
    await _publish_sub_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="subcategory.updated",
        sub_category_id=sub_category.id,
        user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{sub_category_id}", summary="Delete a product sub-category")
async def delete_sub_category(
    sub_category_id: uuid.UUID,
    request: Request,
    service: ProductSubCategoryService = Depends(get_product_sub_category_service),
    current_user: CurrentUser = Depends(require_permission("subcategory.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a product sub-category."""
    await service.delete(sub_category_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=sub_category_id,
        description="Deleted product sub-category.",
    )
    await _publish_sub_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="subcategory.deleted",
        sub_category_id=sub_category_id,
        user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)