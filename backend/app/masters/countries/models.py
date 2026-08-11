"""
Country ORM Model.

Owns the ``countries`` table: the root of the Country -> State -> City
geographic hierarchy, and the reference every future module (suppliers,
buyers, shipping addresses, etc.) should point to via foreign key instead
of storing a free-text country name.
"""

from __future__ import annotations

from sqlalchemy import String
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class Country(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single country reference record."""

    __tablename__ = "countries"

    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(10), unique=True, nullable=False, index=True)  # ISO country code

    phone_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    nationality: Mapped[str | None] = mapped_column(String(100), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(10), nullable=True)  # currency code, e.g. "INR"

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="country_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Country code={self.code!r} name={self.name!r}>"
