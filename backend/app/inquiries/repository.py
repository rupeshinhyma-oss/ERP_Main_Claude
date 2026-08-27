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
from app.inquiries.models import ConsignmentCode, Inquiry, InquiryItem, InquiryItemStatus, Quotation, QuotationStatus, RFQ
from app.masters.products.models import Product
from app.masters.uom.models import UnitOfMeasurement
from app.suppliers.models import Supplier


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

    async def list_consignments_with_details_for_buyer(self, buyer_id: uuid.UUID) -> list[dict]:
        """Return enriched consignments with joined consignment_code and buyer_name."""
        stmt = (
            select(
                Inquiry,
                ConsignmentCode.code.label("consignment_code"),
                Buyer.company_name.label("buyer_company_name"),
            )
            .join(ConsignmentCode, Inquiry.consignment_code_id == ConsignmentCode.id, isouter=True)
            .join(Buyer, Inquiry.buyer_id == Buyer.id, isouter=True)
            .where(Inquiry.buyer_id == buyer_id, Inquiry.deleted_at.is_(None))
            .order_by(Inquiry.created_at.desc())
        )
        result = await self.session.execute(stmt)
        rows = result.all()
        items = []
        for inq, code, comp_name in rows:
            items.append({
                "id": inq.id,
                "buyer_id": inq.buyer_id,
                "buyer_name": comp_name or "Unknown Company",
                "branch_id": inq.branch_id,
                "consignment_code_id": inq.consignment_code_id,
                "consignment_code": code or "",
                "consignment_status": inq.consignment_status,
                "total_cbm": inq.total_cbm,
                "total_weight": inq.total_weight,
                "created_at": inq.created_at,
                "updated_at": inq.updated_at,
            })
        return items

    async def get_inquiry_with_details(self, inquiry_id: uuid.UUID) -> dict | None:
        """Fetch a consignment with joined buyer and consignment code info."""
        stmt = (
            select(
                Inquiry,
                ConsignmentCode.code.label("consignment_code"),
                Buyer.company_name.label("buyer_company_name"),
            )
            .join(ConsignmentCode, Inquiry.consignment_code_id == ConsignmentCode.id, isouter=True)
            .join(Buyer, Inquiry.buyer_id == Buyer.id, isouter=True)
            .where(Inquiry.id == inquiry_id, Inquiry.deleted_at.is_(None))
        )
        result = await self.session.execute(stmt)
        row = result.first()
        if not row:
            return None
        inq, code, comp_name = row
        return {
            "id": inq.id,
            "buyer_id": inq.buyer_id,
            "buyer_name": comp_name or "Unknown Company",
            "branch_id": inq.branch_id,
            "consignment_code_id": inq.consignment_code_id,
            "consignment_code": code or "",
            "consignment_status": inq.consignment_status,
            "total_cbm": inq.total_cbm,
            "total_weight": inq.total_weight,
            "created_by": inq.created_by,
            "created_at": inq.created_at,
            "updated_at": inq.updated_at,
        }

    async def list_distinct_buyer_ids(self) -> list[uuid.UUID]:
        """Layer 1 company roll-up helper: every buyer that has >= 1 non-deleted consignment."""
        stmt = (
            select(Inquiry.buyer_id)
            .where(Inquiry.deleted_at.is_(None))
            .distinct()
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_all_company_summaries(self) -> list[dict]:
        """
        Fast single-query company summaries across all active buyers and inquiries.
        """
        stmt = (
            select(
                Buyer.id.label("buyer_id"),
                Buyer.company_name.label("company_name"),
                Inquiry.consignment_status,
                Inquiry.total_cbm,
                Inquiry.total_weight,
                Inquiry.updated_at,
                ConsignmentCode.code.label("consignment_code"),
            )
            .join(Inquiry, Inquiry.buyer_id == Buyer.id)
            .join(ConsignmentCode, Inquiry.consignment_code_id == ConsignmentCode.id, isouter=True)
            .where(Inquiry.deleted_at.is_(None), Buyer.deleted_at.is_(None))
            .order_by(Inquiry.updated_at.desc())
        )
        result = await self.session.execute(stmt)
        rows = result.all()

        buyer_map: dict[uuid.UUID, dict] = {}
        for b_id, comp_name, c_status, c_cbm, c_wt, u_at, code in rows:
            if b_id not in buyer_map:
                buyer_map[b_id] = {
                    "buyer_id": b_id,
                    "company_name": comp_name or "Unknown Company",
                    "consignment_count": 0,
                    "proposed_count": 0,
                    "approved_count": 0,
                    "total_cbm": 0.0,
                    "total_weight": 0.0,
                    "statuses": [],
                    "consignment_codes": [],
                    "updated_at": u_at,
                }
            bm = buyer_map[b_id]
            bm["consignment_count"] += 1
            bm["total_cbm"] += float(c_cbm or 0.0)
            bm["total_weight"] += float(c_wt or 0.0)
            bm["statuses"].append(c_status)
            if code and code not in bm["consignment_codes"]:
                bm["consignment_codes"].append(code)
            if u_at and (bm["updated_at"] is None or u_at > bm["updated_at"]):
                bm["updated_at"] = u_at

        summaries = []
        for bm in buyer_map.values():
            statuses = bm["statuses"]
            if statuses and all(s == "fully_approved" for s in statuses):
                overall_status = "fully_approved"
            elif any(s in ("partial_approved", "fully_approved") for s in statuses):
                overall_status = "partial_approved"
            else:
                overall_status = "proposed"

            summaries.append({
                "buyer_id": bm["buyer_id"],
                "company_name": bm["company_name"],
                "consignment_count": bm["consignment_count"],
                "proposed_count": sum(1 for s in statuses if s == "proposed"),
                "approved_count": sum(1 for s in statuses if s == "fully_approved"),
                "total_cbm": round(bm["total_cbm"], 4),
                "total_weight": round(bm["total_weight"], 2),
                "consignment_status": overall_status,
                "consignment_codes": bm["consignment_codes"],
                "updated_at": bm["updated_at"],
            })
        return summaries


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

    async def list_for_inquiry_with_details(self, inquiry_id: uuid.UUID) -> list[dict]:
        """
        Return items joined with Product, UOM, packaging specs, and active quotation counts.
        """
        qc_sub = (
            select(
                Quotation.inquiry_item_id,
                func.count(Quotation.id).label("q_count"),
            )
            .where(Quotation.deleted_at.is_(None))
            .group_by(Quotation.inquiry_item_id)
            .subquery()
        )

        stmt = (
            select(
                InquiryItem,
                Product.product_name,
                Product.product_name_tally,
                Product.product_code,
                Product.license_certificate_required,
                Product.packaging_quantity,
                Product.packaging_gross_weight,
                Product.packaging_unit_cbm,
                UnitOfMeasurement.name.label("uom_name"),
                UnitOfMeasurement.code.label("uom_code"),
                func.coalesce(qc_sub.c.q_count, 0).label("quotation_count"),
            )
            .join(Product, InquiryItem.product_id == Product.id, isouter=True)
            .join(UnitOfMeasurement, InquiryItem.uom_id == UnitOfMeasurement.id, isouter=True)
            .join(qc_sub, InquiryItem.id == qc_sub.c.inquiry_item_id, isouter=True)
            .where(InquiryItem.inquiry_id == inquiry_id, InquiryItem.deleted_at.is_(None))
            .order_by(InquiryItem.tally_entry_posted.asc(), InquiryItem.created_at.desc())
        )
        result = await self.session.execute(stmt)
        rows = result.all()
        items = []
        for item, p_name, p_tally, p_code, p_lic, p_pkg_qty, p_pkg_wt, p_pkg_cbm, u_name, u_code, q_cnt in rows:
            items.append({
                "id": item.id,
                "inquiry_id": item.inquiry_id,
                "product_id": item.product_id,
                "uom_id": item.uom_id,
                "quantity": item.quantity,
                "brand_preference": item.brand_preference,
                "product_specs_remarks": item.product_specs_remarks,
                "status": item.status,
                "proposed_at": item.proposed_at,
                "proposed_by": item.proposed_by,
                "approved_at": item.approved_at,
                "approved_by": item.approved_by,
                "tally_entry_posted": item.tally_entry_posted,
                "tally_posted_at": item.tally_posted_at,
                "tally_posted_by": item.tally_posted_by,
                "procurement_remarks": item.procurement_remarks,
                "requires_license": item.requires_license,
                "product_name": p_tally or p_name or "Unknown Product",
                "product_name_tally": p_tally,
                "product_code": p_code or "",
                "uom_name": u_name or "",
                "uom_code": u_code or "",
                "license_details": p_lic or None,
                "packaging_quantity": float(p_pkg_qty) if p_pkg_qty is not None else None,
                "packaging_gross_weight": float(p_pkg_wt) if p_pkg_wt is not None else None,
                "packaging_unit_cbm": float(p_pkg_cbm) if p_pkg_cbm is not None else None,
                "quotation_count": int(q_cnt or 0),
                "created_at": item.created_at,
                "updated_at": item.updated_at,
            })
        return items

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


class QuotationRepository(BaseRepository[Quotation]):
    """Repository for supplier quotations received for inquiry items."""

    searchable_fields = ("quote_number", "remarks")
    sortable_fields = ("created_at", "total_cost", "unit_price", "status")
    filterable_fields = ("inquiry_item_id", "supplier_id", "status")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, Quotation)

    async def list_for_item_with_details(self, inquiry_item_id: uuid.UUID) -> list[dict]:
        """Return quotations for an item joined with Supplier info and latest RFQ sent date."""
        from app.inquiries.models import RFQ

        # Fetch the latest RFQ created/dispatched date for this item
        latest_rfq = (
            await self.session.execute(
                select(RFQ.created_at)
                .where(RFQ.inquiry_item_id == inquiry_item_id, RFQ.deleted_at.is_(None))
                .order_by(RFQ.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        stmt = (
            select(
                Quotation,
                Supplier.company_name.label("supplier_name"),
            )
            .join(Supplier, Quotation.supplier_id == Supplier.id, isouter=True)
            .where(Quotation.inquiry_item_id == inquiry_item_id, Quotation.deleted_at.is_(None))
            .order_by(Quotation.created_at.desc())
        )
        result = await self.session.execute(stmt)
        rows = result.all()
        items = []
        for q, s_name in rows:
            items.append({
                "id": q.id,
                "quote_number": q.quote_number,
                "inquiry_item_id": q.inquiry_item_id,
                "supplier_id": q.supplier_id,
                "supplier_name": s_name or "Unknown Supplier",
                "quantity": q.quantity,
                "unit_price": q.unit_price,
                "total_cost": q.total_cost,
                "currency": q.currency,
                "expected_receiving_date": str(q.expected_receiving_date) if q.expected_receiving_date else None,
                "terms_and_conditions": q.terms_and_conditions,
                "remarks": q.remarks,
                "attachment_url": q.attachment_url,
                "attachment_filename": q.attachment_filename,
                "status": q.status.value if hasattr(q.status, "value") else str(q.status),
                "created_by": q.created_by,
                "created_at": q.created_at,
                "updated_at": q.updated_at,
                "rfq_sent_at": latest_rfq.isoformat() if latest_rfq else None,
            })
        return items

    async def get_all_quotation_documents(self) -> list[dict]:
        """Fetch all quotations with product and supplier metadata for the Product & Supplier Gallery."""
        stmt = (
            select(
                Quotation,
                Supplier.company_name.label("supplier_name"),
                Product.id.label("product_id"),
                Product.product_name,
                Product.product_name_tally,
                Product.product_code,
                Product.category_id,
                Product.sub_category_id,
                Product.brand_id,
                InquiryItem.quantity.label("item_quantity"),
            )
            .join(InquiryItem, Quotation.inquiry_item_id == InquiryItem.id)
            .join(Product, InquiryItem.product_id == Product.id)
            .join(Supplier, Quotation.supplier_id == Supplier.id, isouter=True)
            .where(
                Quotation.deleted_at.is_(None),
                Quotation.attachment_url.is_not(None),
            )
            .order_by(Quotation.created_at.desc())
        )
        result = await self.session.execute(stmt)
        rows = result.all()
        docs = []
        for q, supp_name, p_id, p_name, p_tally, p_code, cat_id, sub_cat_id, b_id, item_qty in rows:
            docs.append({
                "id": str(q.id),
                "quote_number": q.quote_number,
                "product_id": str(p_id),
                "product_name": p_tally or p_name,
                "product_code": p_code,
                "category_id": str(cat_id) if cat_id else None,
                "sub_category_id": str(sub_cat_id) if sub_cat_id else None,
                "brand_id": str(b_id) if b_id else None,
                "supplier_id": str(q.supplier_id),
                "supplier_name": supp_name or "Supplier",
                "unit_price": float(q.unit_price or 0.0),
                "total_cost": float(q.total_cost or 0.0),
                "currency": q.currency or "CNY",
                "quantity": float(q.quantity or item_qty or 1.0),
                "expected_receiving_date": str(q.expected_receiving_date) if q.expected_receiving_date else None,
                "terms_and_conditions": q.terms_and_conditions,
                "remarks": q.remarks,
                "attachment_url": q.attachment_url,
                "attachment_filename": q.attachment_filename or f"{q.quote_number}_Quotation_Sheet",
                "status": q.status.value if hasattr(q.status, "value") else str(q.status),
                "created_at": q.created_at.isoformat() if q.created_at else None,
            })
        return docs

    async def count_approved_for_item(self, inquiry_item_id: uuid.UUID) -> int:
        """Count approved quotations for an inquiry item."""
        stmt = (
            select(func.count())
            .select_from(Quotation)
            .where(
                Quotation.inquiry_item_id == inquiry_item_id,
                Quotation.status == QuotationStatus.APPROVED,
                Quotation.deleted_at.is_(None),
            )
        )
        result = await self.session.execute(stmt)
        return int(result.scalar_one())

    async def generate_quote_number(self) -> str:
        """Generate next quote number sequence e.g. #QT-501."""
        stmt = select(func.count()).select_from(Quotation)
        result = await self.session.execute(stmt)
        count = int(result.scalar_one())
        return f"#QT-{500 + count + 1}"

    async def get_last_purchase_for_product(self, product_id: uuid.UUID) -> dict | None:
        """Return the latest approved quote or recent quotation for a product."""
        stmt = (
            select(
                Quotation,
                Supplier.company_name.label("supplier_name"),
                InquiryItem.quantity.label("item_quantity"),
            )
            .join(InquiryItem, Quotation.inquiry_item_id == InquiryItem.id)
            .join(Supplier, Quotation.supplier_id == Supplier.id, isouter=True)
            .where(
                InquiryItem.product_id == product_id,
                Quotation.status == QuotationStatus.APPROVED,
                Quotation.deleted_at.is_(None),
            )
            .order_by(Quotation.created_at.desc())
            .limit(1)
        )
        result = await self.session.execute(stmt)
        row = result.first()
        if not row:
            stmt_any = (
                select(
                    Quotation,
                    Supplier.company_name.label("supplier_name"),
                    InquiryItem.quantity.label("item_quantity"),
                )
                .join(InquiryItem, Quotation.inquiry_item_id == InquiryItem.id)
                .join(Supplier, Quotation.supplier_id == Supplier.id, isouter=True)
                .where(
                    InquiryItem.product_id == product_id,
                    Quotation.deleted_at.is_(None),
                )
                .order_by(Quotation.created_at.desc())
                .limit(1)
            )
            result_any = await self.session.execute(stmt_any)
            row = result_any.first()

        if row:
            q, s_name, item_qty = row
            return {
                "supplier_name": s_name or "Supplier",
                "quantity": float(q.quantity or item_qty or 0),
                "unit_price": float(q.unit_price or 0),
                "total_cost": float(q.total_cost or 0),
                "currency": q.currency or "CNY",
                "date": q.created_at.strftime("%Y-%m-%d") if q.created_at else None,
                "quote_number": q.quote_number,
                "status": q.status.value if hasattr(q.status, "value") else str(q.status),
            }
        return None


class RFQRepository(BaseRepository[RFQ]):
    """Repository for Request For Quotation logs."""

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, RFQ)

    async def list_for_item(self, inquiry_item_id: uuid.UUID) -> list[RFQ]:
        stmt = (
            self._base_select()
            .where(RFQ.inquiry_item_id == inquiry_item_id, RFQ.deleted_at.is_(None))
            .order_by(RFQ.created_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())