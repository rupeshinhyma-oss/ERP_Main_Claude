"""
User ORM Model.

Owns *who* the user is (identity + account/security state), as opposed to
:mod:`app.auth.models` which owns *how* they are currently logged in
(sessions, blacklisted tokens, password history) and :mod:`app.rbac.models`
which owns *what they're allowed to do* (roles/permissions).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from enum import Enum

from sqlalchemy import Boolean, DateTime, Enum as SAEnum, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, TimestampMixin, UUIDPrimaryKeyMixin


class UserStatus(str, Enum):
    """Coarse-grained account lifecycle state, independent of ``is_active``."""

    PENDING = "PENDING"
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    SUSPENDED = "SUSPENDED"
    LOCKED = "LOCKED"
    PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED"


class User(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """
    A single user account.

    Security-relevant fields (``failed_login_count``, ``locked_until``,
    ``password_hash``, ``must_change_password``) are mutated exclusively
    through :mod:`app.auth.service` / :mod:`app.users.service`, never
    directly by routes, so account-lockout and password policy is enforced
    in exactly one place.
    """

    __tablename__ = "users"

    employee_code: Mapped[str | None] = mapped_column(String(50), unique=True, nullable=True, index=True)
    username: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    phone: Mapped[str | None] = mapped_column(String(30), nullable=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)

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

    creator: Mapped["User | None"] = relationship(remote_side="User.id", foreign_keys=[created_by])

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
        if self.is_locked or self.status == UserStatus.LOCKED:
            return False
        if self.status in (UserStatus.INACTIVE, UserStatus.SUSPENDED):
            return False
        return self.is_active and self.status in (
            UserStatus.ACTIVE,
            UserStatus.PENDING,
            UserStatus.PASSWORD_CHANGE_REQUIRED,
        )
