"""Product Routes. Standard CRUD + activate/deactivate + import/export, with audit logging."""

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
from app.masters.products.dependencies import get_product_service
from app.masters.products.schemas import ImportSummaryRead, ProductCreate, ProductRead, ProductUpdate
from app.masters.products.service import ProductService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/masters/products", tags=["Masters - Products"])


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
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List products")
async def list_products(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    service: ProductService = Depends(get_product_service),
    _current_user: CurrentUser = Depends(require_permission("product.read")),
) -> dict:
    """List products, with search/sort/filter/pagination."""
    products, total = await service.list_paginated(query)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [ProductRead.model_validate(p).model_dump(mode="json") for p in products]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export products to CSV/Excel")
async def export_products(
    request: Request,
    format: str = "csv",
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.read")),
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
    filename = f"products.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


@router.post("/import", summary="Import products from CSV/Excel")
async def import_products(
    request: Request,
    file: UploadFile = File(...),
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.create")),
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
    from pathlib import Path
    import urllib.request
    import os

    content = await file.read()
    filename = f"{uuid.uuid4().hex}_{file.filename}"
    supabase_project_id = os.getenv("SUPABASE_PROJECT_ID", "mpvzjzunkiqchhhvxrza")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")

    # Try direct upload to Supabase Storage Bucket 'product-images'
    if supabase_key:
        try:
            supabase_upload_url = f"https://{supabase_project_id}.supabase.co/storage/v1/object/product-images/{filename}"
            req = urllib.request.Request(
                supabase_upload_url,
                data=content,
                headers={
                    "Authorization": f"Bearer {supabase_key}",
                    "Content-Type": file.content_type or "image/jpeg",
                    "x-upsert": "true",
                },
                method="POST"
            )
            with urllib.request.urlopen(req) as resp:
                if resp.status in (200, 201):
                    public_url = f"https://{supabase_project_id}.supabase.co/storage/v1/object/public/product-images/{filename}"
                    return {"success": True, "data": {"url": public_url}}
        except Exception:
            pass

    # Save to local server storage folder as fallback
    uploads_dir = Path("uploads/products")
    uploads_dir.mkdir(parents=True, exist_ok=True)
    file_path = uploads_dir / filename
    with open(file_path, "wb") as f:
        f.write(content)
    image_url = f"/uploads/products/{filename}"
    return {"success": True, "data": {"url": image_url}}


@router.get("/{product_id}", summary="Get a product")
async def get_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    _current_user: CurrentUser = Depends(require_permission("product.read")),
) -> dict:
    """Fetch a single product by ID."""
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
) -> dict:
    """Update an existing product."""
    product = await service.update(product_id, **payload.model_dump())
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{product_id}/activate", summary="Activate a product")
async def activate_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{product_id}/deactivate", summary="Deactivate a product")
async def deactivate_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{product_id}", summary="Delete a product")
async def delete_product(
    product_id: uuid.UUID,
    request: Request,
    service: ProductService = Depends(get_product_service),
    current_user: CurrentUser = Depends(require_permission("product.delete")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
