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

import logging
import uuid
from datetime import datetime

logger = logging.getLogger("inquiry_routes")

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
from app.inquiries.ai_extractor import extract_supplier_quotation
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
    InquiryMessageRead,
    InquiryRead,
    QuotationCreate,
    QuotationRead,
    QuotationStatusUpdate,
    QuotationUpdate,
    RFQCreate,
    RFQRead,
)
from app.inquiries.models import InquiryMessage
from app.inquiries.wechat_service import get_wecom_service
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

    # Fetch product information (needed both for "all suppliers" category
    # matching below, and for the automated email dispatch that follows).
    item = await service.item_repository.get_by_id(item_id) if service.item_repository else None
    prod = (await db.execute(select(Product).where(Product.id == item.product_id))).scalars().first() if item else None
    product_name = (prod.product_name or prod.product_name_tally) if prod else "Product"
    product_code = prod.product_code if prod else None
    quantity = item.quantity if item else 1

    # Generate public supplier quotation links.
    #
    # supplier_type == "all": resolve every ACTIVE supplier linked to this
    # product's Category and/or Sub-Category (via SupplierCategoryLink /
    # SupplierSubCategoryLink), falling back to every active supplier if
    # the product has no category/sub-category set. This matches the
    # "All Suppliers (Category & Sub-Category)" option in the Request
    # Quotation dialog on the frontend.
    #
    # Otherwise (or if the frontend already resolved and sent explicit
    # supplier_ids): use exactly the suppliers given.
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

    # Automatically dispatch emails in the background for suppliers with email addresses
    base_host = request.headers.get("origin") or "http://192.168.1.23:5173"
    for link in supplier_links:
        if link.get("emails"):
            full_quote_url = f"{base_host}{link['quote_path']}"
            import asyncio
            asyncio.create_task(
                send_rfq_email(
                    to_emails=link["emails"],
                    contact_name=link["contact_name"],
                    company_name=link["company_name"],
                    product_name=product_name,
                    product_code=product_code,
                    quantity=quantity,
                    quote_url=full_quote_url,
                    expected_receiving_date=str(rfq.expected_receiving_date) if rfq.expected_receiving_date else None,
                    notes=rfq.notes,
                )
            )

    rfq_data = RFQRead.model_validate(rfq).model_dump(mode="json")
    rfq_data["supplier_links"] = supplier_links

    return build_success_response(
        data=rfq_data,
        request_id=request.state.request_id,
        message="Request For Quotation dispatched and automated emails sent successfully.",
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

    # 4. Dispatch Multi-Channel RFQs (Email and WeChat)
    dispatched_suppliers = []
    channels = payload.channels or ["email", "wechat"]
    wecom = get_wecom_service()

    # --- EMAIL DISPATCH ---
    if "email" in channels:
        if payload.custom_recipient_emails:
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
                # Log Outbound Email Message
                single_item_id = payload.inquiry_item_ids[0] if (payload.inquiry_item_ids and len(payload.inquiry_item_ids) == 1) else (inquiry_items[0][0].id if len(inquiry_items) == 1 else None)
                email_log = InquiryMessage(
                    id=uuid.uuid4(),
                    inquiry_id=inquiry_id,
                    inquiry_item_id=single_item_id,
                    channel="email",
                    direction="outbound",
                    sender_name="Yinglima Procurement",
                    recipient_contact=", ".join(clean_custom_emails),
                    message_text=payload.custom_body or f"Dispatched RFQ for {len(product_summary_list)} products.",
                )
                db.add(email_log)
                dispatched_suppliers.append({
                    "supplier_id": "custom",
                    "company_name": "Selected Recipients",
                    "emails": clean_custom_emails,
                    "channel": "email",
                })
        else:
            single_item_id = payload.inquiry_item_ids[0] if (payload.inquiry_item_ids and len(payload.inquiry_item_ids) == 1) else (inquiry_items[0][0].id if len(inquiry_items) == 1 else None)
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
                    email_log = InquiryMessage(
                        id=uuid.uuid4(),
                        inquiry_id=inquiry_id,
                        inquiry_item_id=single_item_id,
                        supplier_id=sup.id,
                        channel="email",
                        direction="outbound",
                        sender_name="Yinglima Procurement",
                        recipient_contact=", ".join(all_emails),
                        message_text=f"Consolidated RFQ email sent to {sup.company_name} ({len(product_summary_list)} items).",
                    )
                    db.add(email_log)
                    dispatched_suppliers.append({
                        "supplier_id": str(sup.id),
                        "company_name": sup.company_name,
                        "emails": all_emails,
                        "channel": "email",
                    })

    # --- WECHAT DISPATCH ---
    if "wechat" in channels:
        wechat_recipients: list[str] = []
        if payload.custom_recipient_wechat_numbers:
            wechat_recipients = [w.strip() for w in payload.custom_recipient_wechat_numbers if w.strip()]
        else:
            for sup in suppliers_res:
                wc_num = getattr(sup, "contact_wechat_number", None) or getattr(sup, "wechat_number", None)
                if wc_num and wc_num.strip():
                    wechat_recipients.append(wc_num.strip())

        if wechat_recipients:
            try:
                single_item_id = payload.inquiry_item_ids[0] if (payload.inquiry_item_ids and len(payload.inquiry_item_ids) == 1) else (inquiry_items[0][0].id if len(inquiry_items) == 1 else None)
                wecom_res = wecom.send_rfq_markdown_message(
                    to_users=wechat_recipients,
                    consignment_code=consignment_code_str,
                    items=product_summary_list,
                    general_notes=payload.notes,
                )
                invalid_users = wecom_res.get("invaliduser", "") if isinstance(wecom_res, dict) else ""
                status_note = f"\n⚠️ Notice: Tencent reported unregistered WeCom user(s): {invalid_users}" if invalid_users else ""
                prod_lines = "\n".join(f"• {p.get('product_name')} (Qty: {p.get('quantity')})" for p in product_summary_list)

                wc_log = InquiryMessage(
                    id=uuid.uuid4(),
                    inquiry_id=inquiry_id,
                    inquiry_item_id=single_item_id,
                    channel="wechat",
                    direction="outbound",
                    sender_name="Yinglima ERP Bot",
                    recipient_contact=", ".join(wechat_recipients),
                    message_text=(
                        f"WeChat RFQ card dispatched to {len(wechat_recipients)} recipient(s) [{', '.join(wechat_recipients)}] for consignment [#{consignment_code_str}].\n\n"
                        f"📦 Products Included ({len(product_summary_list)}):\n{prod_lines}"
                        f"{status_note}"
                    ),
                )
                db.add(wc_log)
                dispatched_suppliers.append({
                    "supplier_id": "wechat_group",
                    "company_name": "WeChat Suppliers",
                    "wechat_recipients": wechat_recipients,
                    "channel": "wechat",
                    "wecom_res": wecom_res,
                })
            except Exception as we_err:
                logger.warning("WeChat dispatch encountered note: %s", str(we_err))

    await db.commit()

    # Broadcast Live WebSocket update for Messages Tab
    await dispatcher.publish(
        module_channel("inquiries"),
        Event(
            entity="inquiry",
            entity_id=str(inquiry_id),
            event_type="inquiry.message.created",
            changes={"inquiry_id": str(inquiry_id)},
        ),
    )

    return build_success_response(
        data={
            "item_count": len(product_summary_list),
            "dispatched_count": len(dispatched_suppliers),
            "dispatched_suppliers": dispatched_suppliers,
            "items": product_summary_list,
        },
        request_id=request.state.request_id,
        message=f"Consolidated RFQ for {len(product_summary_list)} items successfully dispatched across selected channels.",
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

    # Same as above: InquiryItem has no product_name/product_code of its
    # own, look them up via the linked Product.
    prod_name = None
    prod_code = None
    if item.product_id:
        p_res = await session.execute(select(Product).where(Product.id == item.product_id))
        p = p_res.scalar_one_or_none()
        if p:
            prod_name = p.product_name_tally or p.product_name
            prod_code = p.product_code

    # 1. Always record Inbound Email/Message in InquiryMessage timeline
    inbound_msg = InquiryMessage(
        id=uuid.uuid4(),
        inquiry_id=item.inquiry_id,
        inquiry_item_id=item.id,
        supplier_id=supplier.id if supplier else None,
        channel=payload.channel or "email",
        direction="inbound",
        sender_name=supplier.company_name if supplier else payload.sender,
        sender_contact=payload.sender,
        recipient_contact="Yinglima Procurement",
        message_text=payload.text,
    )
    session.add(inbound_msg)
    await session.commit()

    # Broadcast Live WebSocket update for Messages/Emails Tab
    await event_dispatcher.publish(
        module_channel("inquiries"),
        Event(
            entity="inquiry",
            entity_id=str(item.inquiry_id),
            event_type="inquiry.message.created",
            changes={"inquiry_id": str(item.inquiry_id)},
        ),
    )

    # 2. Run AI Extractor
    ai_result = await extract_supplier_quotation(
        text_content=payload.text,
        product_name=prod_name,
        product_code=prod_code,
        target_quantity=float(item.quantity) if item.quantity else None,
    )

    if not ai_result.is_quotation_detected or not ai_result.unit_price or ai_result.unit_price <= 0:
        return build_success_response(
            data={"created": False, "is_quotation_detected": False},
            request_id=request.state.request_id,
            message="Message received and logged, but no commercial quotation price detected.",
        )

    # 3. Resolve Supplier ID properly
    quote_supplier_id = supplier.id if supplier else None
    if not quote_supplier_id:
        if item.proposed_by:
            quote_supplier_id = item.proposed_by
        else:
            first_supp = (await session.execute(select(Supplier.id).where(Supplier.deleted_at.is_(None)).limit(1))).scalar_one_or_none()
            quote_supplier_id = first_supp

    # Check if a quote already exists for this (Item, Supplier)
    existing_quote_res = await session.execute(
        select(Quotation).where(
            Quotation.inquiry_item_id == item.id,
            Quotation.supplier_id == quote_supplier_id,
            Quotation.deleted_at.is_(None),
        )
    )
    existing_quote = existing_quote_res.scalars().first()

    if existing_quote:
        # Business Rule: 1 initial quotation per (Supplier, Item).
        # Subsequent chats/emails are logged to the timeline above, but do NOT spawn duplicate quote rows.
        logger.info(
            "Item %s already has an initial quotation (%s) from supplier %s. Skipping new quote creation.",
            item.id,
            existing_quote.quote_number,
            quote_supplier_id,
        )
        return build_success_response(
            data={"created": False, "is_quotation_detected": True, "quote_number": existing_quote.quote_number},
            request_id=request.state.request_id,
            message=f"Inbound email logged to Emails timeline. Initial quote ({existing_quote.quote_number}) already exists.",
        )

    quoted_qty = ai_result.quantity or float(item.quantity or 1.0)
    unit_p = float(ai_result.unit_price)

    quote_count_res = await session.execute(
        select(Quotation).where(
            Quotation.inquiry_item_id == item.id,
            Quotation.deleted_at.is_(None),
        )
    )
    existing_count = len(quote_count_res.scalars().all())
    quote_number = f"QT-AUTO-{existing_count + 1:02d}"

    new_quotation = Quotation(
        id=uuid.uuid4(),
        quote_number=quote_number,
        inquiry_item_id=item.id,
        supplier_id=quote_supplier_id,
        quantity=quoted_qty,
        unit_price=unit_p,
        total_cost=round(quoted_qty * unit_p, 2),
        currency=ai_result.currency or "USD",
        expected_receiving_date=datetime.strptime(ai_result.earliest_available_date, "%Y-%m-%d").date()
        if ai_result.earliest_available_date
        else None,
        terms_and_conditions=f"{ai_result.price_terms or ''} • {ai_result.payment_terms or ''}".strip(" •") or None,
        remarks=ai_result.remarks or f"Auto-ingested via {payload.channel} from {payload.sender}",
        status=QuotationStatus.PENDING,
        created_by=item.proposed_by,
    )
    session.add(new_quotation)
    await session.commit()
    quote_id_str = str(new_quotation.id)

    # Broadcast Live WebSocket update to ERP UI
    await event_dispatcher.publish(
        module_channel("inquiries"),
        Event(
            entity="inquiry",
            entity_id=str(item.id),
            event_type="quotation.created",
            changes={
                "id": quote_id_str,
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


# ---------------------------------------------------------------------------
# Communication Timeline & Messages Tab Endpoints
# ---------------------------------------------------------------------------

@router.get("/{inquiry_id}/messages", summary="Fetch all communication messages for an inquiry consignment")
async def get_inquiry_messages(
    inquiry_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Returns chronological communication messages (WeChat, Email, System) for the Messages tab."""
    stmt = (
        select(InquiryMessage, Supplier.company_name)
        .join(Supplier, InquiryMessage.supplier_id == Supplier.id, isouter=True)
        .where(
            InquiryMessage.inquiry_id == inquiry_id,
            InquiryMessage.deleted_at.is_(None),
        )
        .order_by(InquiryMessage.created_at.asc())
    )
    res = await db.execute(stmt)
    rows = res.all()

    messages_data = []
    for msg, sup_name in rows:
        messages_data.append({
            "id": str(msg.id),
            "inquiry_id": str(msg.inquiry_id),
            "inquiry_item_id": str(msg.inquiry_item_id) if msg.inquiry_item_id else None,
            "supplier_id": str(msg.supplier_id) if msg.supplier_id else None,
            "supplier_name": sup_name,
            "channel": msg.channel,
            "direction": msg.direction,
            "sender_name": msg.sender_name,
            "sender_contact": msg.sender_contact,
            "recipient_contact": msg.recipient_contact,
            "message_text": msg.message_text,
            "attachment_url": msg.attachment_url,
            "attachment_filename": msg.attachment_filename,
            "created_at": msg.created_at.isoformat() if msg.created_at else None,
        })

    return build_success_response(
        data=messages_data,
        request_id=request.state.request_id,
        message=f"Retrieved {len(messages_data)} communication messages.",
    )


# ---------------------------------------------------------------------------
# WeCom (WeChat Work) Callback URL Handshake & Decryption (Doc 90556)
# ---------------------------------------------------------------------------

@router.get("/wechat/callback", summary="WeCom Callback URL verification handshake")
async def wechat_callback_handshake(
    msg_signature: str,
    timestamp: str,
    nonce: str,
    echostr: str,
):
    """
    Handles GET verification from Tencent WeCom servers per Doc 90556.
    Decrypts echostr and returns plaintext to confirm callback validity.
    """
    from fastapi.responses import PlainTextResponse

    wecom = get_wecom_service()
    try:
        decrypted_echo = wecom.decrypt_echostr(msg_signature, timestamp, nonce, echostr)
        return PlainTextResponse(content=decrypted_echo, status_code=200)
    except Exception as err:
        logger.error("WeCom URL Handshake Verification Failed: %s", str(err))
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="WeCom Signature Verification Failed")


@router.post("/wechat/callback", summary="WeCom Inbound Message Webhook")
async def wechat_inbound_message_callback(
    msg_signature: str,
    timestamp: str,
    nonce: str,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
    event_dispatcher: EventDispatcher = Depends(get_event_dispatcher),
):
    """
    Receives encrypted incoming WeChat replies from suppliers.
    Decrypts XML -> records message in timeline -> runs conversational AI quotation extraction.
    """
    from fastapi.responses import PlainTextResponse
    import re
    from app.inquiries.models import Inquiry, InquiryItem, Quotation, QuotationStatus, ConsignmentCode
    from app.suppliers.models import Supplier, SupplierContact

    body_bytes = await request.body()
    post_xml = body_bytes.decode("utf-8")

    wecom = get_wecom_service()
    try:
        msg_dict = wecom.decrypt_message(msg_signature, timestamp, nonce, post_xml)
    except Exception as err:
        logger.error("Failed to decrypt incoming WeCom message: %s", str(err))
        return PlainTextResponse(content="success", status_code=200)

    from_user = msg_dict.get("FromUserName", "")  # WeCom UserID / External UserID
    msg_type = msg_dict.get("MsgType", "")
    content = msg_dict.get("Content", "")

    if not content or msg_type != "text":
        # Successfully acknowledge non-text or event packets
        return PlainTextResponse(content="success", status_code=200)

    # 1. Match Supplier via WeCom UserID or WeChat Number
    supplier: Supplier | None = None
    all_suppliers_res = await session.execute(select(Supplier).limit(100))
    for s in all_suppliers_res.scalars().all():
        wc_num = getattr(s, "contact_wechat_number", None) or getattr(s, "wechat_number", None)
        if wc_num and (wc_num.lower() in from_user.lower() or from_user.lower() in wc_num.lower()):
            supplier = s
            break

    if not supplier:
        # Fallback to matching SupplierContact
        contacts_res = await session.execute(select(SupplierContact).limit(100))
        for c in contacts_res.scalars().all():
            if c.wechat_number and (c.wechat_number.lower() in from_user.lower() or from_user.lower() in c.wechat_number.lower()):
                supplier = await session.get(Supplier, c.supplier_id)
                break

    # 2. Match Consignment from Subject / Code (e.g. [#FB1]) or active recent inquiries
    matched_inquiry: Inquiry | None = None
    code_match = re.search(r"\[#?([a-zA-Z0-9_\-]+)\]", content) or re.search(r"#([a-zA-Z0-9_\-]+)", content)
    if code_match:
        found_code = code_match.group(1).strip()
        cc_res = await session.execute(select(ConsignmentCode).where(ConsignmentCode.code.ilike(found_code)))
        cc_obj = cc_res.scalars().first()
        if cc_obj:
            inq_res = await session.execute(select(Inquiry).where(Inquiry.consignment_code_id == cc_obj.id))
            matched_inquiry = inq_res.scalars().first()

    if not matched_inquiry:
        recent_inq_res = await session.execute(select(Inquiry).order_by(Inquiry.created_at.desc()).limit(1))
        matched_inquiry = recent_inq_res.scalars().first()

    if not matched_inquiry:
        return PlainTextResponse(content="success", status_code=200)

    # 3. Record Inbound Message in Timeline
    inbound_msg = InquiryMessage(
        id=uuid.uuid4(),
        inquiry_id=matched_inquiry.id,
        supplier_id=supplier.id if supplier else None,
        channel="wechat",
        direction="inbound",
        sender_name=supplier.company_name if supplier else f"WeChat ({from_user})",
        sender_contact=from_user,
        recipient_contact="Yinglima ERP Bot",
        message_text=content,
    )
    session.add(inbound_msg)
    await session.commit()

    # Broadcast Live WebSocket update for Messages Tab
    await event_dispatcher.publish(
        module_channel("inquiries"),
        Event(
            entity="inquiry",
            entity_id=str(matched_inquiry.id),
            event_type="inquiry.message.created",
            changes={"inquiry_id": str(matched_inquiry.id)},
        ),
    )

    # 4. Conversational AI Extraction (Passing recent chat history for fragmented message support)
    # Fetch candidate items in consignment
    consignment_items_res = await session.execute(
        select(InquiryItem, Product)
        .join(Product, InquiryItem.product_id == Product.id)
        .where(
            InquiryItem.inquiry_id == matched_inquiry.id,
            InquiryItem.deleted_at.is_(None),
        )
    )
    consignment_items = consignment_items_res.all()
    if not consignment_items:
        return PlainTextResponse(content="success", status_code=200)

    # Gather last 5 chat messages for context
    history_res = await session.execute(
        select(InquiryMessage)
        .where(
            InquiryMessage.inquiry_id == matched_inquiry.id,
            InquiryMessage.deleted_at.is_(None),
        )
        .order_by(InquiryMessage.created_at.desc())
        .limit(5)
    )
    recent_messages = list(reversed(history_res.scalars().all()))
    combined_chat_context = "\n".join(f"[{m.sender_name or m.channel}]: {m.message_text}" for m in recent_messages)

    candidate_items_list = [
        {
            "item_id": str(ci.id),
            "product_code": cp.product_code or "N/A",
            "product_name": cp.product_name or cp.product_name_tally or "Product",
            "target_quantity": float(ci.quantity or 1.0),
        }
        for ci, cp in consignment_items
    ]

    ai_result = await extract_supplier_quotation(
        text_content=f"{combined_chat_context}\n\nLatest message: {content}",
        candidate_items=candidate_items_list,
    )

    if ai_result.is_quotation_detected:
        quote_supplier_id = supplier.id if supplier else (await session.execute(select(Supplier.id).limit(1))).scalar_one()
        quotes_to_process = ai_result.quotes if ai_result.quotes else []
        if not quotes_to_process and ai_result.unit_price:
            quotes_to_process = [{
                "product_name": consignment_items[0][1].product_name,
                "product_code": consignment_items[0][1].product_code,
                "unit_price": ai_result.unit_price,
                "currency": ai_result.currency,
                "quantity": ai_result.quantity,
                "earliest_available_date": ai_result.earliest_available_date,
                "price_terms": ai_result.price_terms,
                "payment_terms": ai_result.payment_terms,
                "remarks": ai_result.remarks,
            }]

        for q_obj in quotes_to_process:
            q_dict = q_obj if isinstance(q_obj, dict) else q_obj.model_dump()
            unit_p = q_dict.get("unit_price")
            if not unit_p or float(unit_p) <= 0:
                continue

            target_item = consignment_items[0][0]
            ai_pcode = re.sub(r"[^a-z0-9]", "", (q_dict.get("product_code") or "").lower())
            if ai_pcode:
                for c_item, c_prod in consignment_items:
                    cp_code = re.sub(r"[^a-z0-9]", "", (c_prod.product_code or "").lower())
                    if cp_code and (ai_pcode == cp_code or ai_pcode in cp_code or cp_code in ai_pcode):
                        target_item = c_item
                        break

            # 1-Quote rule per (Supplier, Item): Update existing quotation or create new initial quote
            existing_supp_quote_res = await session.execute(
                select(Quotation).where(
                    Quotation.inquiry_item_id == target_item.id,
                    Quotation.supplier_id == quote_supplier_id,
                    Quotation.deleted_at.is_(None),
                )
            )
            existing_quote = existing_supp_quote_res.scalars().first()

            quoted_qty = q_dict.get("quantity") or float(target_item.quantity or 1.0)
            quoted_unit_price = float(unit_p)
            quote_currency = q_dict.get("currency") or ai_result.currency or "CNY"
            total_cost = round(quoted_qty * quoted_unit_price, 2)

            t_parts = []
            if q_dict.get("price_terms"):
                t_parts.append(q_dict["price_terms"])
            if q_dict.get("payment_terms"):
                t_parts.append(q_dict["payment_terms"])
            terms_combined = " • ".join(t_parts) if t_parts else None

            exp_date = None
            date_val = q_dict.get("earliest_available_date") or ai_result.earliest_available_date
            if date_val:
                try:
                    exp_date = datetime.strptime(date_val, "%Y-%m-%d").date()
                except Exception:
                    pass

            if existing_quote:
                # Update existing quote with negotiation updates
                existing_quote.unit_price = quoted_unit_price
                existing_quote.total_cost = total_cost
                existing_quote.currency = quote_currency
                if exp_date:
                    existing_quote.expected_receiving_date = exp_date
                if terms_combined:
                    existing_quote.terms_and_conditions = terms_combined
                existing_quote.remarks = f"Updated via WeChat chat from {from_user}"
                await session.commit()
                await event_dispatcher.publish(
                    module_channel("inquiries"),
                    Event(
                        entity="inquiry",
                        entity_id=str(target_item.id),
                        event_type="quotation.updated",
                        changes={"id": str(existing_quote.id), "unit_price": quoted_unit_price},
                    ),
                )
            else:
                # Create initial quote
                quote_count_res = await session.execute(
                    select(Quotation).where(
                        Quotation.inquiry_item_id == target_item.id,
                        Quotation.deleted_at.is_(None),
                    )
                )
                existing_count = len(quote_count_res.scalars().all())
                quote_number = f"QT-AUTO-{existing_count + 1:02d}"

                new_quotation = Quotation(
                    id=uuid.uuid4(),
                    quote_number=quote_number,
                    inquiry_item_id=target_item.id,
                    supplier_id=quote_supplier_id,
                    quantity=quoted_qty,
                    unit_price=quoted_unit_price,
                    total_cost=total_cost,
                    currency=quote_currency,
                    expected_receiving_date=exp_date,
                    terms_and_conditions=terms_combined,
                    remarks=f"Auto-extracted via WeChat from {from_user}",
                    status=QuotationStatus.PENDING,
                    created_by=target_item.proposed_by,
                )
                session.add(new_quotation)
                await session.commit()
                await event_dispatcher.publish(
                    module_channel("inquiries"),
                    Event(
                        entity="inquiry",
                        entity_id=str(target_item.id),
                        event_type="quotation.created",
                        changes={"id": str(new_quotation.id), "quote_number": quote_number},
                    ),
                )

    return PlainTextResponse(content="success", status_code=200)
