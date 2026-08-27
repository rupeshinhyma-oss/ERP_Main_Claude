"""
Inquiry Routes.

Implements the document's two-layer structure directly in the URL shape:

- Layer 1 (company-wise): ``GET /inquiries/companies``
- Layer 1 inside a company: ``GET /inquiries/companies/{buyer_id}``
- Layer 2 (inside a consignment): ``GET /inquiries/{inquiry_id}/items``

Plus the admin-managed Consignment Codes master, and the bulk
Tally-Entry-Posted action.

Phase 9: added live event publishing on every mutation so the Inquiries
page receives real-time updates via ``module:inquiries``. The entity name
``"inquiry"`` already exists in the frontend ENTITY_TO_MODULE_CHANNEL
table (mapped to ``moduleChannel("inquiries")``), so no frontend routing
change is needed. Events are published at the item level (the unit that
actually changes), not the consignment level.
"""

from __future__ import annotations

from datetime import datetime
import uuid

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.common.email import send_bulk_rfq_email, send_rfq_email
from app.database.session import get_db_session
from app.events.channels import module_channel
from app.events.dependencies import get_event_dispatcher
from app.events.dispatcher import EventDispatcher
from app.events.models import Event
from app.inquiries.dependencies import get_inquiry_service
from app.inquiries.public_quotes import generate_rfq_token
from app.masters.products.models import Product
from app.suppliers.models import Supplier, SupplierCategoryLink, SupplierSubCategoryLink
from app.inquiries.schemas import (
    BulkRFQCreate,
    BulkTallyPostRequest,
    BulkInquiryItemCreate,
    CompanySummaryRead,
    ConsignmentCodeCreate,
    ConsignmentCodeRead,
    InquiryItemCreate,
    InquiryItemProcurementRemarksUpdate,
    InquiryItemRead,
    InquiryItemShift,
    InquiryItemUpdate,
    InquiryListItemRead,
    InquiryRead,
    QuotationCreate,
    QuotationRead,
    QuotationStatusUpdate,
    QuotationUpdate,
    RFQCreate,
    RFQRead,
)
from app.inquiries.service import InquiryService

router = APIRouter(prefix="/inquiries", tags=["Inquiries"])


