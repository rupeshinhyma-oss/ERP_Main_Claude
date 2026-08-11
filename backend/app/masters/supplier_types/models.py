"""
SupplierType ORM Model.

Owns the ``supplier_types`` table: configurable supplier classifications
(e.g., Manufacturer, Dealer/Trader, Agent, Importer, Service Provider).
"""

from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class SupplierType(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single supplier type reference record."""

    __tablename__ = "supplier_types"

    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="supplier_type_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<SupplierType code={self.code!r} name={self.name!r}>"
