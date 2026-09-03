"""
Organization Structure ORM Models.

Owns the tables that model a company's actual organizational shape that
are NOT part of the Role/Department merge:

    positions                          designations/titles
    employee_position_assignments      many-to-many, Person (User) <-> Position
    department_leadership_assignments  who manages/heads which department(s)
    employee_reporting_relationships   who reports to whom (Person <-> Person)

Merge history (why there's no Department OR Employee model here anymore)
-----------------------------------------------------------------------
This module used to also own ``Department`` and
``EmployeeDepartmentAssignment``, kept deliberately separate from
``app.rbac.models.Role`` so organizational placement and software
permissions were independent concerns. The business later decided that
separation was creating more day-to-day confusion (two different
"Departments" screens) than value, and chose to merge Department INTO
Role instead -- an employee's department now directly grants that
department's software permissions (see ``app.rbac.models.Role``
docstring for the full rationale and trade-off). That merge is
implemented in migration ``c3g4o5p6q7r8_merge_department_into_role.py``;
``Department`` and ``EmployeeDepartmentAssignment`` no longer exist as
separate tables or models. Anything in this file that references "which
department" now refers to ``app.rbac.models.Role.id`` (via
``department_id`` columns below, which are foreign keys into ``roles``,
not a dropped ``departments`` table).

Separately, this codebase ALSO used to have a standalone ``app.employees``
module (``Employee``, workforce/person records deliberately independent
of login access). That, too, was merged -- into ``app.users.models.User``
-- once the business found maintaining two separate "who is this person"
tables (one for login, one for organizational placement) created more
friction than the split was worth; ``User.has_login`` now represents
what used to be "does this Employee have a linked User Account" as a
single boolean on a single person record (see ``User`` model docstring
for the full rationale). Every ``employee_id``/``manager_employee_id``
column below is a foreign key into ``users.id``, not a dropped
``employees`` table -- the column names are kept as-is (rather than
renamed to ``user_id``) purely to avoid an unnecessary second column
rename in the same migration that already had a lot of moving parts;
they mean exactly the same thing a ``user_id`` column would.

Position, Department Leadership, and Reporting Structure were NOT part
of the Department/Role merge and keep their original, separate-from-RBAC
design intact: none of the tables below grant or restrict a software
permission, so Positions/Leadership/Reporting remain purely organizational.
"""

from __future__ import annotations

import uuid
from datetime import date
from enum import Enum

from sqlalchemy import Boolean, Date, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy import Enum as SAEnum
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin, VersionMixin


class OrgRecordStatus(str, Enum):
    """
    Lifecycle status for organizational records (Positions and the
    assignment tables below).

    A richer set than ``app.core.constants.RecordStatus`` (which is just
    ACTIVE/INACTIVE) because Part 15 of the upgrade brief specifically
    calls for an ARCHIVED state distinct from INACTIVE: "do not
    immediately delete important organizational records ... allow
    controlled archival if appropriate" -- archived records stay queryable
    for historical/audit purposes but are excluded from active-org-chart
    and active-assignment views, whereas inactive can still mean
    "temporarily not in use, may return".
    """

    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    ARCHIVED = "ARCHIVED"


class PositionAssignmentType(str, Enum):
    """How an employee holds a position/designation (Part 3)."""

    PRIMARY = "PRIMARY"
    SECONDARY = "SECONDARY"
    ACTING = "ACTING"
    TEMPORARY = "TEMPORARY"


class LeadershipType(str, Enum):
    """The kind of leadership role an employee holds over a department (Part 4)."""

    DEPARTMENT_HEAD = "DEPARTMENT_HEAD"
    PRIMARY_MANAGER = "PRIMARY_MANAGER"
    ASSISTANT_MANAGER = "ASSISTANT_MANAGER"
    ACTING_MANAGER = "ACTING_MANAGER"


class ReportingRelationshipType(str, Enum):
    """The kind of employee-to-employee reporting line (Part 5)."""

    PRIMARY_REPORTING = "PRIMARY_REPORTING"
    FUNCTIONAL_REPORTING = "FUNCTIONAL_REPORTING"
    PROJECT_REPORTING = "PROJECT_REPORTING"
    DOTTED_LINE = "DOTTED_LINE"
    TEMPORARY_REPORTING = "TEMPORARY_REPORTING"


