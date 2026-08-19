"""
Buyer Routes.

Standard CRUD + contacts sub-resource + list-view inline grade/potential
updates + activate/deactivate, with audit logging on every mutation,
mirroring :mod:`app.suppliers.routes`.
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
from app.database.session import get_db_session
from app.events.dependencies import get_event_dispatcher
from app.events.dispatcher import EventDispatcher
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/buyers", tags=["Buyers"])


async def _publish_buyer_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    buyer_id: uuid.UUID | str,
    version: int | None,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """
    Commit ``db``, then publish a ``buyer.*`` live event on ``module:buyers``.

    Phase 6: thin wrapper around the shared
    :meth:`EventDispatcher.publish_lifecycle_event` -- see that method's
    own docstring for the full reasoning (commit-before-publish
    ordering, why a second later commit from ``get_db_session`` is
    safe, etc.), which used to live here as Buyers-specific prose before
    the identical pattern was also needed for Planning (Phase 5) and
    consolidated (Phase 6). Kept as a thin Buyers-named wrapper (rather
    than having every route call ``dispatcher.publish_lifecycle_event``
    directly with a long argument list) purely so each of the 7 call
    sites below stays a short, readable one-liner -- not because there's
    any Buyers-specific LOGIC left in this function at all.

    Publishes to ``module:buyers`` only (not a per-record ``buyer:{id}``
    channel) -- no Buyer detail page/side-panel subscribes to one today,
    so there is nothing yet to address individually; see
    ``app.events.channels.entity_channel`` if that changes later.
    """
    await dispatcher.publish_lifecycle_event(
        db,
        module="buyers",
        entity="buyer",
        entity_id=buyer_id,
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
    #
    # category_ids/sub_category_ids are read directly off the ORM
    # relationship (buyer.category_links/sub_category_links) rather than
    # via service.get_category_ids()/get_sub_category_ids() -- those
    # relationships are declared `lazy="selectin"` on the Buyer model
    # (see app/buyers/models.py), so they are ALREADY loaded in memory by
    # the time a Buyer instance reaches this function. Calling the
    # service methods here would re-query the exact same
    # buyer_category_links/buyer_sub_category_links rows the ORM already
    # fetched, for no benefit -- see the Phase 3 audit notes in
    # PHASE3_PERFORMANCE.md ("N+1 in list/detail serialization").
    payload = {
        "id": buyer.id,
        "version": buyer.version,
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
        "category_ids": [link.category_id for link in buyer.category_links],
        "sub_category_ids": [link.sub_category_id for link in buyer.sub_category_links],
        "contacts": [BuyerContactRead.model_validate(c) for c in buyer.contacts],
    }
    return BuyerRead.model_validate(payload).model_dump(mode="json")


def _to_list_item(buyer) -> dict:
    """
    Build a BuyerListItemRead dict for the list view (document: "Fields in List").

    No longer takes/uses a ``service`` argument, and no longer ``async``
    -- see ``_to_buyer_read``'s docstring above for why reading
    ``buyer.category_links``/``buyer.sub_category_links`` directly (both
    already loaded via the model's ``lazy="selectin"`` relationships) is
    both correct and strictly faster than the two extra per-row queries
    this used to issue. Call sites updated accordingly (no more
    ``await``, and one less argument).
    """
    data = BuyerListItemRead.model_validate(buyer).model_dump(mode="json")
    data["category_ids"] = [str(link.category_id) for link in buyer.category_links]
    data["sub_category_ids"] = [str(link.sub_category_id) for link in buyer.sub_category_links]
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
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
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
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.created",
        buyer_id=buyer.id,
        version=buyer.version,
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Resource created successfully.")


@router.get("", summary="List buyers")
async def list_buyers(
    request: Request,
    query: ListQueryParams = Depends(get_list_query_params),
    category_id: uuid.UUID | None = None,
    sub_category_id: uuid.UUID | None = None,
    service: BuyerService = Depends(get_buyer_service),
    _current_user: CurrentUser = Depends(require_permission("buyer.view")),
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
    data = [_to_list_item(b) for b in buyers]
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/export", summary="Export buyers to CSV/Excel")
async def export_buyers(
    request: Request,
    format: str = "csv",
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.export")),
    audit_service: AuditService = Depends(get_audit_service),
) -> Response:
    """Export every buyer as a CSV or XLSX file."""
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
        description=f"Exported buyers as {file_format}.",
    )
    media_type = "text/csv" if file_format == "csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    today_str = datetime.now().strftime("%d-%m-%Y")
    filename = f"Buyer_{today_str}.{file_format}"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.post("/import", summary="Import buyers from CSV/Excel")
async def import_buyers(
    request: Request,
    file: UploadFile = File(...),
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.import")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Import buyers from an uploaded CSV/XLSX file, validating every row with 3-way duplicate detection."""
    raw_bytes = await file.read()
    summary = await service.import_file(file.filename or "import.csv", raw_bytes)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.IMPORT,
        actor=current_user,
        entity_id="bulk",
        description=f"Imported buyers: {summary.created} created, {summary.failed} failed, {summary.duplicate_count} duplicates.",
        new_values=summary.as_dict(),
    )
    return build_success_response(data=summary.as_dict(), request_id=request.state.request_id)


@router.get("/{buyer_id}", summary="Get a buyer")
async def get_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    _current_user: CurrentUser = Depends(require_permission("buyer.view")),
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
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update an existing buyer profile."""
    buyer = await service.update(buyer_id, **payload.model_dump())
    data = await _to_buyer_read(service, buyer)
    changes = payload.model_dump(exclude_none=True, exclude={"version"}, mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=buyer.id,
        description=f"Updated buyer {buyer.company_name!r}.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.updated",
        buyer_id=buyer.id,
        version=buyer.version,
        user_id=current_user.id,
        changes=changes,
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
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
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
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.updated",
        buyer_id=buyer.id,
        version=buyer.version,
        user_id=current_user.id,
        changes={"buyer_grade": payload.model_dump(mode="json").get("buyer_grade")},
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
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
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
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.updated",
        buyer_id=buyer.id,
        version=buyer.version,
        user_id=current_user.id,
        changes={"potential": payload.model_dump(mode="json").get("potential")},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{buyer_id}/activate", summary="Activate a buyer")
async def activate_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
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
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.updated",
        buyer_id=buyer.id,
        version=buyer.version,
        user_id=current_user.id,
        changes={"is_active": True},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{buyer_id}/deactivate", summary="Deactivate a buyer")
async def deactivate_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.update")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
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
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.updated",
        buyer_id=buyer.id,
        version=buyer.version,
        user_id=current_user.id,
        changes={"is_active": False},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{buyer_id}", summary="Delete a buyer")
async def delete_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: BuyerService = Depends(get_buyer_service),
    current_user: CurrentUser = Depends(require_permission("buyer.delete")),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
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
    await _publish_buyer_event(
        db=db,
        dispatcher=dispatcher,
        event_type="buyer.deleted",
        buyer_id=buyer_id,
        version=None,
        user_id=current_user.id,
        changes={},
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
    _current_user: CurrentUser = Depends(require_permission("buyer.view")),
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