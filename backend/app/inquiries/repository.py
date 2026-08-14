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
from app.inquiries.models import ConsignmentCode, Inquiry, InquiryItem, InquiryItemStatus


class ConsignmentCodeRepository(BaseRepository[ConsignmentCode]):
    """Repository for the admin-managed ``consignment_codes`` master."""

    searchable_fields = ("code", "label")
    sortable_fields = ("code", "created_at")
    filterable_fields = ("buyer_id", "status")

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
    """Repository for ``inquiries`` (Layer 1: one row per consignment)."""

    searchable_fields = ()
    sortable_fields = ("created_at", "updated_at", "consignment_status", "total_cbm", "total_weight")
    filterable_fields = ("buyer_id", "consignment_code_id", "consignment_status")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, Inquiry)

    async def get_by_buyer_and_code(self, buyer_id: uuid.UUID, consignment_code_id: uuid.UUID) -> Inquiry | None:
        stmt = self._base_select().where(
            Inquiry.buyer_id == buyer_id, Inquiry.consignment_code_id == consignment_code_id
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_for_buyer(self, buyer_id: uuid.UUID) -> list[Inquiry]:
        """Return every consignment for one buyer (Layer 1, scoped to a single company)."""
        stmt = self._base_select().where(Inquiry.buyer_id == buyer_id).order_by(Inquiry.created_at.desc())
        result = await self.session.execute(stmt)
        return list(result.scalars().unique().all())

    async def get_company_summaries(self) -> list[dict]:
        """
        Return one aggregate row per buyer (Layer-1 "company wise" summary), in a
        single grouped query.

        Phase 8 fix: this used to be ``list_distinct_buyer_ids()`` (1 query)
        followed by a ``list_for_buyer()`` call PER buyer to sum totals in
        Python -- a classic N+1 that ran on every Inquiries page load and
        scaled linearly with the number of buyers that have consignments.
        Replaced with one ``GROUP BY buyer_id`` query that computes the
        count/sum server-side, matching item 3's "100 records must NOT
        accidentally generate 100+ database queries" rule.
        """
        stmt = (
            self._base_select()
            .with_only_columns(
                Inquiry.buyer_id,
                func.count(Inquiry.id).label("consignment_count"),
                func.coalesce(func.sum(Inquiry.total_cbm), 0).label("total_cbm"),
                func.coalesce(func.sum(Inquiry.total_weight), 0).label("total_weight"),
            )
            .group_by(Inquiry.buyer_id)
        )
        result = await self.session.execute(stmt)
        return [
            {
                "buyer_id": row.buyer_id,
                "consignment_count": row.consignment_count,
                "total_cbm": row.total_cbm,
                "total_weight": row.total_weight,
            }
            for row in result.all()
        ]


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
            .where(InquiryItem.inquiry_id == inquiry_id)
            .order_by(InquiryItem.tally_entry_posted.asc(), InquiryItem.created_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def compute_rollup(self, inquiry_id: uuid.UUID) -> dict:
        """
        Recompute one consignment's Layer-1 rollup fields from its current items.

        Returns a dict with ``total_cbm`` (placeholder 0.0 -- see note
        below), ``total_weight`` (ditto), and ``status``
        (:class:`~app.inquiries.models.InquiryConsignmentStatus` value).

        Total CBM/Weight are intentionally left at 0.0 here rather than
        computed from a fabricated formula: the document says these come
        "(including approved and proposed items)" but never specifies
        which fields on Product (or elsewhere) supply the per-unit
        weight/CBM to multiply by quantity -- the Master Planning Sheet
        this document explicitly models itself on computes them from
        supplier-provided PKG/weight/CBM data that doesn't exist on the
        Product master today. Wiring real numbers in here would mean
        inventing an unreviewed formula; :mod:`app.inquiries.service`
        documents this as explicit follow-up work instead.
        """
        stmt = select(InquiryItem.status).where(InquiryItem.inquiry_id == inquiry_id, InquiryItem.deleted_at.is_(None))
        result = await self.session.execute(stmt)
        statuses = list(result.scalars().all())

        if not statuses:
            status_value = "proposed"
        elif all(s == InquiryItemStatus.APPROVED for s in statuses):
            status_value = "fully_approved"
        elif any(s == InquiryItemStatus.APPROVED for s in statuses):
            status_value = "partial_approved"
        else:
            status_value = "proposed"

        return {"total_cbm": 0.0, "total_weight": 0.0, "status": status_value}

    async def count_pending_tally(self, inquiry_id: uuid.UUID) -> int:
        """Return the count of items in a consignment not yet marked Tally Entry Posted."""
        stmt = select(func.count()).select_from(InquiryItem).where(
            InquiryItem.inquiry_id == inquiry_id,
            InquiryItem.tally_entry_posted.is_(False),
            InquiryItem.deleted_at.is_(None),
        )
        result = await self.session.execute(stmt)
        return int(result.scalar_one())