async def _publish_inquiry_event(
    *,
    db: AsyncSession,
    dispatcher: EventDispatcher,
    event_type: str,
    entity_id: uuid.UUID | str,
    user_id: uuid.UUID,
    changes: dict,
) -> None:
    """
    Commit ``db``, then publish an ``inquiry.*`` live event on
    ``module:inquiries``.

    Phase 9: the frontend ENTITY_TO_MODULE_CHANNEL table already maps
    ``entity="inquiry"`` to ``moduleChannel("inquiries")``, and
    ``MODULE_CHANNEL_PERMISSIONS`` already maps that channel to
    ``inquiry.read`` -- both were registered in Phase 1, but nothing
    published to them until now. Events use the item id as ``entity_id``
    (the record that actually changed) rather than the consignment id.
    """
    await dispatcher.publish_lifecycle_event(
        db,
        module="inquiries",
        entity="inquiry",
        entity_id=entity_id,
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
    """Shared helper: record an inquiry action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="inquiries",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="InquiryItem",
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


# ---------------------------------------------------------------------------
# Gallery Quotation Documents (Must be declared before /{inquiry_id} wildcards!)
# ---------------------------------------------------------------------------


@router.get("/quotation-documents", summary="Get all quotations with product & supplier metadata for Product Gallery")
async def get_all_quotation_documents(
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch all quotations with product and supplier metadata for the Product & Supplier Gallery."""
    docs = await service.quotation_repository.get_all_quotation_documents()
    return build_success_response(
        data=docs,
        request_id=request.state.request_id,
    )


# ---------------------------------------------------------------------------
# Consignment Codes (admin-managed master)
# ---------------------------------------------------------------------------


@router.post("/consignment-codes", status_code=status.HTTP_201_CREATED, summary="Create a consignment code")
async def create_consignment_code(
    payload: ConsignmentCodeCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Document: "Master to create and choose from dropdown menu"."""
    code = await service.create_consignment_code(
        code=payload.code, label=payload.label, buyer_id=payload.buyer_id, branch_id=payload.branch_id
    )
    data = ConsignmentCodeRead.model_validate(code).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=code.id,
        description=f"Created consignment code {code.code!r}.",
        new_values=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Consignment code created.")


@router.get("/consignment-codes", summary="List consignment codes")
async def list_consignment_codes(
    request: Request,
    buyer_id: uuid.UUID | None = None,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    List consignment codes, optionally scoped to one buyer (for the create-inquiry dropdown).
    """
    codes = await service.list_consignment_codes(buyer_id=buyer_id)
    data = [ConsignmentCodeRead.model_validate(c).model_dump(mode="json") for c in codes]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/consignment-codes/{consignment_code_id}/deactivate", summary="Deactivate a consignment code")
async def deactivate_consignment_code(
    consignment_code_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    code = await service.deactivate_consignment_code(consignment_code_id)
    data = ConsignmentCodeRead.model_validate(code).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=code.id,
        description=f"Deactivated consignment code {code.code!r}.",
    )
    return build_success_response(data=data, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Layer 1: company-wise summary
# ---------------------------------------------------------------------------


@router.get("/companies", summary="Layer 1: company-wise inquiry summary")
async def list_companies_summary(
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Document: "1st layer summary is company wise (for example, F&B, One Stop, Inhyma etc)"."""
    summaries = await service.list_companies_summary()
    data = [CompanySummaryRead(**s).model_dump(mode="json") for s in summaries]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/companies/{buyer_id}", summary="Layer 1 inside a company: every consignment for that buyer")
async def list_consignments_for_buyer(
    buyer_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Document: "once we click company, then it opens ... with all columns" (FB1, FB2, ...)."""
    inquiries = await service.list_consignments_for_buyer(buyer_id)
    data = [InquiryListItemRead.model_validate(i).model_dump(mode="json") for i in inquiries]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{inquiry_id}", summary="Delete a consignment")
async def delete_consignment(
    inquiry_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document (Layer-1 list): Action "Delete"."""
    await service.delete_consignment(inquiry_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=inquiry_id,
        description="Deleted consignment.",
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.deleted",
        entity_id=inquiry_id,
        user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Layer 2: items within a consignment
# ---------------------------------------------------------------------------


@router.post("/items", status_code=status.HTTP_201_CREATED, summary="Add an inquiry item (Quick Access / Add New)")
async def create_item(
    payload: InquiryItemCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """
    Add one product line to a consignment, creating the consignment header on first use.

    UOM is copied from the Product master automatically; if the product
    requires a license/certificate, the item is flagged so the list can
    highlight it in red (document's rules -- see the service docstring).
    """
    item = await service.add_item(
        buyer_id=payload.buyer_id,
        consignment_code_id=payload.consignment_code_id,
        product_id=payload.product_id,
        quantity=payload.quantity,
        brand_preference=payload.brand_preference,
        product_specs_remarks=payload.product_specs_remarks,
        status=payload.status,
        user_id=current_user.id,
    )
    data = InquiryItemRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=item.id,
        description="Added inquiry item.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.created",
        entity_id=item.id,
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id, message="Inquiry item added.")


@router.post("/items/bulk", status_code=status.HTTP_201_CREATED, summary="Add multiple inquiry items in a single request")
async def create_items_bulk(
    payload: BulkInquiryItemCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    items_raw = [item.model_dump(mode="json") for item in payload.items]
    items = await service.add_items_bulk(
        buyer_id=payload.buyer_id,
        consignment_code_id=payload.consignment_code_id,
        items_payload=items_raw,
        user_id=current_user.id,
    )
    data = [InquiryItemRead.model_validate(i).model_dump(mode="json") for i in items]
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.created",
        entity_id=payload.consignment_code_id,
        user_id=current_user.id,
        changes={"count": len(items)},
    )
    return build_success_response(data=data, request_id=request.state.request_id, message=f"Added {len(items)} inquiry items.")


@router.get("/{inquiry_id}/items", summary="Layer 2: list items in a consignment")
async def list_items(
    inquiry_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Document: "go inside and see all items of that consignment with details"."""
    items = await service.list_items(inquiry_id)
    data = [InquiryItemRead.model_validate(i).model_dump(mode="json") for i in items]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/{inquiry_id}", summary="Get a consignment with all its items")
async def get_inquiry(
    inquiry_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    inquiry_data = await service.get_inquiry_with_details(inquiry_id)
    data = InquiryRead.model_validate(inquiry_data).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{inquiry_id}/items/{item_id}", summary="Update an inquiry item (quantity, brand pref, specs)")
async def update_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: InquiryItemUpdate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document (Process Flow): "editable in quantity ... (but weight, CBM etc will not be editable)"."""
    item = await service.update_item(inquiry_id, item_id, **payload.model_dump())
    data = InquiryItemRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=item.id,
        description="Updated inquiry item.",
        new_values=payload.model_dump(exclude_none=True, mode="json"),
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.updated",
        entity_id=item.id,
        user_id=current_user.id,
        changes=payload.model_dump(exclude_none=True, mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{inquiry_id}/items/{item_id}/shift", summary="Shift an item to another consignment code")
async def shift_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: InquiryItemShift,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document (Process Flow): "shifting between FB1 & FB2"."""
    item = await service.shift_item(
        inquiry_id, item_id, to_consignment_code_id=payload.to_consignment_code_id, user_id=current_user.id
    )
    data = InquiryItemRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=item.id,
        description=f"Shifted inquiry item to consignment code {payload.to_consignment_code_id}.",
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.updated",
        entity_id=item.id,
        user_id=current_user.id,
        changes={"consignment_code_id": str(payload.to_consignment_code_id)},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{inquiry_id}/items/{item_id}/approve", summary="Approve an inquiry item")
async def approve_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document: Status moves Proposed -> Approved; Approved Date/By auto-generated from the acting user."""
    item = await service.approve_item(inquiry_id, item_id, user_id=current_user.id)
    data = InquiryItemRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.STATUS_CHANGED,
        actor=current_user,
        entity_id=item.id,
        description="Approved inquiry item.",
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.updated",
        entity_id=item.id,
        user_id=current_user.id,
        changes={"status": "Approved"},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{inquiry_id}/items/{item_id}/revert", summary="Revert an approved item back to Proposed")
async def revert_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    item = await service.revert_item_to_proposed(inquiry_id, item_id)
    data = InquiryItemRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.STATUS_CHANGED,
        actor=current_user,
        entity_id=item.id,
        description="Reverted inquiry item to Proposed.",
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.updated",
        entity_id=item.id,
        user_id=current_user.id,
        changes={"status": "Proposed"},
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{inquiry_id}/items/{item_id}/procurement-remarks", summary="Add/edit procurement team remarks")
async def set_procurement_remarks(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: InquiryItemProcurementRemarksUpdate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document: "Remarks (by Yinglima China Procurement Team) ... added or edited from 'Action' Panel"."""
    item = await service.set_procurement_remarks(inquiry_id, item_id, remarks=payload.remarks)
    data = InquiryItemRead.model_validate(item).model_dump(mode="json")
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=item.id,
        description="Updated procurement remarks on inquiry item.",
        new_values=payload.model_dump(mode="json"),
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.updated",
        entity_id=item.id,
        user_id=current_user.id,
        changes=payload.model_dump(mode="json"),
    )
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{inquiry_id}/items/{item_id}", summary="Delete an inquiry item")
async def delete_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    await service.delete_item(inquiry_id, item_id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=item_id,
        description="Deleted inquiry item.",
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="inquiry.deleted",
        entity_id=item_id,
        user_id=current_user.id,
        changes={},
    )
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Bulk actions
# ---------------------------------------------------------------------------


@router.post("/items/bulk-tally-post", summary="Mark multiple items as Tally Entry Posted")
async def bulk_mark_tally_posted(
    payload: BulkTallyPostRequest,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Document: "some easy way to select and change multiple items to 'Posted'"."""
    items = await service.bulk_mark_tally_posted(payload.item_ids, user_id=current_user.id)
    data = [InquiryItemRead.model_validate(i).model_dump(mode="json") for i in items]
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id="bulk",
        description=f"Marked {len(items)} inquiry item(s) as Tally Entry Posted.",
        new_values={"item_ids": [str(i) for i in payload.item_ids]},
    )
    # Commit once, then broadcast one event per updated item so each
    # subscriber's liveEntityStore can patch exactly the right row rather
    # than collapsing a bulk action into a single ambiguous event.
    await db.commit()
    from app.events.models import Event
    from app.events.channels import module_channel

    for item in items:
        event = Event(
            event_type="inquiry.updated",
            entity="inquiry",
            entity_id=str(item.id),
            version=None,
            user_id=str(current_user.id),
            changes={"tally_entry_posted": True},
        )
        await dispatcher.publish(module_channel("inquiries"), event, exclude_user_id=current_user.id)
    return build_success_response(data=data, request_id=request.state.request_id, message=f"{len(items)} item(s) marked Posted.")


# ---------------------------------------------------------------------------
# Quotations & RFQs
# ---------------------------------------------------------------------------


@router.get("/products/{product_id}/last-purchase", summary="Get last purchase or quote for a product")
async def get_product_last_purchase(
    product_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return latest approved purchase or quote details for a product."""
    data = await service.get_last_purchase_for_product(product_id)
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/items/{item_id}/quotations", summary="List quotations for an inquiry item")
async def list_item_quotations(
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return all supplier quotations received for a specific inquiry line item."""
    quotes = await service.list_quotations_for_item(item_id)
    return build_success_response(data=quotes, request_id=request.state.request_id)


@router.post("/items/{item_id}/quotations", status_code=status.HTTP_201_CREATED, summary="Add a quotation for an inquiry item")
async def create_item_quotation(
    item_id: uuid.UUID,
    payload: QuotationCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Record a supplier's quotation response for an inquiry item."""
    quote = await service.create_quotation(item_id, payload, user_id=current_user.id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=quote.id,
        description=f"Created quotation {quote.quote_number} for inquiry item {item_id}.",
        new_values={"quote_number": quote.quote_number, "supplier_id": str(quote.supplier_id), "total_cost": quote.total_cost},
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="quotation.created",
        entity_id=item_id,
        user_id=current_user.id,
        changes={"quote_number": quote.quote_number},
    )
    return build_success_response(
        data=QuotationRead.model_validate(quote).model_dump(mode="json"),
        request_id=request.state.request_id,
        message=f"Quotation {quote.quote_number} added successfully.",
    )


@router.patch("/quotations/{quotation_id}/status", summary="Update quotation status (approve/reject)")
async def update_quotation_status(
    quotation_id: uuid.UUID,
    payload: QuotationStatusUpdate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Approve or reject a quotation."""
    quote = await service.update_quotation_status(quotation_id, payload.status, user_id=current_user.id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=quote.id,
        description=f"Updated quotation {quote.quote_number} status to {quote.status}.",
        new_values={"status": quote.status.value if hasattr(quote.status, "value") else str(quote.status)},
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="quotation.updated",
        entity_id=quote.inquiry_item_id,
        user_id=current_user.id,
        changes={"quotation_status": str(quote.status)},
    )
    return build_success_response(
        data=QuotationRead.model_validate(quote).model_dump(mode="json"),
        request_id=request.state.request_id,
        message=f"Quotation status updated to {quote.status}.",
    )


@router.patch("/quotations/{quotation_id}", summary="Update quotation commercial details")
async def update_quotation_details(
    quotation_id: uuid.UUID,
    payload: QuotationUpdate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Update quotation commercial details (price, quantity, delivery date, currency, terms, remarks)."""
    quote = await service.update_quotation(quotation_id, payload, user_id=current_user.id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        entity_id=quote.id,
        description=f"Updated quotation {quote.quote_number} commercial details.",
        new_values=payload.model_dump(exclude_unset=True),
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="quotation.updated",
        entity_id=quote.inquiry_item_id,
        user_id=current_user.id,
        changes={"quote_number": quote.quote_number, "quotation_id": str(quote.id)},
    )
    return build_success_response(
        data=QuotationRead.model_validate(quote).model_dump(mode="json"),
        request_id=request.state.request_id,
        message=f"Quotation {quote.quote_number} updated successfully.",
    )


@router.delete("/quotations/{quotation_id}", summary="Delete a quotation")
async def delete_quotation(
    quotation_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Soft delete a quotation and resync line item status."""
    quote = await service.delete_quotation(quotation_id, user_id=current_user.id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.DELETE,
        actor=current_user,
        entity_id=quotation_id,
        description=f"Deleted quotation {quote.quote_number}.",
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="quotation.deleted",
        entity_id=quote.inquiry_item_id,
        user_id=current_user.id,
        changes={"quote_number": quote.quote_number, "quotation_id": str(quotation_id)},
    )
    return build_success_response(
        data={"id": str(quotation_id), "quote_number": quote.quote_number},
        request_id=request.state.request_id,
        message=f"Quotation {quote.quote_number} deleted successfully.",
    )


@router.post("/items/{item_id}/rfqs", status_code=status.HTTP_201_CREATED, summary="Create an RFQ for an inquiry item")
async def create_item_rfq(
    item_id: uuid.UUID,
    payload: RFQCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Create and dispatch a Request For Quotation to suppliers."""
    rfq = await service.create_rfq(item_id, payload, user_id=current_user.id)
    await _record_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        entity_id=rfq.id,
        description=f"Created RFQ for inquiry item {item_id}.",
        new_values={"supplier_type": rfq.supplier_type, "supplier_ids": rfq.supplier_ids},
    )
    await _publish_inquiry_event(
        db=db,
        dispatcher=dispatcher,
        event_type="rfq.created",
        entity_id=item_id,
        user_id=current_user.id,
        changes={"rfq_id": str(rfq.id)},
    )

    # Fetch product information for automated email dispatch
    item = await service.item_repository.get_by_id(item_id) if service.item_repository else None
    prod = (await db.execute(select(Product).where(Product.id == item.product_id))).scalars().first() if item else None
    product_name = (prod.product_name or prod.product_name_tally) if prod else "Product"
    product_code = prod.product_code if prod else None
    quantity = item.quantity if item else 1

    # Generate public supplier quotation links
    supplier_uuids = [uuid.UUID(sid) for sid in (rfq.supplier_ids or []) if sid]
    supplier_links = []
    
    if not supplier_uuids and rfq.supplier_type == "all":
        conditions = []
        if prod and prod.sub_category_id:
            conditions.append(Supplier.sub_category_links.any(SupplierSubCategoryLink.sub_category_id == prod.sub_category_id))
        if prod and prod.category_id:
            conditions.append(Supplier.category_links.any(SupplierCategoryLink.category_id == prod.category_id))
        if conditions:
            suppliers_res = (await db.execute(select(Supplier).where(Supplier.is_active == True, or_(*conditions)))).scalars().all()
        else:
            suppliers_res = (await db.execute(select(Supplier).where(Supplier.is_active == True))).scalars().all()
    elif supplier_uuids:
        suppliers_res = (await db.execute(select(Supplier).where(Supplier.id.in_(supplier_uuids)))).scalars().all()
    else:
        suppliers_res = []

    for sup in suppliers_res:
        token = generate_rfq_token(rfq.id, item_id, sup.id)
        phone = (sup.contact_whatsapp_number or sup.contact_calling_number or "").strip()
        clean_phone = "".join(ch for ch in phone if ch.isdigit() or ch == "+")
        all_emails = [e.email for e in sup.emails if getattr(e, "email", None)]
        email_str = ", ".join(all_emails)
        supplier_links.append({
            "supplier_id": str(sup.id),
            "company_name": sup.company_name,
            "contact_name": sup.contact_full_name or "Valued Partner",
            "phone": phone,
            "clean_phone": clean_phone,
            "email": email_str,
            "emails": all_emails,
            "token": token,
            "quote_path": f"/quote/{token}",
        })

    rfq_data = RFQRead.model_validate(rfq).model_dump(mode="json")
    rfq_data["supplier_links"] = supplier_links

    return build_success_response(
        data=rfq_data,
        request_id=request.state.request_id,
        message="Request For Quotation created successfully. You can now dispatch emails or share links.",
    )


class RFQManualEmailSendPayload(BaseModel):
    to_emails: list[str]
    contact_name: str
    company_name: str
    product_name: str
    product_code: str | None = None
    quantity: float | int = 1
    quote_url: str
    expected_receiving_date: str | None = None
    notes: str | None = None


@router.post("/rfqs/send-email", status_code=status.HTTP_200_OK, summary="Manually trigger automated RFQ email to supplier")
async def send_rfq_email_manual(
    payload: RFQManualEmailSendPayload,
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Send an automated RFQ email with the quotation link to a supplier via SMTP."""
    success = await send_rfq_email(
        to_emails=payload.to_emails,
        contact_name=payload.contact_name,
        company_name=payload.company_name,
        product_name=payload.product_name,
        product_code=payload.product_code,
        quantity=payload.quantity,
        quote_url=payload.quote_url,
        expected_receiving_date=payload.expected_receiving_date,
        notes=payload.notes,
    )
    if not success:
        return build_success_response(
            data={"sent": False},
            request_id=request.state.request_id,
            message="Failed to dispatch email. Please verify supplier email addresses.",
        )

    return build_success_response(
        data={"sent": True, "recipients": payload.to_emails},
        request_id=request.state.request_id,
        message=f"RFQ email successfully sent to {', '.join(payload.to_emails)}.",
    )


@router.post("/{inquiry_id}/bulk-rfqs", status_code=status.HTTP_201_CREATED, summary="Create and dispatch bulk RFQs for all or selected items in an inquiry consignment")
async def create_bulk_rfqs(
    inquiry_id: uuid.UUID,
    payload: BulkRFQCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
    db: AsyncSession = Depends(get_db_session),
    dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Dispatches a consolidated RFQ email for multiple inquiry items directly to matching suppliers."""
    import asyncio
    from sqlalchemy.orm import selectinload
    from app.inquiries.models import Inquiry, InquiryItem, RFQ, ConsignmentCode
    from app.suppliers.models import SupplierEmail
    
    # 1. Fetch Inquiry and Items
    inquiry = await db.get(Inquiry, inquiry_id)
    if not inquiry:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inquiry consignment not found")

    code_res = await db.get(ConsignmentCode, inquiry.consignment_code_id) if inquiry.consignment_code_id else None
    consignment_code_str = code_res.code if code_res else "Inquiry"

    items_query = (
        select(InquiryItem, Product)
        .join(Product, InquiryItem.product_id == Product.id)
        .where(
            InquiryItem.inquiry_id == inquiry_id,
            InquiryItem.deleted_at.is_(None),
        )
    )
    if payload.inquiry_item_ids:
        items_query = items_query.where(InquiryItem.id.in_(payload.inquiry_item_ids))
    
    items_res = await db.execute(items_query)
    inquiry_items = items_res.all()
    if not inquiry_items:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No inquiry items found to request quotation for")

    # 2. Record RFQ rows for each item
    rfq_records = []
    product_summary_list = []
    category_ids = set()
    sub_category_ids = set()

    for itm, prod in inquiry_items:
        exp_d = None
        if payload.expected_receiving_date:
            try:
                exp_d = datetime.strptime(payload.expected_receiving_date, "%Y-%m-%d").date()
            except Exception:
                pass

        rfq = RFQ(
            id=uuid.uuid4(),
            inquiry_item_id=itm.id,
            expected_receiving_date=exp_d,
            supplier_type=payload.supplier_type,
            supplier_ids=[str(s) for s in payload.supplier_ids],
            notes=payload.notes,
            status="sent",
            created_by=current_user.id,
        )
        db.add(rfq)
        rfq_records.append(rfq)

        p_name = prod.product_name or prod.product_name_tally or "Product"
        product_summary_list.append({
            "item_id": str(itm.id),
            "product_name": p_name,
            "product_code": prod.product_code,
            "quantity": itm.quantity,
            "expected_receiving_date": payload.expected_receiving_date,
            "notes": itm.product_specs_remarks or payload.notes,
        })
        if prod.category_id:
            category_ids.add(prod.category_id)
        if prod.sub_category_id:
            sub_category_ids.add(prod.sub_category_id)

    await db.commit()

    # 3. Resolve Suppliers with Eager-Loaded Emails
    supplier_uuids = [sid for sid in payload.supplier_ids if sid]
    if not supplier_uuids and payload.supplier_type == "all":
        conditions = []
        if sub_category_ids:
            conditions.append(Supplier.sub_category_links.any(SupplierSubCategoryLink.sub_category_id.in_(sub_category_ids)))
        if category_ids:
            conditions.append(Supplier.category_links.any(SupplierCategoryLink.category_id.in_(category_ids)))
        
        base_query = select(Supplier).options(selectinload(Supplier.emails)).where(Supplier.is_active == True)
        if conditions:
            suppliers_res = (await db.execute(base_query.where(or_(*conditions)))).scalars().all()
        else:
            suppliers_res = (await db.execute(base_query)).scalars().all()
    elif supplier_uuids:
        suppliers_res = (
            await db.execute(
                select(Supplier).options(selectinload(Supplier.emails)).where(Supplier.id.in_(supplier_uuids))
            )
        ).scalars().all()
    else:
        suppliers_res = []

    # 4. Dispatch Consolidated Email in Background
    dispatched_suppliers = []
    
    if payload.custom_recipient_emails:
        # User specified/edited recipient emails explicitly in Draft Mode
        clean_custom_emails = [e.strip() for e in payload.custom_recipient_emails if e and "@" in e]
        if clean_custom_emails:
            asyncio.create_task(
                send_bulk_rfq_email(
                    to_emails=clean_custom_emails,
                    contact_name="Valued Partner",
                    company_name="Supplier Partner",
                    consignment_code=consignment_code_str,
                    items=product_summary_list,
                    general_notes=payload.notes,
                    custom_subject=payload.custom_subject,
                    custom_body=payload.custom_body,
                )
            )
            dispatched_suppliers.append({
                "supplier_id": "custom",
                "company_name": "Selected Recipients",
                "emails": clean_custom_emails,
            })
    else:
        for sup in suppliers_res:
            all_emails = [e.email for e in sup.emails if getattr(e, "email", None)]
            if all_emails:
                asyncio.create_task(
                    send_bulk_rfq_email(
                        to_emails=all_emails,
                        contact_name=sup.contact_full_name or "Valued Partner",
                        company_name=sup.company_name,
                        consignment_code=consignment_code_str,
                        items=product_summary_list,
                        general_notes=payload.notes,
                        custom_subject=payload.custom_subject,
                        custom_body=payload.custom_body,
                    )
                )
                dispatched_suppliers.append({
                    "supplier_id": str(sup.id),
                    "company_name": sup.company_name,
                    "emails": all_emails,
                })

    return build_success_response(
        data={
            "item_count": len(product_summary_list),
            "dispatched_count": len(dispatched_suppliers),
            "dispatched_suppliers": dispatched_suppliers,
            "items": product_summary_list,
        },
        request_id=request.state.request_id,
        message=f"Consolidated RFQ email for {len(product_summary_list)} items successfully dispatched to {len(dispatched_suppliers)} suppliers.",
    )


from app.inquiries.ai_extractor import extract_supplier_quotation


@router.post("/items/{item_id}/ai-parse-quote", summary="AI-powered extraction of supplier quotes from text/chat/PDF")
async def ai_parse_item_quotation(
    item_id: uuid.UUID,
    request: Request,
    raw_text: str | None = Form(None),
    supplier_id: str | None = Form(None),
    file: UploadFile | None = File(None),
    session: AsyncSession = Depends(get_db_session),
    service = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Parse supplier quote text, WhatsApp/WeChat chat, or PDF quotation sheets using Gemini 2.0 Flash / OpenAI."""
    from app.inquiries.models import InquiryItem, RFQ

    stmt = select(InquiryItem).where(InquiryItem.id == item_id)
    res = await session.execute(stmt)
    item = res.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inquiry item not found")

    prod_name = item.product_name or None
    prod_code = None
    if item.product_id:
        p_res = await session.execute(select(Product).where(Product.id == item.product_id))
        p = p_res.scalar_one_or_none()
        if p:
            prod_name = prod_name or p.name
            prod_code = p.code

    rfq_res = await session.execute(select(RFQ).where(RFQ.inquiry_item_id == item_id).order_by(RFQ.created_at.desc()))
    rfq = rfq_res.scalars().first()
    target_date = str(rfq.expected_receiving_date) if rfq and rfq.expected_receiving_date else None

    file_bytes = None
    mime_type = None
    if file:
        file_bytes = await file.read()
        mime_type = file.content_type or "application/pdf"

    if not raw_text and not file_bytes:
        try:
            body = await request.json()
            raw_text = body.get("raw_text")
            if not supplier_id:
                supplier_id = body.get("supplier_id")
        except Exception:
            pass

    if not raw_text and not file_bytes:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Please provide supplier chat text, email content, or an attached quotation file (PDF/Image)."
        )

    try:
        extracted = await extract_supplier_quotation(
            text_content=raw_text,
            file_bytes=file_bytes,
            mime_type=mime_type,
            product_name=prod_name,
            product_code=prod_code,
            target_quantity=float(item.quantity) if item.quantity else None,
            target_date=target_date,
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"AI Extraction failed: {str(e)}",
        )

    return build_success_response(
        data=extracted.model_dump(mode="json"),
        request_id=request.state.request_id,
        message="Quotation extracted successfully via AI.",
    )


class InboundMessageWebhookPayload(BaseModel):
    channel: str = Field(default="email", description="email, whatsapp, wechat, zapier")
    sender: str = Field(..., description="Sender email or phone number e.g. +86138..., supplier@gmail.com")
    text: str = Field(..., description="Message text or chat transcript")
    item_id: str | None = None
    rfq_token: str | None = None


@router.post("/inbound-webhook", summary="Inbound webhook for WhatsApp, WeChat, and Email quotation auto-ingestion")
async def inbound_quotation_webhook(
    payload: InboundMessageWebhookPayload,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
    event_dispatcher: EventDispatcher = Depends(get_event_dispatcher),
) -> dict:
    """Accept incoming messages from WhatsApp/WeChat/Email webhooks, extract quote with AI, and auto-insert into ERP."""
    from app.inquiries.models import InquiryItem, Quotation, QuotationStatus, RFQ
    from app.inquiries.public_quotes import decode_rfq_token
    from app.suppliers.models import Supplier, SupplierContact, SupplierEmail

    # Match supplier
    supplier: Supplier | None = None
    s_email_res = await session.execute(
        select(SupplierEmail).where(SupplierEmail.email.ilike(payload.sender))
    )
    s_email = s_email_res.scalar_one_or_none()
    if s_email:
        supplier = await session.get(Supplier, s_email.supplier_id)

    if not supplier:
        s_contact_res = await session.execute(
            select(SupplierContact).where(SupplierContact.email.ilike(payload.sender))
        )
        s_contact = s_contact_res.scalar_one_or_none()
        if s_contact:
            supplier = await session.get(Supplier, s_contact.supplier_id)

    # Match inquiry item
    matched_item_id = None
    if payload.item_id:
        try:
            matched_item_id = uuid.UUID(payload.item_id)
        except Exception:
            pass

    if not matched_item_id and payload.rfq_token:
        try:
            rfq_data = decode_rfq_token(payload.rfq_token)
            matched_item_id = uuid.UUID(rfq_data["inquiry_item_id"])
        except Exception:
            pass

    if not matched_item_id and supplier:
        rfq_res = await session.execute(select(RFQ).order_by(RFQ.created_at.desc()).limit(10))
        for r in rfq_res.scalars().all():
            if r.supplier_ids and str(supplier.id) in r.supplier_ids:
                matched_item_id = r.inquiry_item_id
                break

    if not matched_item_id:
        recent_res = await session.execute(select(InquiryItem).order_by(InquiryItem.created_at.desc()).limit(1))
        latest_item = recent_res.scalar_one_or_none()
        if latest_item:
            matched_item_id = latest_item.id

    if not matched_item_id:
        return build_success_response(
            data={"created": False},
            request_id=request.state.request_id,
            message="No active inquiry item matched for this supplier message.",
        )

    item_res = await session.execute(select(InquiryItem).where(InquiryItem.id == matched_item_id))
    item = item_res.scalar_one_or_none()
    if not item:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inquiry line item not found")

    # Run AI Extractor
    ai_result = await extract_supplier_quotation(
        text_content=payload.text,
        product_name=item.product_name,
        product_code=item.product_code,
        target_quantity=float(item.quantity) if item.quantity else None,
    )

    if not ai_result.is_quotation_detected or not ai_result.unit_price or ai_result.unit_price <= 0:
        return build_success_response(
            data={"created": False, "is_quotation_detected": False},
            request_id=request.state.request_id,
            message="Message received, but no quotation detected (casual greeting/inquiry).",
        )

    # Insert Quotation
    quote_supplier_id = supplier.id if supplier else item.created_by
    quote_count_res = await session.execute(select(Quotation).where(Quotation.inquiry_item_id == item.id))
    existing_count = len(quote_count_res.scalars().all())
    quote_number = f"QT-WEBHOOK-{existing_count + 1:02d}"

    quoted_qty = ai_result.quantity or float(item.quantity or 1.0)
    unit_p = float(ai_result.unit_price)

    new_quotation = Quotation(
        id=uuid.uuid4(),
        quote_number=quote_number,
        inquiry_item_id=item.id,
        supplier_id=quote_supplier_id,
        quantity=quoted_qty,
        unit_price=unit_p,
        total_cost=round(quoted_qty * unit_p, 2),
        currency=ai_result.currency or "CNY",
        expected_receiving_date=datetime.strptime(ai_result.earliest_available_date, "%Y-%m-%d").date()
        if ai_result.earliest_available_date
        else None,
        terms_and_conditions=f"{ai_result.price_terms or ''} • {ai_result.payment_terms or ''}".strip(" •") or None,
        remarks=ai_result.remarks or f"Auto-ingested via {payload.channel} from {payload.sender}",
        status=QuotationStatus.PENDING,
        created_by=item.created_by,
    )
    session.add(new_quotation)
    await session.commit()

    # Broadcast Live WebSocket update to ERP UI
    await event_dispatcher.publish(
        module_channel("inquiries"),
        Event(
            entity="inquiry",
            entity_id=str(item.id),
            event_type="quotation.created",
            changes={
                "id": str(new_quotation.id),
                "inquiry_item_id": str(item.id),
                "quote_number": quote_number,
                "unit_price": unit_p,
                "currency": ai_result.currency,
                "status": "pending",
            },
        ),
    )

    return build_success_response(
        data={
            "created": True,
            "quote_number": quote_number,
            "unit_price": unit_p,
            "currency": ai_result.currency,
            "provider": ai_result.provider_used,
        },
        request_id=request.state.request_id,
        message=f"Quotation {quote_number} automatically created and broadcasted to ERP.",
    )
