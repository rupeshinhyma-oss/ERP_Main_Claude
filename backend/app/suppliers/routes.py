"""
Supplier Routes.

Standard CRUD + contacts sub-resource + list-view inline grade/potential
updates + activate/deactivate + import/export, with audit logging on every
mutation, following the same pattern as the Phase 7 Master Data routes.

Phase 9: wired live event publishing on every mutation (create, update,
grade, potential, activate, deactivate, delete) so Suppliers.tsx can
receive real-time updates via the shared WebSocket infrastructure. Mirrors
the identical pattern already established by app.buyers.routes.
"""

from __future__ import annotations

from datetime import datetime
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
from app.rbac.dependencies import require_permission
from app.suppliers.dependencies import get_supplier_service
from app.suppliers.schemas import (
    ImportSummaryRead,
    SupplierContactCreate,
    SupplierContactRead,
    SupplierContactUpdate,
    SupplierCreate,
    SupplierGradeUpdate,
    SupplierListItemRead,
    SupplierPotentialUpdate,
    SupplierRead,
    SupplierUpdate,
)
from app.suppliers.service import SupplierService

router = APIRouter(prefix="/suppliers", tags=["Suppliers"])


async def _publish_supplier_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    supplier_id: uuid.UUID | str,
    version: int | None,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """
    Commit ``db``, then publish a ``supplier.*`` live event on
    ``module:suppliers``.

    Phase 9: mirrors ``app.buyers.routes._publish_buyer_event`` exactly
    (Suppliers is one of the two large, frequently-edited list modules
    Phase 9 targets, and its channel/permission was already registered in
    ``app.events.channels.MODULE_CHANNEL_PERMISSIONS`` -- ``supplier.view``
    -- since Phase 1, but nothing ever actually published to it until
    now). Publishes to ``module:suppliers`` only, same reasoning as
    Buyers: no Supplier detail page/side-panel subscribes to a per-record
    channel today, so broadcasting to the module channel is sufficient.
    """
    await dispatcher.publish_lifecycle_event(
        db,
        module="suppliers",
        entity="supplier",
        entity_id=supplier_id,
        event_type=event_type,
        version=version,
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
    """Shared helper: record a supplier action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="suppliers",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Supplier",
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


async def _to_supplier_read(service: SupplierService, supplier) -> dict:
    """Build a SupplierRead dict, filling in derived/joined fields the ORM object doesn't carry directly."""
    payload = {
        "id": supplier.id,
        "company_name": supplier.company_name,
        "supplier_type": supplier.supplier_type,
        "brand_description": supplier.brand_description,
        "country_id": supplier.country_id,
        "state_id": supplier.state_id,
        "city_id": supplier.city_id,
        "contact_salutation": supplier.contact_salutation,
        "contact_full_name": supplier.contact_full_name,
        "contact_designation": supplier.contact_designation,
        "contact_calling_number": supplier.contact_calling_number,
        "contact_whatsapp_number": supplier.contact_whatsapp_number,
        "contact_wechat_number": supplier.contact_wechat_number,
        "tax_id_number": supplier.tax_id_number,
        "address": supplier.address,
        "town": supplier.town,
        "primary_website": supplier.primary_website,
        "secondary_website": supplier.secondary_website,
        "supplier_grade": supplier.supplier_grade,
        "current_status": supplier.current_status,
        "potential": supplier.potential,
        "potential_reason": supplier.potential_reason,
        "secondary_products_description": supplier.secondary_products_description,
        "visited_factory_office": supplier.visited_factory_office,
        "visit_remarks": supplier.visit_remarks,
        "visit_media": supplier.visit_media,
        "overall_remarks": supplier.overall_remarks,
        "is_active": supplier.is_active,
        "created_at": supplier.created_at,
        "updated_at": supplier.updated_at,
        "emails": [e.email for e in supplier.emails],
        "category_ids": [link.category_id for link in supplier.category_links],
        "sub_category_ids": [link.sub_category_id for link in supplier.sub_category_links],
        "product_ids": [link.product_id for link in supplier.product_links],
        "contacts": [SupplierContactRead.model_validate(c) for c in supplier.contacts],
    }
    return SupplierRead.model_validate(payload).model_dump(mode="json")


def _to_list_item(supplier) -> dict:
    """
    Build a SupplierListItemRead dict for the list view (document: "Fields in List").

    No longer takes/uses a ``service`` argument, and no longer ``async``
    -- reading ``supplier.category_links``/``sub_category_links``/``product_links``
    directly (all already loaded via the model's `lazy="selectin"` relationships)
    is both correct and strictly faster than the extra per-row queries.
    """
    data = SupplierListItemRead.model_validate(supplier).model_dump(mode="json")
    data["category_ids"] = [str(link.category_id) for link in supplier.category_links]
    data["sub_category_ids"] = [str(link.sub_category_id) for link in supplier.sub_category_links]
    data["product_ids"] = [str(link.product_id) for link in supplier.product_links]
    return data


# ---------------------------------------------------------------------------
# Supplier CRUD
# ---------------------------------------------------------------------------


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a supplier")
async def create_supplier(
    payload: SupplierCreate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.create")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create a new supplier profile (First Data Form + Second Form)."""
    supplier = await service.create(**payload.model_dump())
    data = await _to_supplier_read(service, supplier)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Created supplier {supplier.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.created",
        supplier_id=supplier.id,
        version=getattr(supplier, "version", None),
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List suppliers")
async def list_suppliers(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    category_id: uuid.UUID | None = None,
    sub_category_id: uuid.UUID | None = None,
    product_id: uuid.UUID | None = None,
    service: SupplierService = Depends(get_supplier_service),
    _current_user: CurrentUser = Depends(require_permission("supplier.view")),
) -> dict:
    """
    List suppliers, with search/sort/filter/pagination.

    Supports the document's Top Filter Fields via standard query params:
    ``country_id``, ``state_id``, ``city_id``, ``supplier_type``,
    ``supplier_grade``, ``current_status``, ``potential``,
    ``visited_factory_office``, ``is_active`` (dynamic exact-match filters),
    plus ``category_id``/``sub_category_id``/``product_id`` (many-to-many,
    handled explicitly) -- ``product_id`` answers "which suppliers supply
    this exact SKU?".
    """
    suppliers, total = await service.list_paginated(
        query, category_id=category_id, sub_category_id=sub_category_id, product_id=product_id
    )
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [_to_list_item(s) for s in suppliers]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export suppliers to CSV/Excel")
async def export_suppliers(
    request: Request,
    format: str = "csv",
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every supplier as a CSV or XLSX file."""
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
        description=f"Exported suppliers as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    today_str = datetime.now().strftime("%d-%m-%Y")
    filename = f"Supplier_{today_str}.{file_format}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/import", summary="Import suppliers from CSV/Excel")
async def import_suppliers(
    request: Request,
    file: UploadFile = File(...),
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Import suppliers from an uploaded CSV/XLSX file, validating every row.

    Applies the document's duplicate-detection rule (Company Name + City)
    per row; duplicates are skipped and reported in the import summary
    rather than aborting the whole batch.
    """
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported suppliers: {summary.created} created, {summary.failed} failed.",
        new_values=summary.as_dict(),
    )
    data = ImportSummaryRead(**summary.as_dict()).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/upload-media", summary="Upload visit photo or video to Supabase Storage")
async def upload_supplier_media(
    file: UploadFile = File(...),
    _current_user: CurrentUser = Depends(require_permission("supplier.create")),
) -> dict:
    from pathlib import Path
    import urllib.request
    import os

    content = await file.read()
    filename = f"{uuid.uuid4().hex}_{file.filename}"
    supabase_project_id = os.getenv("SUPABASE_PROJECT_ID", "mpvzjzunkiqchhhvxrza")
    supabase_key = os.getenv("SUPABASE_SERVICE_KEY") or os.getenv("SUPABASE_ANON_KEY", "")

    # Try direct upload to Supabase Storage Buckets
    if supabase_key:
        for bucket in ("supplier-media", "product-images"):
            try:
                supabase_upload_url = f"https://{supabase_project_id}.supabase.co/storage/v1/object/{bucket}/{filename}"
                req = urllib.request.Request(
                    supabase_upload_url,
                    data=content,
                    headers={
                        "Authorization": f"Bearer {supabase_key}",
                        "Content-Type": file.content_type or "application/octet-stream",
                        "x-upsert": "true",
                    },
                    method="POST"
                )
                with urllib.request.urlopen(req) as resp:
                    if resp.status in (200, 201):
                        public_url = f"https://{supabase_project_id}.supabase.co/storage/v1/object/public/{bucket}/{filename}"
                        return {"success": True, "data": {"url": public_url}}
            except Exception:
                pass

    # Fallback to local server static storage
    upload_dir = Path("uploads/suppliers")
    upload_dir.mkdir(parents=True, exist_ok=True)
    file_path = upload_dir / filename
    file_path.write_bytes(content)
    public_url = f"/static/uploads/suppliers/{filename}"
    return {"success": True, "data": {"url": public_url}}


@router.get("/{supplier_id}", summary="Get a supplier")
async def get_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    _current_user: CurrentUser = Depends(require_permission("supplier.view")),
) -> dict:
    """Fetch a single supplier profile by ID, including contacts, emails, and category links."""
    supplier = await service.get_by_id_or_raise(supplier_id)
    data = await _to_supplier_read(service, supplier)
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_id}", summary="Update a supplier")
async def update_supplier(
    supplier_id: uuid.UUID,
    payload: SupplierUpdate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing supplier profile."""
    supplier = await service.update(supplier_id, **payload.model_dump())
    data = await _to_supplier_read(service, supplier)
    changes = payload.model_dump(exclude_none=True, exclude={"version"}, mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Updated supplier {supplier.company_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.updated",
        supplier_id=supplier.id,
        version=getattr(supplier, "version", None),
        user_id=current_user.id,
        changes=changes,
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_id}/grade", summary="Update a supplier's grade (list-view inline dropdown)")
async def update_supplier_grade(
    supplier_id: uuid.UUID,
    payload: SupplierGradeUpdate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.grade_edit")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document: "Supplier's Grade (editable dropdown in list)"."""
    supplier = await service.update_grade(supplier_id, payload.supplier_grade)
    data = await _to_supplier_read(service, supplier)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Updated grade for supplier {supplier.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.updated",
        supplier_id=supplier.id,
        version=getattr(supplier, "version", None),
        user_id=current_user.id,
        changes={"supplier_grade": payload.model_dump(mode="json").get("supplier_grade")},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_id}/potential", summary="Update a supplier's potential (list-view inline dropdown)")
async def update_supplier_potential(
    supplier_id: uuid.UUID,
    payload: SupplierPotentialUpdate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.potential_edit")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document: "Potential (editable dropdown in list)"."""
    supplier = await service.update_potential(supplier_id, payload.potential)
    data = await _to_supplier_read(service, supplier)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Updated potential for supplier {supplier.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.updated",
        supplier_id=supplier.id,
        version=getattr(supplier, "version", None),
        user_id=current_user.id,
        changes={"potential": payload.model_dump(mode="json").get("potential")},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{supplier_id}/activate", summary="Activate a supplier")
async def activate_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Set a supplier's status to active."""
    supplier = await service.activate(supplier_id)
    data = await _to_supplier_read(service, supplier)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Activated supplier {supplier.company_name!r}.",
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.updated",
        supplier_id=supplier.id,
        version=getattr(supplier, "version", None),
        user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{supplier_id}/deactivate", summary="Deactivate a supplier")
async def deactivate_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """
    Set a supplier's status to inactive.

    Document Notes: this is the only lifecycle action available once a
    supplier is no longer delete-eligible (Current Status Existing or
    Potential Yes) -- see :meth:`SupplierService.delete` for the guard.
    """
    supplier = await service.deactivate(supplier_id)
    data = await _to_supplier_read(service, supplier)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Deactivated supplier {supplier.company_name!r}.",
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.updated",
        supplier_id=supplier.id,
        version=getattr(supplier, "version", None),
        user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{supplier_id}", summary="Delete a supplier")
async def delete_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """
    Soft-delete a supplier.

    Document Notes: only permitted when Current Status is New/unset AND
    Potential is No/unset; otherwise rejected with a 409 -- deactivate
    instead.
    """
    await service.delete(supplier_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=supplier_id,
        description="Deleted supplier.",
    )
    await _publish_supplier_event(
        db=db,
        dispatcher=dispatcher,
        event_type="supplier.deleted",
        supplier_id=supplier_id,
        version=None,
        user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Contacts sub-resource ("Add Contacts Form/List")
# ---------------------------------------------------------------------------


@router.post(
    "/{supplier_id}/contacts",
    status_code=status.HTTP_201_CREATED,
    summary="Add a contact person to a supplier",
)
async def create_supplier_contact(
    supplier_id: uuid.UUID,
    payload: SupplierContactCreate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Add a contact person to a supplier ("Add Contacts Form")."""
    contact = await service.add_contact(supplier_id, **payload.model_dump())
    data = SupplierContactRead.model_validate(contact).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=contact.id,
        description=f"Added contact {contact.person_name!r} to supplier.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("/{supplier_id}/contacts", summary="List a supplier's contacts")
async def list_supplier_contacts(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    _current_user: CurrentUser = Depends(require_permission("supplier.view")),
) -> dict:
    """List every contact person for a supplier ("Add Contacts List")."""
    await service.get_by_id_or_raise(supplier_id)
    contacts = await service.list_contacts(supplier_id)
    data = [SupplierContactRead.model_validate(c).model_dump(mode="json") for c in contacts]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_id}/contacts/{contact_id}", summary="Update a supplier contact")
async def update_supplier_contact(
    supplier_id: uuid.UUID,
    contact_id: uuid.UUID,
    payload: SupplierContactUpdate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing contact person (document: contacts list "Action - Edit / Delete")."""
    contact = await service.update_contact(supplier_id, contact_id, **payload.model_dump())
    data = SupplierContactRead.model_validate(contact).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=contact.id,
        description=f"Updated contact {contact.person_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{supplier_id}/contacts/{contact_id}", summary="Delete a supplier contact")
async def delete_supplier_contact(
    supplier_id: uuid.UUID,
    contact_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Remove a contact person from a supplier (document: contacts list "Action - Edit / Delete")."""
    await service.delete_contact(supplier_id, contact_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=contact_id,
        description="Deleted supplier contact.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)