"""
Department ORM Model.

Owns the ``departments`` table. Departments are self-referential (a
department may have a parent department) and each department may have a
``manager`` -- an ``Employee``. Because ``employees.department_id`` also
points back at ``departments``, the two tables have a circular
relationship; ``manager_id`` uses ``use_alter=True`` so Alembic/SQLAlchemy
can create both tables and add this specific foreign key as a separate
``ALTER TABLE`` step, breaking the create-order cycle.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import RecordStatus
from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class Department(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single department/org-unit record."""

    __tablename__ = "departments"

    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(150), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    parent_department_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(),
        ForeignKey("users.id", ondelete="SET NULL", use_alter=True, name="fk_departments_manager_id"),
        nullable=True,
        index=True,
    )

    status: Mapped[RecordStatus] = mapped_column(
        SAEnum(RecordStatus, name="department_status", native_enum=False, length=20),
        default=RecordStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    parent_department: Mapped["Department | None"] = relationship(
        remote_side="Department.id", foreign_keys=[parent_department_id]
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Department code={self.code!r} name={self.name!r}>"
