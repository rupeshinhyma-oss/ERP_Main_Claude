"""
Product Category Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so the Categories
list page receives real-time updates from other users without a manual
refresh. Uses ``module:categories`` (entity="category"), registered in
``app.events.channels.MODULE_CHANNEL_PERMISSIONS`` -> ``category.view``.
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
from app.masters.product_categories.dependencies import get_product_category_service
from app.masters.product_categories.schemas import (
    ImportSummaryRead,
    ProductCategoryCreate,
    ProductCategoryLookupRead,
    ProductCategoryRead,
    ProductCategoryUpdate,
)
from app.masters.product_categories.service import ProductCategoryService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/product-categories", tags=["Masters - Product Categories"])


async def _publish_category_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    category_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """Commit ``db``, then publish a ``category.*`` live event on ``module:categories``."""
    await dispatcher.publish_lifecycle_event(
        db,
        module="categories",
        entity="category",
        entity_id=category_id,
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
    """Shared helper: record a product category action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.product_categories",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="ProductCategory",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a product category")
async def create_category(
    payload: ProductCategoryCreate,
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new product category."""
    category = await service.create(**payload.model_dump())
    data = ProductCategoryRead.model_validate(category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=category.id,
        description=f"Created product category {category.name!r} ({category.code}).",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="category.created",
        category_id=category.id,
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List product categories")
async def list_categories(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: ProductCategoryService = Depends(get_product_category_service),
    _current_user: CurrentUser = Depends(require_permission("category.view")),
) -> dict:
    """List product categories, with search/sort/filter/pagination."""
    categories, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [ProductCategoryRead.model_validate(c).model_dump(mode="json") for c in categories]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get(
    "/lookup",
    summary="Lightweight id/name lookup for product categories (no category.view required)",
)
async def lookup_categories(
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Return every active category as bare ``{id, name}`` pairs.

    Deliberately gated on "is logged in" only, NOT ``category.view``.
    Other modules (e.g. Buyers, Shipment Planning) store category IDs
    on their own records and need to resolve those IDs to display names
    for a user who has permission to view *that* module's data, even if
    the admin never separately granted them access to the Categories
    master module itself. Module permissions control whether a user can
    open/manage the Categories module -- they should never control
    whether a name a user is already entitled to see (because it's
    referenced on a record they can see) renders correctly.

    Without this, ``category.view``-less users see raw category UUIDs
    on pages like Buyers instead of names, because the page's own
    lookup call to the full ``GET /masters/product-categories`` list
    gets rejected with 403 and silently degrades to an empty list.
    """
    categories = await service.list_all_cached()
    data = [ProductCategoryLookupRead.model_validate(c).model_dump(mode="json") for c in categories]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/export", summary="Export product categories to CSV/Excel")
async def export_categories(
    request: Request,
    format: str = "csv",
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every product category as a CSV or XLSX file."""
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
        description=f"Exported product categories as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    filename = f"product_categories.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import product categories from CSV/Excel")
async def import_categories(
    request: Request,
    file: UploadFile = File(...),
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import product categories from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported product categories: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{category_id}", summary="Get a product category")
async def get_category(
    category_id: uuid.UUID,
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch a single product category by ID (authenticated lookup)."""
    category = await service.get_by_id_or_raise(category_id)
    data = ProductCategoryRead.model_validate(category).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{category_id}", summary="Update a product category")
async def update_category(
    category_id: uuid.UUID,
    payload: ProductCategoryUpdate,
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing product category."""
    category = await service.update(category_id, **payload.model_dump())
    data = ProductCategoryRead.model_validate(category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=category.id,
        description=f"Updated product category {category.name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="category.updated",
        category_id=category.id,
        user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{category_id}/activate", summary="Activate a product category")
async def activate_category(
    category_id: uuid.UUID,
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a product category's status to active."""
    category = await service.activate(category_id)
    data = ProductCategoryRead.model_validate(category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=category.id,
        description=f"Activated product category {category.name!r}.",
    )
    await _publish_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="category.updated",
        category_id=category.id,
        user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{category_id}/deactivate", summary="Deactivate a product category")
async def deactivate_category(
    category_id: uuid.UUID,
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a product category's status to inactive."""
    category = await service.deactivate(category_id)
    data = ProductCategoryRead.model_validate(category).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=category.id,
        description=f"Deactivated product category {category.name!r}.",
    )
    await _publish_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="category.updated",
        category_id=category.id,
        user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{category_id}", summary="Delete a product category")
async def delete_category(
    category_id: uuid.UUID,
    request: Request,
    service: ProductCategoryService = Depends(get_product_category_service),
    current_user: CurrentUser = Depends(require_permission("category.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a product category."""
    await service.delete(category_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=category_id,
        description="Deleted product category.",
    )
    await _publish_category_event(
        db=db,
        dispatcher=dispatcher,
        event_type="category.deleted",
        category_id=category_id,
        user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)