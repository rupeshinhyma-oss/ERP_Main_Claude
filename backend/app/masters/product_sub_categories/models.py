"""
Product Sub-Category ORM Model.

Owns the ``product_sub_categories`` table. Every sub-category belongs to
exactly one category; sub-category names must be unique within a category.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class ProductSubCategory(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single product sub-category record, belonging to a category."""

    __tablename__ = "product_sub_categories"
    __table_args__ = (UniqueConstraint("category_id", "name", name="uq_subcategory_category_name"),)

    category_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("product_categories.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="product_subcategory_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<ProductSubCategory code={self.code!r} name={self.name!r}>"
