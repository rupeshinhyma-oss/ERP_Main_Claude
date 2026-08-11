"""
Product ORM Model.

Owns the ``products`` table: the central item master every future
transactional module (Purchase, Sales, Inventory) references instead of
storing item details inline. Deliberately the richest master in this
module -- it pulls together Category, Sub-Category, Brand, HSN, and UOM
by foreign key, plus the full set of descriptive/specification/inventory
fields a real item master needs (not just a bare code+name).

``images`` is stored as a JSON array of URL/path strings (an ERP item
master commonly needs several product photos, not one), using a portable
``JSON`` column type rather than a Postgres-only ``ARRAY``/``JSONB`` so
the same model still works against SQLite in tests.
"""

from __future__ import annotations

import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, Numeric, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class Product(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single product/item master record."""

    __tablename__ = "products"

    # --- Identity -----------------------------------------------------------------
    product_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    product_name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)  # Legacy alias
    product_name_tally: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    product_name_invoice: Mapped[str | None] = mapped_column(String(255), nullable=True)
    barcode: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)

    # --- Classification (foreign keys into the other Master Data tables) ----------
    category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("product_categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    sub_category_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("product_sub_categories.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    brand_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("brands.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    hsn_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("hsn_codes.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    uom_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("units_of_measurement.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    secondary_uom_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("units_of_measurement.id", ondelete="RESTRICT"), nullable=True, index=True
    )
    organization_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("master_companies.id", ondelete="SET NULL"), nullable=True, index=True
    )
    organization_ids: Mapped[list | None] = mapped_column(JSON, nullable=True)  # list[str] of organization UUIDs

    # --- Tax & Compliance ---------------------------------------------------------
    refund_vat_percent: Mapped[float] = mapped_column(Numeric(5, 2), default=0.0, nullable=False)
    license_certificate_required: Mapped[str | None] = mapped_column(Text, nullable=True)  # Highlight RED in Inquiry if set

    # --- Descriptive ----------------------------------------------------------------
    specification: Mapped[str | None] = mapped_column(Text, nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    images: Mapped[list | None] = mapped_column(JSON, nullable=True)  # list[str] of image URLs/paths

    # --- Physical & Packaging Attributes ------------------------------------------
    packaging_quantity: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    packaging_net_weight: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    packaging_gross_weight: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    weight: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)  # in kg
    length: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)  # in cm
    width: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)  # in cm
    height: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)  # in cm
    length_cm: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    width_cm: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    height_cm: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    packaging_unit_cbm: Mapped[float | None] = mapped_column(Numeric(12, 6), nullable=True)  # Auto computed: L*W*H/1,000,000
    color: Mapped[str | None] = mapped_column(String(50), nullable=True)
    material: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # --- Inventory & Commercial ---------------------------------------------------
    current_stock: Mapped[float] = mapped_column(Numeric(14, 3), default=0.0, nullable=False)
    conversion_factor: Mapped[float | None] = mapped_column(
        Numeric(12, 4), nullable=True
    )  # secondary_uom per 1 primary uom, when secondary_uom_id is set
    minimum_order_quantity: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    reorder_level: Mapped[float | None] = mapped_column(Numeric(12, 3), nullable=True)
    standard_cost: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    standard_price: Mapped[float | None] = mapped_column(Numeric(14, 2), nullable=True)
    is_purchasable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_sellable: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_active_for_inventory: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="product_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Product code={self.product_code!r} name={self.product_name!r}>"
