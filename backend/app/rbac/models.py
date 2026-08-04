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

    Permissions are grouped by ``module``, ``page``, ``action``, and ``scope`` for display/organization
    and fine-grained access control.
    """

    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(150), unique=True, nullable=False, index=True)
    module: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    page: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    action: Mapped[str | None] = mapped_column(String(50), nullable=True, index=True)
    scope: Mapped[str | None] = mapped_column(String(50), default="ALL", nullable=True)
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


class UserPermission(Base, UUIDPrimaryKeyMixin):
    """Direct permission override/grant for an individual User."""

    __tablename__ = "user_permissions"
    __table_args__ = (UniqueConstraint("user_id", "permission_id", name="uq_user_permission"),)

    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    permission_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    is_granted: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    permission: Mapped[Permission] = relationship(lazy="selectin")

    def __repr__(self) -> str:
        return f"<UserPermission user_id={self.user_id} permission_id={self.permission_id} is_granted={self.is_granted}>"


class DepartmentPermission(Base, UUIDPrimaryKeyMixin):
    """Default permission granted to all employees in a Department."""

    __tablename__ = "department_permissions"
    __table_args__ = (UniqueConstraint("department_id", "permission_id", name="uq_department_permission"),)

    department_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("departments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    permission_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    permission: Mapped[Permission] = relationship(lazy="selectin")

    def __repr__(self) -> str:
        return f"<DepartmentPermission department_id={self.department_id} permission_id={self.permission_id}>"


class DesignationPermission(Base, UUIDPrimaryKeyMixin):
    """Default permission granted to all employees with a Designation."""

    __tablename__ = "designation_permissions"
    __table_args__ = (UniqueConstraint("designation_id", "permission_id", name="uq_designation_permission"),)

    designation_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("designations.id", ondelete="CASCADE"), nullable=False, index=True
    )
    permission_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("permissions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    granted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)
    granted_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    permission: Mapped[Permission] = relationship(lazy="selectin")

    def __repr__(self) -> str:
        return f"<DesignationPermission designation_id={self.designation_id} permission_id={self.permission_id}>"

