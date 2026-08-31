"""Product Routes. Standard CRUD + activate/deactivate + import/export, with audit logging.

Phase 9: added live event publishing on every mutation so ProductMaster and
ProductGallery pages receive real-time updates. Uses the shared ``module:inventory``
channel (entity="product") that ``app.events.channels`` already maps to
``product.view`` -- matching the existing frontend ENTITY_TO_MODULE_CHANNEL
entry for ``"product" -> moduleChannel("inventory")``.
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
from app.common.storage import save_uploaded_file
from app.core.logging import get_logger
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.events.dependencies import get_event_dispatcher
from app.events.dispatcher import EventDispatcher
from app.masters.products.dependencies import get_product_service
from app.masters.products.schemas import ImportSummaryRead, ProductCreate, ProductRead, ProductUpdate
from app.masters.products.service import ProductService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/products", tags=["Masters - Products"])
logger = get_logger(__name__)


async def _publish_product_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    product_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """
    Commit ``db``, then publish a ``product.*`` live event on ``module:inventory``.

    Phase 9: Products use entity="product" which the frontend
    ENTITY_TO_MODULE_CHANNEL table already maps to moduleChannel("inventory"),
    matching the MODULE_CHANNEL_PERMISSIONS entry ``module:inventory -> product.view``.
    No version field on Product yet -- passed as None (liveEntityStore handles
    missing versions by skipping the staleness check, still applying the event).
    """
    await dispatcher.publish_lifecycle_event(
        db,
        module="inventory",
        entity="product",
        entity_id=product_id,
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
    """Shared helper: record a product action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="masters.products",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Product",
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a product")
async def create_product(
    payload: ProductCreate,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new product."""
    product = await service.create(**payload.model_dump())
    data = ProductRead.model_validate(product).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=product.id,
        description=f"Created product {product.product_name!r} ({product.product_code}).",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_product_event(
        db=db,
        dispatcher=dispatcher,
        event_type="product.created",
        product_id=product.id,
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List products")
async def list_products(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: ProductService = Depends(get_product_service),
    _current_user: CurrentUser = Depends(require_permission("product.view")),
) -> dict:
    """List products, with search/sort/filter/pagination."""
    products, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()

    data = [ProductRead.model_validate(p) for p in products]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export products to CSV/Excel")
async def export_products(
    request: Request,
    format: str = "csv",
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every product as a CSV or XLSX file."""
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
        description=f"Exported products as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    from datetime import datetime, timezone
    today_str = datetime.now(timezone.utc).strftime("%d-%m-%Y")
    filename = f"Product_{today_str}.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import products from CSV/Excel")
async def import_products(
    request: Request,
    file: UploadFile = File(...),
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import products from an uploaded CSV/XLSX file, validating every row."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported products: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/upload-image", summary="Upload product image to Supabase Storage")
async def upload_product_image(
    file: UploadFile = File(...),
    _current_user: CurrentUser = Depends(require_permission("product.create")),
) -> dict:
    """
    Upload a product image to Supabase Storage (bucket 'product-images'),
    falling back to local disk (uploads/products/) if Supabase is unavailable.
    """
    content = await file.read()
    image_url, _ = await save_uploaded_file(
        content=content,
        original_filename=file.filename or "product_image.jpg",
        bucket="product-images",
        local_subfolder="products",
        content_type=file.content_type,
    )
    return {"success": True, "data": {"url": image_url}}


@router.get("/{product_id}", summary="Get a product")
async def get_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch a single product by ID (authenticated lookup)."""
    product = await service.get_by_id_or_raise(product_id)
    data = ProductRead.model_validate(product).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{product_id}", summary="Update a product")
async def update_product(
    product_id: uuid.UUID,
    payload: ProductUpdate,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    product = await service.update(product_id, **payload.model_dump(exclude_unset=True))
    data = ProductRead.model_validate(product).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=product.id,
        description=f"Updated product {product.product_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_product_event(
        db=db,
        dispatcher=dispatcher,
        event_type="product.updated",
        product_id=product.id,
        user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{product_id}/activate", summary="Activate a product")
async def activate_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a product's status to active."""
    product = await service.activate(product_id)
    data = ProductRead.model_validate(product).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=product.id,
        description=f"Activated product {product.product_name!r}.",
    )
    await _publish_product_event(
        db=db,
        dispatcher=dispatcher,
        event_type="product.updated",
        product_id=product.id,
        user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{product_id}/deactivate", summary="Deactivate a product")
async def deactivate_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a product's status to inactive."""
    product = await service.deactivate(product_id)
    data = ProductRead.model_validate(product).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=product.id,
        description=f"Deactivated product {product.product_name!r}.",
    )
    await _publish_product_event(
        db=db,
        dispatcher=dispatcher,
        event_type="product.updated",
        product_id=product.id,
        user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{product_id}", summary="Delete a product")
async def delete_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft-delete a product."""
    await service.delete(product_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=product_id,
        description="Deleted product.",
    )
    await _publish_product_event(
        db=db,
        dispatcher=dispatcher,
        event_type="product.deleted",
        product_id=product_id,
        user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)