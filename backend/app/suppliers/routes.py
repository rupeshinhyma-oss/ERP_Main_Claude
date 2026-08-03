"""
Supplier Routes.

Standard CRUD + contacts sub-resource + list-view inline grade/potential
updates + activate/deactivate + import/export, with audit logging on every
mutation, following the same pattern as the Phase 7 Master Data routes.
"""

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
    # Built from a plain dict rather than SupplierRead.model_validate(supplier)
    # directly: the ORM relationship Supplier.emails (list[SupplierEmail])
    # would otherwise auto-populate the schema's `emails: list[str]` field
    # during validation, before we get a chance to override it with the
    # flattened string list -- raising a validation error, since a
    # SupplierEmail object isn't a str.
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
        "category_ids": await service.get_category_ids(supplier.id),
        "sub_category_ids": await service.get_sub_category_ids(supplier.id),
        "contacts": [SupplierContactRead.model_validate(c) for c in supplier.contacts],
    }
    return SupplierRead.model_validate(payload).model_dump(mode="json")


async def _to_list_item(service: SupplierService, supplier) -> dict:
    """Build a SupplierListItemRead dict for the list view (document: "Fields in List")."""
    data = SupplierListItemRead.model_validate(supplier).model_dump(mode="json")
    data["category_ids"] = [str(cid) for cid in await service.get_category_ids(supplier.id)]
    data["sub_category_ids"] = [str(cid) for cid in await service.get_sub_category_ids(supplier.id)]
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
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List suppliers")
async def list_suppliers(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    category_id: uuid.UUID | None = None,
    sub_category_id: uuid.UUID | None = None,
    service: SupplierService = Depends(get_supplier_service),
    _current_user: CurrentUser = Depends(require_permission("supplier.read")),
) -> dict:
    """
    List suppliers, with search/sort/filter/pagination.

    Supports the document's Top Filter Fields via standard query params:
    ``country_id``, ``state_id``, ``city_id``, ``supplier_type``,
    ``supplier_grade``, ``current_status``, ``potential``,
    ``visited_factory_office``, ``is_active`` (dynamic exact-match filters),
    plus ``category_id``/``sub_category_id`` (many-to-many, handled explicitly).
    """
    suppliers, total = await service.list_paginated(query, category_id=category_id, sub_category_id=sub_category_id)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [await _to_list_item(service, s) for s in suppliers]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export suppliers to CSV/Excel")
async def export_suppliers(
    request: Request,
    format: str = "csv",
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.read")),
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
    filename = f"suppliers.{file_format}"
    return Response(content=content, media_type=media_type, headers={"Content-Disposition": f"attachment; filename={filename}"})


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


@router.get("/{supplier_id}", summary="Get a supplier")
async def get_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    _current_user: CurrentUser = Depends(require_permission("supplier.read")),
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
) -> dict:
    """Update an existing supplier profile."""
    supplier = await service.update(supplier_id, **payload.model_dump())
    data = await _to_supplier_read(service, supplier)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=supplier.id,
        description=f"Updated supplier {supplier.company_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_id}/grade", summary="Update a supplier's grade (list-view inline dropdown)")
async def update_supplier_grade(
    supplier_id: uuid.UUID,
    payload: SupplierGradeUpdate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{supplier_id}/potential", summary="Update a supplier's potential (list-view inline dropdown)")
async def update_supplier_potential(
    supplier_id: uuid.UUID,
    payload: SupplierPotentialUpdate,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{supplier_id}/activate", summary="Activate a supplier")
async def activate_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{supplier_id}/deactivate", summary="Deactivate a supplier")
async def deactivate_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{supplier_id}", summary="Delete a supplier")
async def delete_supplier(
    supplier_id: uuid.UUID,
    request: Request,
    service: SupplierService = Depends(get_supplier_service),
    current_user: CurrentUser = Depends(require_permission("supplier.delete")),
    audit_service: AuditService = Depends(get_audit_service),
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
    _current_user: CurrentUser = Depends(require_permission("supplier.read")),
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