class Position(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin, SoftDeleteMixin):
    """
    A position/designation/title (e.g. "Sales Manager", "Marketing
    Advisor") -- intentionally holds NO reporting-hierarchy or permission
    information (Part 3: "Do not assume that designation determines
    reporting hierarchy. Do not assume designation determines software
    permissions."). A Position is not tied to one specific department --
    ``EmployeePositionAssignment.department_id`` records that per
    assignment, since e.g. "Sales Manager" and "Marketing Advisor" may
    both exist as reusable titles across departments.
    """

    __tablename__ = "positions"

    name: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    code: Mapped[str | None] = mapped_column(String(50), unique=True, nullable=True, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[OrgRecordStatus] = mapped_column(
        SAEnum(OrgRecordStatus, name="position_status", native_enum=False, length=20),
        default=OrgRecordStatus.ACTIVE, nullable=False, index=True,
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Position name={self.name!r}>"


class EmployeePositionAssignment(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin):
    """One employee's assignment to one position/designation (Part 3)."""

    __tablename__ = "employee_position_assignments"
    __table_args__ = (
        UniqueConstraint(
            "employee_id", "position_id", "assignment_type",
            name="uq_emp_position_assignment_type",
        ),
    )

    employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    position_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("positions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("roles.id", ondelete="SET NULL"), nullable=True, index=True,
        doc="Optional: which department (app.rbac.models.Role) this specific position "
        "assignment applies to (e.g. 'Sales Manager' scoped to the Sales department).",
    )
    assignment_type: Mapped[PositionAssignmentType] = mapped_column(
        SAEnum(PositionAssignmentType, name="position_assignment_type", native_enum=False, length=20),
        default=PositionAssignmentType.PRIMARY, nullable=False,
    )
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[OrgRecordStatus] = mapped_column(
        SAEnum(OrgRecordStatus, name="position_assignment_status", native_enum=False, length=20),
        default=OrgRecordStatus.ACTIVE, nullable=False, index=True,
    )

    employee: Mapped["User"] = relationship("User", foreign_keys=[employee_id])  # noqa: F821
    position: Mapped["Position"] = relationship("Position", foreign_keys=[position_id], lazy="selectin")
    department: Mapped["Role | None"] = relationship(  # noqa: F821
        "Role", foreign_keys=[department_id], lazy="selectin"
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return (
            f"<EmployeePositionAssignment employee_id={self.employee_id} "
            f"position_id={self.position_id} type={self.assignment_type.value}>"
        )


class DepartmentLeadershipAssignment(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin):
    """
    One person's leadership role over one department (Part 4). The same
    person may lead multiple departments (e.g. PRIMARY_MANAGER of both
    Sales and Marketing) -- each is its own row here, so there is no
    single ``roles.manager_id`` column anywhere forcing a 1:1 shape.
    ``department_id`` is a foreign key into ``roles`` (a department, since
    the Department/Role merge -- see this module's top-of-file docstring),
    not a dropped standalone ``departments`` table. ``employee_id`` is a
    foreign key into ``users`` (since the Employee/User merge), not a
    dropped standalone ``employees`` table.
    """

    __tablename__ = "department_leadership_assignments"
    __table_args__ = (
        UniqueConstraint(
            "department_id", "employee_id", "leadership_type",
            name="uq_dept_leadership_type",
        ),
    )

    department_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    leadership_type: Mapped[LeadershipType] = mapped_column(
        SAEnum(LeadershipType, name="leadership_type", native_enum=False, length=30),
        default=LeadershipType.PRIMARY_MANAGER, nullable=False,
    )
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[OrgRecordStatus] = mapped_column(
        SAEnum(OrgRecordStatus, name="leadership_assignment_status", native_enum=False, length=20),
        default=OrgRecordStatus.ACTIVE, nullable=False, index=True,
    )

    department: Mapped["Role"] = relationship("Role", foreign_keys=[department_id], lazy="selectin")  # noqa: F821
    employee: Mapped["User"] = relationship("User", foreign_keys=[employee_id], lazy="selectin")  # noqa: F821

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return (
            f"<DepartmentLeadershipAssignment department_id={self.department_id} "
            f"employee_id={self.employee_id} type={self.leadership_type.value}>"
        )


class EmployeeReportingRelationship(Base, UUIDPrimaryKeyMixin, TimestampMixin, VersionMixin):
    """
    Person-to-person reporting line (Parts 5-8). Deliberately keyed on
    Person<->Person (``users.id``, since the Employee/User merge), never
    on Role/Position/Department, so that a person's chain of command is
    never accidentally derived from their job title or which software
    role they hold (Part 6). Circular reporting (A->B->C->A, or A->A) is
    rejected at the service layer (``ReportingService``) before a row is
    ever written here -- see that module for the traversal logic; this
    model intentionally contains no validation of its own so there's
    exactly one place that enforces it.
    """

    __tablename__ = "employee_reporting_relationships"
    __table_args__ = (
        UniqueConstraint(
            "employee_id", "manager_employee_id", "relationship_type", "department_id",
            name="uq_reporting_relationship",
        ),
    )

    employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    manager_employee_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    relationship_type: Mapped[ReportingRelationshipType] = mapped_column(
        SAEnum(ReportingRelationshipType, name="reporting_relationship_type", native_enum=False, length=30),
        default=ReportingRelationshipType.PRIMARY_REPORTING, nullable=False,
    )
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("roles.id", ondelete="SET NULL"), nullable=True, index=True,
        doc="Optional: scopes this reporting line to one department (app.rbac.models.Role), "
        "so the same employee can report to different managers in different departments "
        "(Part 6 example: Rahul reports to Amit for Sales, to Rohan for Operations).",
    )
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    effective_from: Mapped[date | None] = mapped_column(Date, nullable=True)
    effective_to: Mapped[date | None] = mapped_column(Date, nullable=True)
    status: Mapped[OrgRecordStatus] = mapped_column(
        SAEnum(OrgRecordStatus, name="reporting_relationship_status", native_enum=False, length=20),
        default=OrgRecordStatus.ACTIVE, nullable=False, index=True,
    )

    employee: Mapped["User"] = relationship(  # noqa: F821
        "User", foreign_keys=[employee_id], lazy="selectin"
    )
    manager: Mapped["User"] = relationship(  # noqa: F821
        "User", foreign_keys=[manager_employee_id], lazy="selectin"
    )
    department: Mapped["Role | None"] = relationship(  # noqa: F821
        "Role", foreign_keys=[department_id], lazy="selectin"
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return (
            f"<EmployeeReportingRelationship employee_id={self.employee_id} "
            f"manager_employee_id={self.manager_employee_id} type={self.relationship_type.value}>"
        )