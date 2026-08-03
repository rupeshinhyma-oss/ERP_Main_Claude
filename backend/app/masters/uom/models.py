"""
Unit of Measurement ORM Model.

Owns the ``units_of_measurement`` table: KG, GM, PCS, BOX, LTR, MTR, SET,
PAIR, etc. Every future module storing a quantity should reference this
table instead of a free-text unit string.
"""

from __future__ import annotations

from sqlalchemy import String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class UnitOfMeasurement(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single unit-of-measurement reference record."""

    __tablename__ = "units_of_measurement"

    code: Mapped[str] = mapped_column(String(20), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    short_name: Mapped[str | None] = mapped_column(String(20), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="uom_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<UnitOfMeasurement code={self.code!r} name={self.name!r}>"
