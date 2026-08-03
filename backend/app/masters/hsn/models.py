"""
HSN ORM Model.

Owns the ``hsn_codes`` table: Harmonized System Nomenclature codes used
for GST classification of goods. Every product should reference an HSN
code instead of storing a free-text tax classification.
"""

from __future__ import annotations

from sqlalchemy import Numeric, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class HsnCode(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single HSN code reference record."""

    __tablename__ = "hsn_codes"

    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    gst_percent: Mapped[float] = mapped_column(Numeric(5, 2), nullable=False, default=0)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="hsn_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<HsnCode code={self.code!r}>"
