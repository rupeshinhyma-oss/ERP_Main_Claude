"""
User ORM Model.

Owns *who* the user is (identity + account/security state), as opposed to
:mod:`app.auth.models` which owns *how* they are currently logged in
(sessions, blacklisted tokens, password history) and :mod:`app.rbac.models`
which owns *what they're allowed to do* (roles/permissions).
"""

from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from enum import Enum

from sqlalchemy import Boolean, Date, DateTime, Enum as SAEnum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, SoftDeleteMixin, TimestampMixin, UUIDPrimaryKeyMixin
from app.departments.models import Department
from app.designations.models import Designation


class Gender(str, Enum):
    """Gender enum for user profile."""

    MALE = "MALE"
    FEMALE = "FEMALE"
    OTHER = "OTHER"
    PREFER_NOT_TO_SAY = "PREFER_NOT_TO_SAY"


class EmploymentType(str, Enum):
    """The nature of user engagement."""

    FULL_TIME = "FULL_TIME"
    PART_TIME = "PART_TIME"
    CONTRACT = "CONTRACT"
    INTERN = "INTERN"
    TEMPORARY = "TEMPORARY"


class EmploymentStatus(str, Enum):
    """User employment status."""

    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    ON_LEAVE = "ON_LEAVE"
    TERMINATED = "TERMINATED"
    RESIGNED = "RESIGNED"


class UserStatus(str, Enum):
    """Coarse-grained account lifecycle state, independent of ``is_active``."""

    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    SUSPENDED = "SUSPENDED"
    LOCKED = "LOCKED"
    PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"


class User(Base, UUIDPrimaryKeyMixin, TimestampMixin, SoftDeleteMixin):
    """
    A single unified user record (incorporating login account + profile information).
    """

    __tablename__ = "users"

    # Profile & Identity
    first_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    middle_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    last_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    display_name: Mapped[str | None] = mapped_column(String(200), nullable=True, index=True)

    employee_code: Mapped[str | None] = mapped_column(String(50), unique=True, nullable=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    phone: Mapped[str] = mapped_column(String(30), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

    # Department, Designation & Manager
    department_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("departments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    designation_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("designations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    manager_id: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # HR & Profile Details
    date_of_birth: Mapped[date | None] = mapped_column(Date, nullable=True)
    gender: Mapped[Gender | None] = mapped_column(
        SAEnum(Gender, name="user_gender", native_enum=False, length=20), nullable=True
    )
    date_of_joining: Mapped[date | None] = mapped_column(Date, nullable=True)

    employment_type: Mapped[EmploymentType | None] = mapped_column(
        SAEnum(EmploymentType, name="user_employment_type", native_enum=False, length=20),
        default=EmploymentType.FULL_TIME,
        nullable=True,
    )
    employment_status: Mapped[EmploymentStatus | None] = mapped_column(
        SAEnum(EmploymentStatus, name="user_employment_status", native_enum=False, length=20),
        default=EmploymentStatus.ACTIVE,
        nullable=True,
        index=True,
    )

    profile_picture_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    address: Mapped[str | None] = mapped_column(Text, nullable=True)
    city: Mapped[str | None] = mapped_column(String(100), nullable=True)
    state: Mapped[str | None] = mapped_column(String(100), nullable=True)
    country: Mapped[str | None] = mapped_column(String(100), nullable=True)
    postal_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    emergency_contact: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Account Security & Status
    status: Mapped[UserStatus] = mapped_column(
        SAEnum(UserStatus, name="user_status", native_enum=False, length=30),
        default=UserStatus.PENDING,
        nullable=False,
        index=True,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    password_changed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    failed_login_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    creator: Mapped["User | None"] = relationship("User", remote_side="User.id", foreign_keys=[created_by])
    updater: Mapped["User | None"] = relationship("User", remote_side="User.id", foreign_keys=[updated_by])
    department: Mapped["Department | None"] = relationship("Department", foreign_keys=[department_id])
    designation: Mapped["Designation | None"] = relationship("Designation", foreign_keys=[designation_id])
    manager: Mapped["User | None"] = relationship("User", remote_side="User.id", foreign_keys=[manager_id])

    @property
    def full_name(self) -> str:
        """Return computed full name or fallback to username."""
        if self.display_name:
            return self.display_name
        parts = [p for p in (self.first_name, self.middle_name, self.last_name) if p]
        if parts:
            return " ".join(parts)
        return self.username

    def __repr__(self) -> str:
        """Return a debug-friendly representation (never includes the password hash)."""
        return f"<User username={self.username!r} status={self.status.value}>"

    @property
    def is_locked(self) -> bool:
        """Return True if the account is currently locked out due to failed login attempts."""
        if self.locked_until is None:
            return False
        locked_until = self.locked_until
        if locked_until.tzinfo is None:
            locked_until = locked_until.replace(tzinfo=timezone.utc)
        return locked_until > datetime.now(timezone.utc)

    @property
    def can_login(self) -> bool:
        """Return True if the account is active and in a status that permits authentication."""
        if self.is_locked:
            return False
        # If locked_until has passed, temporary lockout has expired
        lock_expired = self.locked_until is not None and not self.is_locked
        if self.status == UserStatus.LOCKED and not lock_expired:
            return False
        if self.status in (UserStatus.INACTIVE, UserStatus.SUSPENDED):
            return False
        return self.is_active and self.status in (
            UserStatus.ACTIVE,
            UserStatus.PENDING,
            UserStatus.PASSWORD_CHANGE_REQUIRED,
            UserStatus.LOCKED,
        )
