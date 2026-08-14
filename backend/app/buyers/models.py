"""
Buyer (Client) ORM Models.

Owns the ``buyers``, ``buyer_emails``, ``buyer_contacts``,
``buyer_category_links``, and ``buyer_sub_category_links`` tables.

Built per the "Add Buyer (Client) Data Form" specification document, and
deliberately structured as a near-mirror of ``app.suppliers.models`` --
the two documents describe the same shape of record (a company profile +
multiple contacts + multiple emails + multi-select category/sub-category
tags) for the opposite side of the trade relationship. Reusing that
structure means the same reviewed business rules (duplicate detection, the
one-way status transition, the delete-vs-inactivate guard) carry over
directly instead of being redesigned from scratch.

Like Suppliers, this module does NOT define its own Country/Product-
Category/Product-Sub-Category tables -- it references the existing Phase 7
Master Data tables by foreign key.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin, VersionMixin


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class BuyerType(str, Enum):
    """Document: "Buyer Type -- Manufacturer / Trader / Select"."""

    MANUFACTURER = "manufacturer"
    TRADER = "trader"


class BuyerGrade(str, Enum):
    """Document: "Client Grade -- A, B, C"."""

    A = "A"
    B = "B"
    C = "C"


class BuyerCurrentStatus(str, Enum):
    """
    Document: "Current Status - Existing/New/Select (by default Select)".

    Business rule (document Notes): "once changed to Existing, then it
    cannot change back to new, means 1 way only" -- enforced in
    :mod:`app.buyers.service`, mirroring
    ``app.suppliers.service._validate_status_transition`` exactly.
    """

    NEW = "new"
    EXISTING = "existing"


class BuyerPotential(str, Enum):
    """Document: "Potential - Yes / No / Select (by default Select)"."""

    YES = "yes"
    NO = "no"


class Buyer(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """
    A single buyer (client) profile record.

    ``VersionMixin`` (Optimistic Concurrency Control) was added here in
    the Phase 3 performance/correctness audit: the `buyers.version`
    column has existed at the DATABASE level since migration
    v6w7x8y9z0a1 ("add_version_column_for_occ"), and the frontend
    (`Buyers.tsx`) already sends `version` on every PATCH -- but this
    model never declared the column, so `BaseRepository.update()`'s OCC
    check (`getattr(instance, "version", None)`) always saw `None` and
    silently never fired. Two users could overwrite each other's changes
    with no conflict raised. No new migration is needed for this fix --
    only the model was missing the column, not the database.
    """

    __tablename__ = "buyers"

    company_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)  # "Name of Company*"
    buyer_type: Mapped[str | None] = mapped_column(String(150), nullable=True)

    country_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("countries.id", ondelete="RESTRICT"), nullable=False, index=True
    )  # "Country* (dropdown menu) by default Uganda" -- default applied at the schema layer
    city: Mapped[str | None] = mapped_column(String(150), nullable=True)  # "City (description field)" -- free text
    address: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Primary contact person, captured directly on the main form. Per the
    # document's Notes ("Main Form contact details should appear in the
    # Contact list also"), a matching BuyerContact row is created
    # automatically alongside this -- see BuyerService.create().
    contact_salutation: Mapped[str | None] = mapped_column(String(10), nullable=True)  # "Mr. / Mrs / Ms"
    contact_full_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    contact_designation: Mapped[str | None] = mapped_column(String(150), nullable=True)
    contact_calling_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    contact_whatsapp_number: Mapped[str | None] = mapped_column(String(20), nullable=True)

    tax_id_number: Mapped[str | None] = mapped_column(String(100), nullable=True)  # "Tax ID Number (TIN / GST)"
    website: Mapped[str | None] = mapped_column(String(500), nullable=True)

    current_status: Mapped[BuyerCurrentStatus | None] = mapped_column(
        SAEnum(BuyerCurrentStatus, name="buyer_current_status", native_enum=False, length=20), nullable=True
    )  # "by default Select" -- modeled as nullable rather than a forced default
    product_range: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # "Product Range they manufacture or supply"
    potential: Mapped[BuyerPotential | None] = mapped_column(
        SAEnum(BuyerPotential, name="buyer_potential", native_enum=False, length=10), nullable=True
    )  # "by default Select"
    potential_reason: Mapped[str | None] = mapped_column(Text, nullable=True)  # "If Potential is No, then reason"
    buyer_grade: Mapped[BuyerGrade | None] = mapped_column(
        SAEnum(BuyerGrade, name="buyer_grade", native_enum=False, length=5), nullable=True
    )
    currently_buying_from: Mapped[str | None] = mapped_column(Text, nullable=True)
    overall_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)  # "Overall Observation / Remarks"

    # Active/Inactive toggle. Distinct from soft-delete: the document's
    # Notes explicitly require an Inactive state reachable even when a
    # record can never be hard/soft-deleted (see BuyerService.delete()).
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)

    emails: Mapped[list["BuyerEmail"]] = relationship(
        back_populates="buyer", cascade="all, delete-orphan", lazy="selectin"
    )
    contacts: Mapped[list["BuyerContact"]] = relationship(
        back_populates="buyer", cascade="all, delete-orphan", lazy="selectin"
    )
    category_links: Mapped[list["BuyerCategoryLink"]] = relationship(
        back_populates="buyer", cascade="all, delete-orphan", lazy="selectin"
    )
    sub_category_links: Mapped[list["BuyerSubCategoryLink"]] = relationship(
        back_populates="buyer", cascade="all, delete-orphan", lazy="selectin"
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Buyer company_name={self.company_name!r}>"


class BuyerEmail(Base, UUIDPrimaryKeyMixin):
    """
    One email address belonging to a buyer.

    Document: "Email ID (multiple emails) hyperlink" -- modeled as a child
    table rather than a JSON array so each address stays individually
    queryable (duplicate-detection, future lookups).
    """

    __tablename__ = "buyer_emails"
    __table_args__ = (UniqueConstraint("buyer_id", "email", name="uq_buyer_email"),)

    buyer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)

    buyer: Mapped[Buyer] = relationship(back_populates="emails")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<BuyerEmail email={self.email!r}>"


class BuyerContact(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """
    One contact person for a buyer ("Add Contacts of Buyer (Client)" in the document).

    The buyer's main-form contact is mirrored into a row here at creation
    time (see :meth:`app.buyers.service.BuyerService.create`), satisfying
    the document's Note: "Main Form contact details should appear in the
    Contact list also."
    """

    __tablename__ = "buyer_contacts"

    buyer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    salutation: Mapped[str | None] = mapped_column(String(10), nullable=True)  # "Mr. / Mrs / Ms"
    person_name: Mapped[str] = mapped_column(String(150), nullable=False)
    designation: Mapped[str | None] = mapped_column(String(150), nullable=True)
    country_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("countries.id", ondelete="SET NULL"), nullable=True, index=True
    )  # "Country (dropdown menu) by default Uganda"
    calling_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    whatsapp_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Marks the contact auto-created from the main form, so the service
    # layer can keep it in sync if the buyer's primary contact fields are
    # edited later, and so the UI can indicate provenance.
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    buyer: Mapped[Buyer] = relationship(back_populates="contacts")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<BuyerContact person_name={self.person_name!r}>"


class BuyerCategoryLink(Base, UUIDPrimaryKeyMixin):
    """Many-to-many link: a buyer to one Product Category (Phase 7 master). Document: "(multiple)"."""

    __tablename__ = "buyer_category_links"
    __table_args__ = (UniqueConstraint("buyer_id", "category_id", name="uq_buyer_category"),)

    buyer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("product_categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    buyer: Mapped[Buyer] = relationship(back_populates="category_links")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<BuyerCategoryLink buyer_id={self.buyer_id} category_id={self.category_id}>"


class BuyerSubCategoryLink(Base, UUIDPrimaryKeyMixin):
    """
    Many-to-many link: a buyer to one Product Sub-Category (Phase 7 master).

    Document: "Product Sub Category (potential products for buying from
    us) (multiple based on Product Category selected)".
    """

    __tablename__ = "buyer_sub_category_links"
    __table_args__ = (UniqueConstraint("buyer_id", "sub_category_id", name="uq_buyer_subcategory"),)

    buyer_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("buyers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sub_category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("product_sub_categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    buyer: Mapped[Buyer] = relationship(back_populates="sub_category_links")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<BuyerSubCategoryLink buyer_id={self.buyer_id} sub_category_id={self.sub_category_id}>"