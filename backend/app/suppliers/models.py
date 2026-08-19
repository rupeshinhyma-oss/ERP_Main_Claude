"""
Supplier ORM Models.

Owns the ``suppliers``, ``supplier_contacts``, ``supplier_emails``,
``supplier_category_links``, and ``supplier_sub_category_links`` tables.

Built per the "Supplier Profile" specification document. Field names below
map directly to the document's field labels; see the inline comments for
the mapping where the document's label differs from the column name.

This module deliberately does NOT define its own Country/State/City/
Product-Category/Product-Sub-Category tables -- it references the existing
Phase 7 Master Data tables by foreign key (``app.masters.countries``,
``app.masters.states``, ``app.masters.cities``,
``app.masters.product_categories``, ``app.masters.product_sub_categories``),
per the instruction to reuse Master Data rather than duplicate it.

Supplier Type / Grade / Current Status / Potential are small, closed,
supplier-specific vocabularies defined by the document (not general-purpose
reference data other modules would consume), so they are modeled as plain
Python enums local to this module -- the same pattern Phase 6 uses for
``employees.models.EmploymentStatus`` -- rather than as new master tables.
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


class SupplierType(str, Enum):
    """Document: "Supplier Type -- Manufacturer / Trader / Dealer / Select"."""

    MANUFACTURER = "manufacturer"
    TRADER = "trader"
    DEALER = "dealer"
    AGENT = "agent"
    EXPORTER = "exporter"
    WHOLESALER = "wholesaler"
    DISTRIBUTOR = "distributor"


class SupplierGrade(str, Enum):
    """Document: "Supplier's Grade -- A, B, C, Select"."""

    A = "A"
    B = "B"
    C = "C"


class SupplierCurrentStatus(str, Enum):
    """
    Document: "Current Status - Existing/New/Select (by default Select)".

    Business rule (document Notes): once changed from NEW to EXISTING, it
    can never be changed back -- enforced in :mod:`app.suppliers.service`,
    not here, since the ORM layer has no business-rule awareness.
    """

    NEW = "new"
    EXISTING = "existing"


class SupplierPotential(str, Enum):
    """Document: "Potential - Yes / No / Select (by default Select)"."""

    YES = "yes"
    NO = "no"


class Supplier(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """
    A single supplier profile record.

    ``VersionMixin`` (Optimistic Concurrency Control) was added here in
    the Phase 3 performance/correctness audit: the `suppliers.version`
    column has existed at the DATABASE level since migration
    v6w7x8y9z0a1 ("add_version_column_for_occ"), but this model never
    declared the column, so `BaseRepository.update()`'s OCC check always
    saw `None` and silently never fired. No new migration is needed --
    only the model was missing the column, not the database.

    Combines the document's "First data form" and "Second Form (main data
    profile form)" into one table -- the two forms are presented to the
    user as separate steps/tabs, but they describe one supplier record.
    """

    __tablename__ = "suppliers"

    # --- First data form ---------------------------------------------------------------
    company_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)  # "Name of Company*"
    supplier_type: Mapped[str | None] = mapped_column(String(150), nullable=True)
    brand_description: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # "Brand of Suppliers Products (description)" -- free text, not the Phase 7 Brand master

    country_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("countries.id", ondelete="RESTRICT"), nullable=False, index=True
    )  # "Country* (default China but editable)" -- default applied at the service/schema layer
    state_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("states.id", ondelete="RESTRICT"), nullable=False, index=True
    )  # document calls this "Province*"
    city_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("cities.id", ondelete="RESTRICT"), nullable=False, index=True
    )

    # Primary contact person, captured directly on the First Data Form. Per
    # the document's Notes ("First Form contact details should appear in
    # the Contact list also"), a matching SupplierContact row is created
    # automatically alongside this -- see SupplierService.create().
    contact_salutation: Mapped[str | None] = mapped_column(String(10), nullable=True)  # "Mr. / Mrs / Ms"
    contact_full_name: Mapped[str | None] = mapped_column(String(150), nullable=True)
    contact_designation: Mapped[str | None] = mapped_column(String(150), nullable=True)
    contact_calling_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    contact_whatsapp_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    contact_wechat_number: Mapped[str | None] = mapped_column(String(20), nullable=True)

    # --- Second form (main data profile form) --------------------------------------------
    tax_id_number: Mapped[str | None] = mapped_column(String(100), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    town: Mapped[str | None] = mapped_column(String(150), nullable=True)
    primary_website: Mapped[str | None] = mapped_column(Text, nullable=True)
    secondary_website: Mapped[str | None] = mapped_column(Text, nullable=True)

    supplier_grade: Mapped[SupplierGrade | None] = mapped_column(
        SAEnum(SupplierGrade, name="supplier_grade", native_enum=False, length=5), nullable=True
    )
    current_status: Mapped[SupplierCurrentStatus | None] = mapped_column(
        SAEnum(SupplierCurrentStatus, name="supplier_current_status", native_enum=False, length=20),
        nullable=True,
    )  # "by default Select" -- modeled as nullable rather than a forced default
    potential: Mapped[SupplierPotential | None] = mapped_column(
        SAEnum(SupplierPotential, name="supplier_potential", native_enum=False, length=10), nullable=True
    )  # "by default Select"
    potential_reason: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # "Key Reason for Potential / Not potential"

    secondary_products_description: Mapped[str | None] = mapped_column(
        Text, nullable=True
    )  # "Suppliers/Manufacturer's Secondary Products they can supply (description)"

    visited_factory_office: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False
    )  # "Visited their Factory/Office? Yes/No (by default No)"
    visit_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)  # only meaningful if visited=True
    visit_media: Mapped[list | None] = mapped_column(
        JSON, nullable=True
    )  # "Visit Photos / Videos" -- list[str] of file URLs/paths, same JSON-array pattern as Product.images

    overall_remarks: Mapped[str | None] = mapped_column(Text, nullable=True)  # "Overall Remarks / Key Strengths"

    # Active/Inactive toggle. Distinct from soft-delete: the document's
    # Notes explicitly require an Inactive state reachable even when a
    # record can never be hard/soft-deleted (see SupplierService.delete()).
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False, index=True)

    emails: Mapped[list["SupplierEmail"]] = relationship(
        back_populates="supplier", cascade="all, delete-orphan", lazy="selectin"
    )
    contacts: Mapped[list["SupplierContact"]] = relationship(
        back_populates="supplier", cascade="all, delete-orphan", lazy="selectin"
    )
    category_links: Mapped[list["SupplierCategoryLink"]] = relationship(
        back_populates="supplier", cascade="all, delete-orphan", lazy="selectin"
    )
    sub_category_links: Mapped[list["SupplierSubCategoryLink"]] = relationship(
        back_populates="supplier", cascade="all, delete-orphan", lazy="selectin"
    )
    product_links: Mapped[list["SupplierProductLink"]] = relationship(
        back_populates="supplier", cascade="all, delete-orphan", lazy="selectin"
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Supplier company_name={self.company_name!r}>"


class SupplierEmail(Base, UUIDPrimaryKeyMixin):
    """
    One email address belonging to a supplier.

    Document: "Email ID (multiple emails)" -- modeled as a child table
    rather than a JSON array so each address stays individually queryable
    (e.g. duplicate-detection lookups by email in a future phase).
    """

    __tablename__ = "supplier_emails"
    __table_args__ = (UniqueConstraint("supplier_id", "email", name="uq_supplier_email"),)

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)

    supplier: Mapped[Supplier] = relationship(back_populates="emails")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<SupplierEmail email={self.email!r}>"


class SupplierContact(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """
    One contact person for a supplier ("Add Contacts Form/List" in the document).

    The supplier's First-Data-Form contact is mirrored into a row here at
    creation time (see :meth:`app.suppliers.service.SupplierService.create`),
    satisfying the document's Note: "First Form contact details should
    appear in the Contact list also."
    """

    __tablename__ = "supplier_contacts"

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    salutation: Mapped[str | None] = mapped_column(String(10), nullable=True)  # "Mr. / Mrs / Ms"
    person_name: Mapped[str] = mapped_column(String(150), nullable=False)
    designation: Mapped[str | None] = mapped_column(String(150), nullable=True)
    handling_territory: Mapped[str | None] = mapped_column(
        String(150), nullable=True
    )  # "local, Export India, Export Africa etc." -- free text per the document
    country_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("countries.id", ondelete="SET NULL"), nullable=True, index=True
    )  # "Country (dropdown menu) (by default China)"
    calling_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    whatsapp_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    wechat_number: Mapped[str | None] = mapped_column(String(20), nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Marks the contact auto-created from the First Data Form, so the
    # service layer can keep it in sync if the supplier's primary contact
    # fields are edited later, and so the UI can indicate provenance.
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    supplier: Mapped[Supplier] = relationship(back_populates="contacts")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<SupplierContact person_name={self.person_name!r}>"


class SupplierCategoryLink(Base, UUIDPrimaryKeyMixin):
    """
    Many-to-many link: a supplier to one Product Category (Phase 7 master).

    Document: "Product Category (drop down menu) (multiple)".
    """

    __tablename__ = "supplier_category_links"
    __table_args__ = (UniqueConstraint("supplier_id", "category_id", name="uq_supplier_category"),)

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("product_categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    supplier: Mapped[Supplier] = relationship(back_populates="category_links")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<SupplierCategoryLink supplier_id={self.supplier_id} category_id={self.category_id}>"


class SupplierSubCategoryLink(Base, UUIDPrimaryKeyMixin):
    """
    Many-to-many link: a supplier to one Product Sub-Category (Phase 7 master).

    Document: "Suppliers Key Strength Product Sub Category (dropdown menu)
    (multiple)".
    """

    __tablename__ = "supplier_sub_category_links"
    __table_args__ = (UniqueConstraint("supplier_id", "sub_category_id", name="uq_supplier_subcategory"),)

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    sub_category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("product_sub_categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    supplier: Mapped[Supplier] = relationship(back_populates="sub_category_links")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return (
            f"<SupplierSubCategoryLink supplier_id={self.supplier_id} "
            f"sub_category_id={self.sub_category_id}>"
        )


class SupplierProductLink(Base, UUIDPrimaryKeyMixin):
    """
    Many-to-many link: a supplier to one specific Product (the Phase 7/9
    item master, ``app.masters.products.models.Product``).

    Distinct from SupplierCategoryLink/SupplierSubCategoryLink above (which
    only say "this supplier operates somewhere in this broad category"):
    this table records that a supplier is a confirmed source for one exact
    SKU, since Products is the central item master every other module
    (Suppliers now, Purchase/Inventory/Sales later) is meant to key off of
    rather than duplicate.
    """

    __tablename__ = "supplier_product_links"
    __table_args__ = (UniqueConstraint("supplier_id", "product_id", name="uq_supplier_product"),)

    supplier_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("suppliers.id", ondelete="CASCADE"), nullable=False, index=True
    )
    product_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("products.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    supplier: Mapped[Supplier] = relationship(back_populates="product_links")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<SupplierProductLink supplier_id={self.supplier_id} product_id={self.product_id}>"