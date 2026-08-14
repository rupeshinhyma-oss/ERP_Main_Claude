"""
Inquiry Service.

Business logic for the Inquiry (Requirement) workflow, encoding the
document's rules:

- Product Name / Quantity / Status are mandatory; Brand Preference and
  Product Specs/Remarks are optional (document: "these 2 fields
  Optional, Rest all Mandatory").
- UOM is copied from the selected Product automatically, never entered
  by the user directly (document: "UOM to reflect automatically as per
  inventory master of that item").
- If the selected Product has ``license_certificate_required`` set, the
  item is flagged so the list can highlight it in red and surface the
  requirement in its remarks (document: "highlight in RED colour and
  show that in Remark in List").
- Proposed/Approved Date and Proposed/Approved By are always
  auto-generated from the acting user, never accepted as input (document:
  "field not needed, but auto generated from user login").
- A consignment's rollup status is Proposed / Partial Approved / Fully
  Approved depending on its items' individual statuses.
- Bulk "mark as Tally Entry Posted" is supported across multiple items in
  one call (document: "some easy way to select and change multiple items
  to 'Posted'").
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from app.buyers.repository import BuyerRepository
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.inquiries.models import ConsignmentCode, Inquiry, InquiryConsignmentStatus, InquiryItem, InquiryItemStatus
from app.inquiries.repository import ConsignmentCodeRepository, InquiryItemRepository, InquiryRepository
from app.masters.products.repository import ProductRepository


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class InquiryService:
    """Orchestrates the Inquiry (Requirement) workflow on top of its three repositories."""

    def __init__(
        self,
        inquiry_repository: InquiryRepository,
        item_repository: InquiryItemRepository,
        consignment_code_repository: ConsignmentCodeRepository,
        buyer_repository: BuyerRepository,
        product_repository: ProductRepository,
    ) -> None:
        self.inquiry_repository = inquiry_repository
        self.item_repository = item_repository
        self.consignment_code_repository = consignment_code_repository
        self.buyer_repository = buyer_repository
        self.product_repository = product_repository

    # ------------------------------------------------------------------
    # Consignment Codes (admin-managed master)
    # ------------------------------------------------------------------

    async def create_consignment_code(
        self, *, code: str, label: str | None, buyer_id: uuid.UUID, branch_id: str | None = None
    ) -> ConsignmentCode:
        """Document: "Master to create and choose from dropdown menu"."""
        code = code.strip().upper()
        if not code:
            raise BadRequestException("Consignment code is required.")
        if await self.buyer_repository.get_by_id(buyer_id) is None:
            raise BadRequestException("The specified buyer does not exist.")
        if await self.consignment_code_repository.get_by_code(code):
            raise ConflictException(f"Consignment code {code!r} already exists.")
        return await self.consignment_code_repository.create(code=code, label=label, buyer_id=buyer_id, branch_id=branch_id)

    async def list_consignment_codes(self, *, buyer_id: uuid.UUID | None = None) -> list[ConsignmentCode]:
        if buyer_id is not None:
            return await self.consignment_code_repository.list_for_buyer(buyer_id)
        return await self.consignment_code_repository.list(limit=1000)

    async def deactivate_consignment_code(self, consignment_code_id: uuid.UUID) -> ConsignmentCode:
        code = await self.consignment_code_repository.get_by_id(consignment_code_id)
        if code is None:
            raise NotFoundException("Consignment code not found.")
        from app.core.constants import RecordStatus

        return await self.consignment_code_repository.update(code, status=RecordStatus.INACTIVE)

    # ------------------------------------------------------------------
    # Layer 1: consignments, company-wise summary
    # ------------------------------------------------------------------

    async def get_inquiry_or_raise(self, inquiry_id: uuid.UUID) -> Inquiry:
        inquiry = await self.inquiry_repository.get_by_id(inquiry_id)
        if inquiry is None:
            raise NotFoundException("Inquiry (consignment) not found.")
        return inquiry

    async def get_or_create_consignment(
        self, *, buyer_id: uuid.UUID, consignment_code_id: uuid.UUID, user_id: uuid.UUID
    ) -> Inquiry:
        """
        Fetch the consignment for (buyer, consignment_code), creating it on first use.

        A consignment header only really matters once it has at least one
        item; rather than force a separate "create consignment" step
        before "add item" (which the document never describes as a
        distinct action), the header is created transparently the first
        time an item is added against a given buyer+code pair.
        """
        if await self.buyer_repository.get_by_id(buyer_id) is None:
            raise BadRequestException("The specified buyer does not exist.")
        code = await self.consignment_code_repository.get_by_id(consignment_code_id)
        if code is None:
            raise BadRequestException("The specified consignment code does not exist.")
        if code.buyer_id != buyer_id:
            raise BadRequestException("This consignment code does not belong to the specified buyer.")

        existing = await self.inquiry_repository.get_by_buyer_and_code(buyer_id, consignment_code_id)
        if existing is not None:
            return existing
        return await self.inquiry_repository.create(
            buyer_id=buyer_id, consignment_code_id=consignment_code_id, created_by=user_id
        )

    async def list_companies_summary(self) -> list[dict]:
        """
        Layer 1, company-wise: one row per buyer with at least one consignment.

        Document: "1st layer summary is company wise (for example, F&B,
        One Stop, Inhyma etc)".

        Phase 8: computed via one grouped SQL query
        (``InquiryRepository.get_company_summaries``) instead of a
        per-buyer query loop -- see that method's docstring.
        """
        buyer_ids = await self.inquiry_repository.list_distinct_buyer_ids()
        summaries = []
        for buyer_id in buyer_ids:
            buyer = await self.buyer_repository.get_by_id(buyer_id)
            consignments = await self.inquiry_repository.list_for_buyer(buyer_id)
            if not consignments:
                continue
            code_list: list[str] = []
            statuses: list[InquiryConsignmentStatus] = []
            for c in consignments:
                statuses.append(c.consignment_status)
                if c.consignment_code_id:
                    cc = await self.consignment_code_repository.get_by_id(c.consignment_code_id)
                    if cc and cc.code:
                        code_list.append(cc.code)

            if statuses and all(s == InquiryConsignmentStatus.FULLY_APPROVED for s in statuses):
                overall_status = InquiryConsignmentStatus.FULLY_APPROVED
            elif any(s in (InquiryConsignmentStatus.PARTIAL_APPROVED, InquiryConsignmentStatus.FULLY_APPROVED) for s in statuses):
                overall_status = InquiryConsignmentStatus.PARTIAL_APPROVED
            else:
                overall_status = InquiryConsignmentStatus.PROPOSED

            prop_cnt = sum(1 for s in statuses if s == InquiryConsignmentStatus.PROPOSED)
            app_cnt = sum(1 for s in statuses if s in (InquiryConsignmentStatus.PARTIAL_APPROVED, InquiryConsignmentStatus.FULLY_APPROVED))

            latest_updated = max([c.updated_at for c in consignments]) if consignments else None

            summaries.append(
                {
                    "buyer_id": buyer_id,
                    "company_name": buyer.company_name if buyer else "Unknown Company",
                    "consignment_count": len(consignments),
                    "proposed_count": prop_cnt,
                    "approved_count": app_cnt,
                    "total_cbm": sum(c.total_cbm for c in consignments),
                    "total_weight": sum(c.total_weight for c in consignments),
                    "consignment_status": overall_status,
                    "consignment_codes": code_list,
                    "updated_at": latest_updated,
                }
            )
        return summaries

    async def list_consignments_for_buyer(self, buyer_id: uuid.UUID) -> list[Inquiry]:
        """Layer 1 inside one company: every consignment code for that buyer (document: "FB1, FB2...")."""
        if await self.buyer_repository.get_by_id(buyer_id) is None:
            raise NotFoundException("Buyer not found.")
        return await self.inquiry_repository.list_for_buyer(buyer_id)

    async def _refresh_rollup(self, inquiry_id: uuid.UUID) -> Inquiry:
        """Recompute and persist one consignment's Layer-1 rollup fields from its current items."""
        inquiry = await self.get_inquiry_or_raise(inquiry_id)
        rollup = await self.item_repository.compute_rollup(inquiry_id)
        return await self.inquiry_repository.update(
            inquiry,
            total_cbm=rollup["total_cbm"],
            total_weight=rollup["total_weight"],
            consignment_status=rollup["status"],
        )

    async def delete_consignment(self, inquiry_id: uuid.UUID) -> None:
        """Document: Layer-1 list Action "Delete"."""
        inquiry = await self.get_inquiry_or_raise(inquiry_id)
        await self.inquiry_repository.delete(inquiry)
        if inquiry.consignment_code_id:
            cc = await self.consignment_code_repository.get_by_id(inquiry.consignment_code_id)
            if cc:
                await self.consignment_code_repository.delete(cc)

    # ------------------------------------------------------------------
    # Layer 2: items within a consignment
    # ------------------------------------------------------------------

    async def list_items(self, inquiry_id: uuid.UUID) -> list[InquiryItem]:
        await self.get_inquiry_or_raise(inquiry_id)
        return await self.item_repository.list_for_inquiry(inquiry_id)

    async def get_item_or_raise(self, inquiry_id: uuid.UUID, item_id: uuid.UUID) -> InquiryItem:
        item = await self.item_repository.get_by_id(item_id)
        if item is None or item.inquiry_id != inquiry_id:
            raise NotFoundException("Inquiry item not found.")
        return item

    async def add_item(
        self,
        *,
        buyer_id: uuid.UUID,
        consignment_code_id: uuid.UUID,
        product_id: uuid.UUID,
        quantity: float,
        brand_preference: str | None,
        product_specs_remarks: str | None,
        status: InquiryItemStatus,
        user_id: uuid.UUID,
    ) -> InquiryItem:
        """
        Add one product line to a consignment (creating the consignment header on first use).

        UOM is copied from the Product master (never accepted as
        caller input); the license-required highlight flag is set from
        the Product master too, at creation time.
        """
        if quantity <= 0:
            raise BadRequestException("Quantity must be greater than zero.")

        product = await self.product_repository.get_by_id(product_id)
        if product is None:
            raise BadRequestException("The specified product does not exist.")

        inquiry = await self.get_or_create_consignment(
            buyer_id=buyer_id, consignment_code_id=consignment_code_id, user_id=user_id
        )

        now = _utcnow()
        item = await self.item_repository.create(
            inquiry_id=inquiry.id,
            product_id=product_id,
            uom_id=product.uom_id,
            quantity=quantity,
            brand_preference=brand_preference,
            product_specs_remarks=product_specs_remarks,
            status=status,
            proposed_at=now,
            proposed_by=user_id,
            approved_at=now if status == InquiryItemStatus.APPROVED else None,
            approved_by=user_id if status == InquiryItemStatus.APPROVED else None,
            tally_entry_posted=False,
            requires_license=bool(getattr(product, "license_certificate_required", None)),
        )
        await self._refresh_rollup(inquiry.id)
        return item

    async def update_item(self, inquiry_id: uuid.UUID, item_id: uuid.UUID, **field_values: Any) -> InquiryItem:
        """
        Update an inquiry item's editable fields.

        Document (Process Flow): "editable in quantity, shifting between
        FB1 & FB2 (but weight, CBM etc will not be editable)" -- weight/
        CBM are consignment-level rollups computed by the service, never
        accepted as direct input here, so there is no field for them on
        this call in the first place.
        """
        item = await self.get_item_or_raise(inquiry_id, item_id)

        new_quantity = field_values.get("quantity")
        if new_quantity is not None and new_quantity <= 0:
            raise BadRequestException("Quantity must be greater than zero.")

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.item_repository.update(item, **changes)
            await self._refresh_rollup(inquiry_id)
        return item

    async def shift_item(self, from_inquiry_id: uuid.UUID, item_id: uuid.UUID, *, to_consignment_code_id: uuid.UUID, user_id: uuid.UUID) -> InquiryItem:
        """
        Move an item from one consignment to another under the same buyer.

        Document (Process Flow): "shifting between FB1 & FB2" -- both
        consignment codes must belong to the same buyer; shifting across
        buyers is not described by the document and is rejected here
        rather than silently allowed.
        """
        item = await self.get_item_or_raise(from_inquiry_id, item_id)
        from_inquiry = await self.get_inquiry_or_raise(from_inquiry_id)

        to_inquiry = await self.get_or_create_consignment(
            buyer_id=from_inquiry.buyer_id, consignment_code_id=to_consignment_code_id, user_id=user_id
        )
        if to_inquiry.id == from_inquiry_id:
            return item

        await self.item_repository.update(item, inquiry_id=to_inquiry.id)
        await self._refresh_rollup(from_inquiry_id)
        await self._refresh_rollup(to_inquiry.id)
        return item

    async def approve_item(self, inquiry_id: uuid.UUID, item_id: uuid.UUID, *, user_id: uuid.UUID) -> InquiryItem:
        """Document: Status moves Proposed -> Approved; Approved Date/By auto-generated from the acting user."""
        item = await self.get_item_or_raise(inquiry_id, item_id)
        await self.item_repository.update(
            item, status=InquiryItemStatus.APPROVED, approved_at=_utcnow(), approved_by=user_id
        )
        await self._refresh_rollup(inquiry_id)
        return item

    async def revert_item_to_proposed(self, inquiry_id: uuid.UUID, item_id: uuid.UUID) -> InquiryItem:
        """Move an approved item back to Proposed (e.g. approved in error)."""
        item = await self.get_item_or_raise(inquiry_id, item_id)
        await self.item_repository.update(item, status=InquiryItemStatus.PROPOSED, approved_at=None, approved_by=None)
        await self._refresh_rollup(inquiry_id)
        return item

    async def set_procurement_remarks(self, inquiry_id: uuid.UUID, item_id: uuid.UUID, *, remarks: str | None) -> InquiryItem:
        """Document: "Remarks (by Yinglima China Procurement Team) ... added or edited from 'Action' Panel"."""
        item = await self.get_item_or_raise(inquiry_id, item_id)
        await self.item_repository.update(item, procurement_remarks=remarks)
        return item

    async def bulk_mark_tally_posted(self, item_ids: list[uuid.UUID], *, user_id: uuid.UUID) -> list[InquiryItem]:
        """
        Mark multiple items as Tally Entry Posted in one call.

        Document: "some easy way to select and change multiple items to
        'Posted'." Silently skips IDs that don't exist rather than
        failing the whole batch over one bad ID, since this is meant to
        be a fast bulk action, not a validating single-item form.
        """
        updated: list[InquiryItem] = []
        affected_inquiry_ids: set[uuid.UUID] = set()
        now = _utcnow()
        for item_id in item_ids:
            item = await self.item_repository.get_by_id(item_id)
            if item is None:
                continue
            await self.item_repository.update(
                item, tally_entry_posted=True, tally_posted_at=now, tally_posted_by=user_id
            )
            updated.append(item)
            affected_inquiry_ids.add(item.inquiry_id)
        for inquiry_id in affected_inquiry_ids:
            await self._refresh_rollup(inquiry_id)
        return updated

    async def delete_item(self, inquiry_id: uuid.UUID, item_id: uuid.UUID) -> None:
        item = await self.get_item_or_raise(inquiry_id, item_id)
        await self.item_repository.delete(item)
        remaining = await self.item_repository.list_for_inquiry(inquiry_id)
        if not remaining:
            await self.delete_consignment(inquiry_id)
        else:
            await self._refresh_rollup(inquiry_id)
