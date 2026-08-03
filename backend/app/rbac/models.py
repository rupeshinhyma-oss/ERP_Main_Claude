"""
RBAC ORM Models.

Owns the four tables that implement role-based access control:

    - ``permissions``       : the fixed vocabulary of fine-grained actions
                                (e.g. ``"user.create"``), always seeded from
                                code (``scripts/seed.py``) -- never entered
                                free-form through the API.
    - ``roles``              : named bundles of permissions (e.g. ``super_admin``).
    - ``role_permissions``   : many-to-many link between roles and permissions.
    - ``user_roles``         : many-to-many link between users and roles.

Permissions are never hardcoded into route/dependency logic -- they are
looked up from these tables at login/refresh time and embedded in the
access token (see ``app.auth.security.create_access_token``).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.users.models import User


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


class Permission(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """
    A single, fine-grained permission code (e.g. ``"user.create"``).

    Permissions are grouped by ``module`` purely for display/organization in
    the admin UI (e.g. listing all ``"user.*"`` permissions together); the
    authorization check itself only ever compares the full ``code``.
    """

    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    module: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Permission code={self.code!r}>"


class Role(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """
    A named, assignable bundle of permissions.

    ``is_system`` marks roles that are seeded by the application itself
    (currently just ``super_admin``) and must be protected from deletion or
    renaming through the admin API, since removing them could lock every
    administrator out of the system.
    """

    __tablename__ = "roles"

    name: Mapped[str] = mapped_column(String(100), unique=True, nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    permission_links: Mapped[list["RolePermission"]] = relationship(
        back_populates="role", cascade="all, delete-orphan", lazy="selectin"
    )

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<Role name={self.name!r}>"


class RolePermission(Base, UUIDPrimaryKeyMixin):
    """Many-to-many link granting one ``Permission`` to one ``Role``."""

    __tablename__ = "role_permissions"
    __table_args__ = (UniqueConstraint("role_id", "permission_id", name="uq_role_permission"),)

    role_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    permission_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False
    )
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    role: Mapped[Role] = relationship(back_populates="permission_links")
    permission: Mapped[Permission] = relationship(lazy="selectin")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<RolePermission role_id={self.role_id} permission_id={self.permission_id}>"


class UserRole(Base, UUIDPrimaryKeyMixin):
    """Many-to-many link assigning one ``Role`` to one ``User``."""

    __tablename__ = "user_roles"
    __table_args__ = (UniqueConstraint("user_id", "role_id", name="uq_user_role"),)

    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    role_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("roles.id", ondelete="CASCADE"), nullable=False)
    assigned_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    assigned_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    user: Mapped["User"] = relationship(foreign_keys=[user_id])
    role: Mapped[Role] = relationship(lazy="selectin")

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<UserRole user_id={self.user_id} role_id={self.role_id}>"
