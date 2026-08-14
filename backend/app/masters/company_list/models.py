"""
Company List ORM Model.

Owns the ``master_companies`` table: group operating companies (Inhyma, FNB Solution, etc.).
"""

from __future__ import annotations

from sqlalchemy import JSON, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class MasterCompany(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A company list reference record."""

    __tablename__ = "master_companies"

    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    branches: Mapped[list | None] = mapped_column(JSON, nullable=True)  # list[dict] e.g. [{"id": "...", "name": "Mumbai", "code_prefix": "INM"}]

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="master_company_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<MasterCompany code={self.code!r} name={self.name!r}>"
