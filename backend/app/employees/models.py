"""
Employee ORM Model.

Owns the ``employees`` table: employee *profile* data only. Payroll,
attendance, and leave are explicitly out of scope for this module (see the
Phase 6 spec) and will live in their own future modules that reference
``employees.id``, the same way this module references ``departments`` and
``designations``.

Circular-reference note
------------------------
``manager_id`` is self-referential (an employee's manager is another
employee). ``department_id`` points at ``departments``, which in turn has
its own ``manager_id`` pointing back at ``employees`` -- see
:mod:`app.departments.models` for how that specific cycle is broken with
``use_alter=True``.
"""

from __future__ import annotations

import uuid
from datetime import date
from enum import Enum

from sqlalchemy import Date, ForeignKey, String, Text
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin


class Gender(str, Enum):
    """Self-reported gender, for HR profile completeness. Optional everywhere it's used."""

    MALE = "MALE"
    FEMALE = "FEMALE"
    OTHER = "OTHER"
    PREFER_NOT_TO_SAY = "PREFER_NOT_TO_SAY"


class EmploymentType(str, Enum):
    """The nature of an employee's engagement."""

    FULL_TIME = "FULL_TIME"
    PART_TIME = "PART_TIME"
    CONTRACT = "CONTRACT"
    INTERN = "INTERN"
    TEMPORARY = "TEMPORARY"


class EmploymentStatus(str, Enum):
    """
    Employee lifecycle state.

    ``ACTIVE``/``INACTIVE`` are the two states toggled by the
    deactivate/reactivate features in the Phase 6 spec; ``ON_LEAVE``,
    ``TERMINATED``, and ``RESIGNED`` are included for a realistic HR
    lifecycle even though leave management itself is out of scope here.
    """

    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    ON_LEAVE = "ON_LEAVE"
    TERMINATED = "TERMINATED"
    RESIGNED = "RESIGNED"


class Employee(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """A single employee profile record."""

    __tablename__ = "employees"

    employee_code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)

    first_name: Mapped[str] = mapped_column(String(100), nullable=False)
    middle_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str] = mapped_column(String(100), nullable=False)
    display_name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)

    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    phone: Mapped[str | None] = mapped_column(String(30), unique=True, nullable=True)
    emergency_contact: Mapped[str | None] = mapped_column(
        String(255), nullable=True, doc="Free-text emergency contact name + phone number."
    )

    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    gender: Mapped[Gender | None] = mapped_column(
        SAEnum(Gender, name="employee_gender", native_enum=False, length=20), nullable=True
    )
    date_of_joining: Mapped[date] = mapped_column(Date, nullable=False)

    department_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    designation_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("designations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("employees.id", ondelete="SET NULL"), nullable=True, index=True
    )

    employment_type: Mapped[EmploymentType] = mapped_column(
        SAEnum(EmploymentType, name="employment_type", native_enum=False, length=20),
        default=EmploymentType.FULL_TIME,
        nullable=False,
    )
    employment_status: Mapped[EmploymentStatus] = mapped_column(
        SAEnum(EmploymentStatus, name="employment_status", native_enum=False, length=20),
        default=EmploymentStatus.ACTIVE,
        nullable=False,
        index=True,
    )

    profile_picture_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)

    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- User linking: at most one User per Employee, and vice versa -------
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), unique=True, nullable=True, index=True
    )

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    manager: Mapped["Employee | None"] = relationship(remote_side="Employee.id", foreign_keys=[manager_id])

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Employee employee_code={self.employee_code!r} display_name={self.display_name!r}>"
