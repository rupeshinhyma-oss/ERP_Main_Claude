"""
Buyer Routes.

Standard CRUD + contacts sub-resource + list-view inline grade/potential
updates + activate/deactivate, with audit logging on every mutation,
mirroring :mod:`app.suppliers.routes`.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.buyers.dependencies import get_buyer_service
from app.buyers.schemas import (
    BuyerContactCreate,
    BuyerContactRead,
    BuyerContactUpdate,
    BuyerCreate,
    BuyerGradeUpdate,
    BuyerListItemRead,
    BuyerPotentialUpdate,
    BuyerRead,
    BuyerUpdate,
)
from app.buyers.service import BuyerService
from app.common.list_query import ListQueryParams, get_list_query_params
from app.common.pagination import PageMeta
from app.core.responses import build_success_response
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/buyers", tags=["Buyers"])


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
    """Shared helper: record a buyer action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="buyers",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="Buyer",
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


async def _to_buyer_read(service: BuyerService, buyer) -> dict:
    """Build a BuyerRead dict, filling in derived/joined fields the ORM object doesn't carry directly."""
    # Built from a plain dict rather than BuyerRead.model_validate(buyer)
    # directly: the ORM relationship Buyer.emails (list[BuyerEmail]) would
    # otherwise auto-populate the schema's `emails: list[str]` field
    # during validation, before we get a chance to override it with the
    # flattened string list -- raising a validation error, since a
    # BuyerEmail object isn't a str. Mirrors app.suppliers.routes._to_supplier_read.
    payload = {
        "id": buyer.id,
        "company_name": buyer.company_name,
        "buyer_type": buyer.buyer_type,
        "country_id": buyer.country_id,
        "city": buyer.city,
        "address": buyer.address,
        "contact_salutation": buyer.contact_salutation,
        "contact_full_name": buyer.contact_full_name,
        "contact_designation": buyer.contact_designation,
        "contact_calling_number": buyer.contact_calling_number,
        "contact_whatsapp_number": buyer.contact_whatsapp_number,
        "tax_id_number": buyer.tax_id_number,
        "website": buyer.website,
        "current_status": buyer.current_status,
        "product_range": buyer.product_range,
        "potential": buyer.potential,
        "potential_reason": buyer.potential_reason,
        "buyer_grade": buyer.buyer_grade,
        "currently_buying_from": buyer.currently_buying_from,
        "overall_remarks": buyer.overall_remarks,
        "is_active": buyer.is_active,
        "created_at": buyer.created_at,
        "updated_at": buyer.updated_at,
        "emails": [e.email for e in buyer.emails],
        "category_ids": await service.get_category_ids(buyer.id),
        "sub_category_ids": await service.get_sub_category_ids(buyer.id),
        "contacts": [BuyerContactRead.model_validate(c) for c in buyer.contacts],
    }
    return BuyerRead.model_validate(payload).model_dump(mode="json")


async def _to_list_item(service: BuyerService, buyer) -> dict:
    """Build a BuyerListItemRead dict for the list view (document: "Fields in List")."""
    data = BuyerListItemRead.model_validate(buyer).model_dump(mode="json")
    data["category_ids"] = [str(cid) for cid in await service.get_category_ids(buyer.id)]
    data["sub_category_ids"] = [str(cid) for cid in await service.get_sub_category_ids(buyer.id)]
    return data


