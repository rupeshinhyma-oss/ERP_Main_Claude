"""
State ORM Model.

Owns the ``states`` table. Every state belongs to exactly one country;
state names must be unique within a country (not globally), since e.g.
"Georgia" is both a US state and a country.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class State(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single state/province record, belonging to a country."""

    __tablename__ = "states"
    __table_args__ = (UniqueConstraint("country_id", "name", name="uq_state_country_name"),)

    country_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("countries.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(150), nullable=False, index=True)
    code: Mapped[str | None] = mapped_column(String(20), nullable=True, index=True)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="state_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<State name={self.name!r} country_id={self.country_id}>"
