"""
Inquiry (Requirement) ORM Models.

Owns the ``consignment_codes``, ``inquiries``, and ``inquiry_items`` tables.

Built per the "Inquiry (Requirement) Form (1st Step in Process)"
specification document. Models the document's two-layer structure
directly:

- **Layer 1 (company-wise summary)**: one row per :class:`Inquiry`
  ("consignment") -- a buyer company + a consignment code (FB1, FB2,
  ING1, ...) + rollup totals/status computed from its items.
- **Layer 2 (inside a consignment)**: one row per :class:`InquiryItem` --
  a single product line with quantity, UOM, brand preference, specs/
  remarks, approval status, and tally-posted tracking.

``ConsignmentCode`` is a small admin-managed master (per the confirmed
scope) rather than a free-text field, matching the document's "Master to
create and choose from dropdown menu" instruction. It is modeled in this
module rather than under ``app.masters`` because it is meaningful only in
the context of an inquiry/consignment (like Supplier/Buyer's own local
Grade/Status enums), not general-purpose reference data other modules
would consume, and it links directly to a specific buyer.

This module does NOT define its own Product or UOM tables -- it
references the existing Phase 7 Master Data ``products`` table by foreign
key, which already carries ``uom_id`` (for the document's "UOM to reflect
automatically as per inventory master of that item") and
``license_certificate_required`` (for the document's "highlight in RED
colour" rule), and the existing Buyers module's ``buyers`` table for
"Inquiry by (buyer company name)".
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from enum import Enum

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import RecordStatus
from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class InquiryItemStatus(str, Enum):
    """Document: "Status - Proposed / Approved (by default Proposed)", per item."""

    PROPOSED = "proposed"
    APPROVED = "approved"


class InquiryConsignmentStatus(str, Enum):
    """
    Document (Layer 1 list column): "Status - Proposed / Fully Approved /
    Partial Approved (because in a consignment, we may have approved some
    items and some proposed)".

    Computed, never stored directly on write -- see
    :meth:`app.inquiries.service.InquiryService._compute_consignment_status`.
    Persisted as a column anyway (denormalized) so the Layer-1 list can
    filter/sort by it without recomputing for every row on every list call.
    """

    PROPOSED = "proposed"
    PARTIAL_APPROVED = "partial_approved"
    FULLY_APPROVED = "fully_approved"


class ConsignmentCode(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """
    An admin-managed consignment code (FB1, FB2, ING1, INM1, INC1, INI1, ...).

    Document: "Inquiry consignment code ... Master to create and choose
    from dropdown menu ... (respective company users should see only
    relevant options to choose, but admin can see all)". The per-user
    visibility restriction described here requires a "which company does
    this user belong to" concept that does not exist elsewhere in the
    system yet; per the confirmed scope for this pass, every user with
    inquiry.read can see every code, same as every other list in the
    system today -- enforcing per-company visibility is flagged as
    follow-up work, not silently invented here.
    """

    __tablename__ = "consignment_codes"

    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)  # e.g. "FB1", "ING1"
    label: Mapped[str | None] = mapped_column(String(150), nullable=True)  # e.g. "F&B Uganda - Consignment 1"
    buyer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("buyers.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="consignment_code_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<ConsignmentCode code={self.code!r}>"


class Inquiry(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """
    One consignment (Layer 1 of the document's two-layer list).

    Document: "Inquiry by (buyer company name) ... Inquiry consignment
    code". Rollup fields (``total_cbm``, ``total_weight``,
    ``consignment_status``) are denormalized -- recomputed by
    :mod:`app.inquiries.service` whenever an item underneath changes --
    so the Layer-1 list never needs to aggregate ``inquiry_items`` on
    every page load.
    """

    __tablename__ = "inquiries"
    __table_args__ = (UniqueConstraint("buyer_id", "consignment_code_id", name="uq_inquiry_buyer_consignment"),)

    buyer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("buyers.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    consignment_code_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("consignment_codes.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    consignment_status: Mapped[InquiryConsignmentStatus] = mapped_column(
        SAEnum(InquiryConsignmentStatus, name="inquiry_consignment_status", native_enum=False, length=20),
        default=InquiryConsignmentStatus.PROPOSED,
        nullable=False,
        index=True,
    )
    total_cbm: Mapped[float] = mapped_column(default=0.0, nullable=False)
    total_weight: Mapped[float] = mapped_column(default=0.0, nullable=False)

    created_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)

    items: Mapped[list["InquiryItem"]] = relationship(
        back_populates="inquiry", cascade="all, delete-orphan", lazy="selectin"
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Inquiry id={self.id} buyer_id={self.buyer_id}>"


class InquiryItem(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """
    One product line within a consignment (Layer 2 of the document's two-layer list).

    Document: "Product Name ... Quantity / UOM (UOM to reflect
    automatically as per inventory master of that item) ... Brand
    Preference ... Product Specs / Remarks ... Status - Proposed /
    Approved". ``uom_id`` is copied from the selected Product at creation
    time (not re-derived on every read) so a later change to the Product
    master's UOM doesn't silently rewrite the UOM an already-placed
    inquiry item was raised against.
    """

    __tablename__ = "inquiry_items"

    inquiry_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("inquiries.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("products.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    uom_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("units_of_measurement.id", ondelete="RESTRICT"), nullable=False
    )  # copied from Product.uom_id at creation time; see class docstring

    quantity: Mapped[float] = mapped_column(nullable=False)
    brand_preference: Mapped[str | None] = mapped_column(Text, nullable=True)  # optional per the document
    product_specs_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)  # optional per the document

    status: Mapped[InquiryItemStatus] = mapped_column(
        SAEnum(InquiryItemStatus, name="inquiry_item_status", native_enum=False, length=20),
        default=InquiryItemStatus.PROPOSED,
        nullable=False,
        index=True,
    )
    proposed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    proposed_by: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id"), nullable=False)
    approved_at: Mapped[datetime | None] = mapped_column(nullable=True)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)

    # Document: "Tally Entry Posted ? (to show pending by default ... easy
    # way to select and change multiple items to 'Posted'. All pending
    # entries to show on top by default.)"
    tally_entry_posted: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    tally_posted_at: Mapped[datetime | None] = mapped_column(nullable=True)
    tally_posted_by: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id"), nullable=True)

    # Document: "Remarks (by Yinglima China Procurement Team) -- To show
    # in list column with 'View' Eye Button and can be added or edited
    # from 'Action' Panel." Kept distinct from product_specs_remarks
    # (the requester's own remarks) since this is the procurement team's
    # separate, later-added commentary on the item.
    procurement_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)

    requires_license: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        nullable=False,
        doc="Denormalized copy of Product.license_certificate_required is-set, refreshed at creation "
        "time -- drives the document's 'highlight in RED colour' rule without a join on every list render.",
    )

    inquiry: Mapped[Inquiry] = relationship(back_populates="items")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<InquiryItem id={self.id} inquiry_id={self.inquiry_id} product_id={self.product_id}>"
