"""
Inquiry Repositories.

One repository per table (:class:`ConsignmentCodeRepository`,
:class:`InquiryRepository`, :class:`InquiryItemRepository`), plus the
rollup-recompute query the document's Layer-1 list needs (Total CBM,
Total Weight, and the Proposed/Partial/Fully-Approved status), kept here
rather than in the service layer since it's pure aggregation over rows
the repository already owns.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.buyers.models import Buyer
from app.inquiries.models import ConsignmentCode, Inquiry, InquiryItem, InquiryItemStatus
from app.masters.products.models import Product


class ConsignmentCodeRepository(BaseRepository[ConsignmentCode]):
    """Repository for the admin-managed ``consignment_codes`` master."""

    searchable_fields = ("code", "label")
    sortable_fields = ("code", "created_at")
    filterable_fields = ("buyer_id", "branch_id", "status")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, ConsignmentCode)

    async def get_by_code(self, code: str) -> ConsignmentCode | None:
        stmt = self._base_select().where(ConsignmentCode.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_for_buyer(self, buyer_id: uuid.UUID) -> list[ConsignmentCode]:
        """Return every active consignment code belonging to one buyer (for the create-inquiry dropdown)."""
        stmt = self._base_select().where(ConsignmentCode.buyer_id == buyer_id).order_by(ConsignmentCode.code)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class InquiryRepository(BaseRepository[Inquiry]):
    """Repository for ``inquiries`` (Layer 1: one row per buyer+consignment_code)."""

    searchable_fields = ()
    sortable_fields = ("created_at", "updated_at", "total_cbm", "total_weight")
    filterable_fields = ("buyer_id", "consignment_code_id", "consignment_status")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, Inquiry)

    async def get_by_buyer_and_code(self, buyer_id: uuid.UUID, consignment_code_id: uuid.UUID) -> Inquiry | None:
        stmt = self._base_select().where(
            Inquiry.buyer_id == buyer_id,
            Inquiry.consignment_code_id == consignment_code_id,
            Inquiry.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_for_buyer(self, buyer_id: uuid.UUID) -> list[Inquiry]:
        """Return every consignment for one buyer (Layer 1, scoped to a single company)."""
        stmt = self._base_select().where(Inquiry.buyer_id == buyer_id, Inquiry.deleted_at.is_(None)).order_by(Inquiry.created_at.desc())
        result = await self.session.execute(stmt)
        return list(result.scalars().unique().all())

    async def list_distinct_buyer_ids(self) -> list[uuid.UUID]:
        """Return every buyer_id that has at least one active consignment -- the Layer-1 "company wise" grouping."""
        stmt = (
            select(Inquiry.buyer_id)
            .join(Buyer, Inquiry.buyer_id == Buyer.id)
            .where(Inquiry.deleted_at.is_(None), Buyer.deleted_at.is_(None))
            .distinct()
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class InquiryItemRepository(BaseRepository[InquiryItem]):
    """Repository for ``inquiry_items`` (Layer 2: one row per product line)."""

    searchable_fields = ()
    sortable_fields = ("created_at", "status", "tally_entry_posted", "proposed_at", "approved_at")
    filterable_fields = ("inquiry_id", "product_id", "status", "tally_entry_posted")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, InquiryItem)

    async def list_for_inquiry(self, inquiry_id: uuid.UUID) -> list[InquiryItem]:
        """
        Return every item in a consignment, pending-Tally-Entry items first.

        Document: "All pending entries to show on top by default."
        """
        stmt = (
            self._base_select()
            .where(InquiryItem.inquiry_id == inquiry_id, InquiryItem.deleted_at.is_(None))
            .order_by(InquiryItem.tally_entry_posted.asc(), InquiryItem.created_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def compute_rollup(self, inquiry_id: uuid.UUID) -> dict:
        """
        Recompute one consignment's Layer-1 rollup fields from its current items.

        Calculates total CBM and Weight by multiplying item quantity with
        the product's unit CBM (packaging_unit_cbm or L*W*H/1,000,000) and
        unit weight (packaging_gross_weight or weight).
        """
        stmt = (
            select(
                InquiryItem.status,
                InquiryItem.quantity,
                Product.packaging_unit_cbm,
                Product.length_cm,
                Product.width_cm,
                Product.height_cm,
                Product.packaging_gross_weight,
                Product.weight,
            )
            .join(Product, InquiryItem.product_id == Product.id)
            .where(
                InquiryItem.inquiry_id == inquiry_id,
                InquiryItem.deleted_at.is_(None),
            )
        )
        result = await self.session.execute(stmt)
        rows = result.all()

        if not rows:
            return {"total_cbm": 0.0, "total_weight": 0.0, "status": "proposed"}

        statuses = [r[0] for r in rows]
        total_cbm = 0.0
        total_weight = 0.0

        for r in rows:
            qty = float(r[1] or 0.0)
            cbm_unit = r[2]
            l, w, h = r[3], r[4], r[5]
            gross_wt = r[6]
            wt = r[7]

            # Calculate CBM per unit
            if cbm_unit is not None and float(cbm_unit) > 0:
                unit_cbm = float(cbm_unit)
            elif l is not None and w is not None and h is not None:
                unit_cbm = (float(l) * float(w) * float(h)) / 1_000_000.0
            else:
                unit_cbm = 0.0

            # Calculate Weight per unit (kg)
            if gross_wt is not None and float(gross_wt) > 0:
                unit_wt = float(gross_wt)
            elif wt is not None and float(wt) > 0:
                unit_wt = float(wt)
            else:
                unit_wt = 0.0

            total_cbm += qty * unit_cbm
            total_weight += qty * unit_wt

        if all(s == InquiryItemStatus.APPROVED for s in statuses):
            status_value = "fully_approved"
        elif any(s == InquiryItemStatus.APPROVED for s in statuses):
            status_value = "partial_approved"
        else:
            status_value = "proposed"

        return {
            "total_cbm": round(total_cbm, 4),
            "total_weight": round(total_weight, 2),
            "status": status_value,
        }

    async def count_pending_tally(self, inquiry_id: uuid.UUID) -> int:
        """Return the count of items in a consignment not yet marked Tally Entry Posted."""
        stmt = select(func.count()).select_from(InquiryItem).where(
            InquiryItem.inquiry_id == inquiry_id,
            InquiryItem.tally_entry_posted.is_(False),
            InquiryItem.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return int(result.scalar_one())
