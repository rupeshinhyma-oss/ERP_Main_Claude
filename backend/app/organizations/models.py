"""
Organization ORM Model.

Owns the ``organizations`` table: the single company profile for this ERP
instance. This ERP is single-company only (no multi-tenancy) -- the
service layer (see :mod:`app.organizations.service`) enforces that at most
one row ever exists, so nothing here uses a tenant/organization_id foreign
key pattern the way a multi-tenant system would.
"""

from __future__ import annotations

from enum import Enum

from sqlalchemy import String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class OrganizationStatus(str, Enum):
    """Lifecycle status of the company profile."""

    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"


class Organization(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """The single company profile record. Exactly one row should ever exist."""

    __tablename__ = "organizations"

    company_name: Mapped[str] = mapped_column(String(200), nullable=False)
    legal_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    logo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    gst_number: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pan_number: Mapped[str | None] = mapped_column(String(50), nullable=True)

    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    website: Mapped[str | None] = mapped_column(String(255), nullable=True)

    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)

    timezone: Mapped[str] = mapped_column(String(50), nullable=False, default="UTC")
    currency: Mapped[str] = mapped_column(String(10), nullable=False, default="USD")
    business_hours: Mapped[str | None] = mapped_column(
        String(255), nullable=True, doc="Free-text business hours, e.g. 'Mon-Fri 09:00-18:00'."
    )

    status: Mapped[OrganizationStatus] = mapped_column(
        SAEnum(OrganizationStatus, name="organization_status", native_enum=False, length=20),
        default=OrganizationStatus.ACTIVE,
        nullable=False,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Organization company_name={self.company_name!r}>"


# Re-exported for modules that only need the generic active/inactive vocabulary.
__all__ = ["Organization", "OrganizationStatus", "RecordStatus"]
