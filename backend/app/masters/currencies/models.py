"""
Currency ORM Model.

Owns the ``currencies`` table: the reference every future module (pricing,
invoicing, finance) should point to instead of storing free-text currency
codes/symbols.
"""

from __future__ import annotations

from sqlalchemy import Integer, String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class Currency(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single currency reference record."""

    __tablename__ = "currencies"

    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(10), unique=True, nullable=False, index=True)  # ISO 4217, e.g. "INR"
    symbol: Mapped[str | None] = mapped_column(String(10), nullable=True)
    decimal_places: Mapped[int] = mapped_column(Integer, default=2, nullable=False)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="currency_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Currency code={self.code!r} name={self.name!r}>"