# ---------------------------------------------------------------------------
# Buyer CRUD
# ---------------------------------------------------------------------------


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a buyer (client)")
async def create_buyer(
    payload: BuyerCreate,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new buyer (client) profile."""
    buyer = await service.create(**payload.model_dump())
    data = await _to_buyer_read(service, buyer)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Created buyer {buyer.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List buyers")
async def list_buyers(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    category_id: uuid.UUID | None = None,
    sub_category_id: uuid.UUID | None = None,
    service: BuyerService = Depends(get_buyer_service),
    _current_user: CurrentUser = Depends(require_permission("buyer.read")),
) -> dict:
    """
    List buyers, with search/sort/filter/pagination.

    Supports the document's Top Filter Fields via standard query params:
    ``country_id``, ``buyer_type``, ``current_status``, ``potential``,
    ``buyer_grade``, ``is_active`` (dynamic exact-match filters), plus
    ``category_id``/``sub_category_id`` (many-to-many, handled explicitly).
    ``added_date_range`` is covered by the generic ``created_at`` range
    filter already supported by :class:`ListQueryParams`.
    """
    buyers, total = await service.list_paginated(query, category_id=category_id, sub_category_id=sub_category_id)
    meta = PageMeta.build(page=query.page.page, page_size=query.page.page_size, total_records=total).as_meta_dict()
    data = [await _to_list_item(service, b) for b in buyers]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/{buyer_id}", summary="Get a buyer")
async def get_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    _current_user: CurrentUser = Depends(require_permission("buyer.read")),
) -> dict:
    """Fetch a single buyer profile by ID, including contacts, emails, and category links."""
    buyer = await service.get_by_id_or_raise(buyer_id)
    data = await _to_buyer_read(service, buyer)
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{buyer_id}", summary="Update a buyer")
async def update_buyer(
    buyer_id: uuid.UUID,
    payload: BuyerUpdate,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing buyer profile."""
    buyer = await service.update(buyer_id, **payload.model_dump())
    data = await _to_buyer_read(service, buyer)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Updated buyer {buyer.company_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{buyer_id}/grade", summary="Update a buyer's grade (list-view inline dropdown)")
async def update_buyer_grade(
    buyer_id: uuid.UUID,
    payload: BuyerGradeUpdate,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Document: "Client Grade (editable dropdown in list)"."""
    buyer = await service.update_grade(buyer_id, payload.buyer_grade)
    data = await _to_buyer_read(service, buyer)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Updated grade for buyer {buyer.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{buyer_id}/potential", summary="Update a buyer's potential (list-view inline dropdown)")
async def update_buyer_potential(
    buyer_id: uuid.UUID,
    payload: BuyerPotentialUpdate,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Document: "Potential (editable dropdown in list)"."""
    buyer = await service.update_potential(buyer_id, payload.potential)
    data = await _to_buyer_read(service, buyer)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Updated potential for buyer {buyer.company_name!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{buyer_id}/activate", summary="Activate a buyer")
async def activate_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a buyer's status to active."""
    buyer = await service.activate(buyer_id)
    data = await _to_buyer_read(service, buyer)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Activated buyer {buyer.company_name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{buyer_id}/deactivate", summary="Deactivate a buyer")
async def deactivate_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Set a buyer's status to inactive.

    Document Notes: this is the only lifecycle action available once a
    buyer is no longer delete-eligible (Current Status Existing or
    Potential Yes) -- see :meth:`BuyerService.delete` for the guard.
    """
    buyer = await service.deactivate(buyer_id)
    data = await _to_buyer_read(service, buyer)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Deactivated buyer {buyer.company_name!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{buyer_id}", summary="Delete a buyer")
async def delete_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.delete")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Soft-delete a buyer.

    Document Notes: only permitted when Current Status is New/unset AND
    Potential is No/unset; otherwise rejected with a 409 -- deactivate
    instead.
    """
    await service.delete(buyer_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=buyer_id,
        description="Deleted buyer.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Contacts sub-resource ("Add Contacts of Buyer (Client)")
# ---------------------------------------------------------------------------


@router.post("/{buyer_id}/contacts", status_code=status.HTTP_201_CREATED, summary="Add a contact person to a buyer")
async def create_buyer_contact(
    buyer_id: uuid.UUID,
    payload: BuyerContactCreate,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Add a contact person to a buyer."""
    contact = await service.add_contact(buyer_id, **payload.model_dump())
    data = BuyerContactRead.model_validate(contact).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=contact.id,
        description=f"Added contact {contact.person_name!r} to buyer {buyer_id}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Contact added.")


@router.get("/{buyer_id}/contacts", summary="List a buyer's contacts")
async def list_buyer_contacts(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    _current_user: CurrentUser = Depends(require_permission("buyer.read")),
) -> dict:
    """List every contact person for a buyer (document: "Main Form contact details should appear in the Contact list also")."""
    await service.get_by_id_or_raise(buyer_id)
    contacts = await service.list_contacts(buyer_id)
    data = [BuyerContactRead.model_validate(c).model_dump(mode="json") for c in contacts]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{buyer_id}/contacts/{contact_id}", summary="Update a buyer's contact")
async def update_buyer_contact(
    buyer_id: uuid.UUID,
    contact_id: uuid.UUID,
    payload: BuyerContactUpdate,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update an existing contact person."""
    contact = await service.update_contact(buyer_id, contact_id, **payload.model_dump())
    data = BuyerContactRead.model_validate(contact).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=contact.id,
        description=f"Updated contact {contact.person_name!r} for buyer {buyer_id}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{buyer_id}/contacts/{contact_id}", summary="Delete a buyer's contact")
async def delete_buyer_contact(
    buyer_id: uuid.UUID,
    contact_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Remove a contact person from a buyer (document: Action "Edit / Delete")."""
    await service.delete_contact(buyer_id, contact_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=contact_id,
        description=f"Deleted contact {contact_id} from buyer {buyer_id}.",
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)
