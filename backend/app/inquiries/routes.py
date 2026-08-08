"""
Inquiry Routes.

Implements the document's two-layer structure directly in the URL shape:

- Layer 1 (company-wise): ``GET /inquiries/companies``
- Layer 1 inside a company: ``GET /inquiries/companies/{buyer_id}``
- Layer 2 (inside a consignment): ``GET /inquiries/{inquiry_id}/items``

Plus the admin-managed Consignment Codes master, and the bulk
Tally-Entry-Posted action.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.inquiries.dependencies import get_inquiry_service
from app.inquiries.schemas import (
    BulkTallyPostRequest,
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
)
from app.inquiries.service import InquiryService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/inquiries", tags=["Inquiries"])


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
# Consignment Codes (admin-managed master)
# ---------------------------------------------------------------------------


@router.post("/consignment-codes", status_code=status.HTTP_201_CREATED, summary="Create a consignment code")
async def create_consignment_code(
    payload: ConsignmentCodeCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.consignment_code.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Document: "Master to create and choose from dropdown menu"."""
    code = await service.create_consignment_code(code=payload.code, label=payload.label, buyer_id=payload.buyer_id)
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
    _current_user: CurrentUser = Depends(require_permission("inquiry.read")),
) -> dict:
    """
    List consignment codes, optionally scoped to one buyer (for the create-inquiry dropdown).

    Document: "respective company users should see only relevant options
    to choose, but admin can see all" -- per the confirmed scope for this
    pass, every user with inquiry.read currently sees every code
    regardless of company; enforcing the per-user company restriction is
    flagged as follow-up work (see the ``ConsignmentCode`` model
    docstring), not silently implemented here without the underlying
    "which company does this user belong to" concept existing yet.
    """
    codes = await service.list_consignment_codes(buyer_id=buyer_id)
    data = [ConsignmentCodeRead.model_validate(c).model_dump(mode="json") for c in codes]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/consignment-codes/{consignment_code_id}/deactivate", summary="Deactivate a consignment code")
async def deactivate_consignment_code(
    consignment_code_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.consignment_code.manage")),
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
    _current_user: CurrentUser = Depends(require_permission("inquiry.read")),
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
    _current_user: CurrentUser = Depends(require_permission("inquiry.read")),
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
    current_user: CurrentUser = Depends(require_permission("inquiry.delete")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Layer 2: items within a consignment
# ---------------------------------------------------------------------------


@router.post("/items", status_code=status.HTTP_201_CREATED, summary="Add an inquiry item (Quick Access / Add New)")
async def create_item(
    payload: InquiryItemCreate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.create")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id, message="Inquiry item added.")


@router.get("/{inquiry_id}/items", summary="Layer 2: list items in a consignment")
async def list_items(
    inquiry_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    _current_user: CurrentUser = Depends(require_permission("inquiry.read")),
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
    _current_user: CurrentUser = Depends(require_permission("inquiry.read")),
) -> dict:
    inquiry = await service.get_inquiry_or_raise(inquiry_id)
    data = InquiryRead.model_validate(inquiry).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{inquiry_id}/items/{item_id}", summary="Update an inquiry item (quantity, brand pref, specs)")
async def update_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: InquiryItemUpdate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{inquiry_id}/items/{item_id}/shift", summary="Shift an item to another consignment code")
async def shift_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: InquiryItemShift,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{inquiry_id}/items/{item_id}/approve", summary="Approve an inquiry item")
async def approve_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.approve")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{inquiry_id}/items/{item_id}/revert", summary="Revert an approved item back to Proposed")
async def revert_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.approve")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{inquiry_id}/items/{item_id}/procurement-remarks", summary="Add/edit procurement team remarks")
async def set_procurement_remarks(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    payload: InquiryItemProcurementRemarksUpdate,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/{inquiry_id}/items/{item_id}", summary="Delete an inquiry item")
async def delete_item(
    inquiry_id: uuid.UUID,
    item_id: uuid.UUID,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.delete")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Bulk actions
# ---------------------------------------------------------------------------


@router.post("/items/bulk-tally-post", summary="Mark multiple items as Tally Entry Posted")
async def bulk_mark_tally_posted(
    payload: BulkTallyPostRequest,
    request: Request,
    service: InquiryService = Depends(get_inquiry_service),
    current_user: CurrentUser = Depends(require_permission("inquiry.update")),
    audit_service: AuditService = Depends(get_audit_service),
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
    return build_success_response(data=data, request_id=request.state.request_id, message=f"{len(items)} item(s) marked Posted.")
