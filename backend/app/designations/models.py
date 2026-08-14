"""
Designation ORM Model.

Owns the ``designations`` table: job titles/levels assignable to
employees (e.g. "Software Engineer II", level 3).
"""

from __future__ import annotations

from sqlalchemy import Integer, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import RecordStatus
from app.database.base import Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin, VersionMixin


class Designation(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """
    A single job title/level record.

    Soft-delete (``SoftDeleteMixin``): deleting a designation must never
    hard-delete it, since employees may reference it historically and the
    company-wide policy is a recoverable delete for every module (see
    ``BaseRepository.delete`` and the Trash module). Previously this model
    had no soft-delete support, so ``DesignationService.delete`` was a
    real, unrecoverable hard delete -- the one genuine gap found when
    auditing every module's delete path against that policy.
    """

    __tablename__ = "designations"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(150), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    level: Mapped[int | None] = mapped_column(Integer, nullable=True)

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="designation_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Designation code={self.code!r} title={self.title!r}>"