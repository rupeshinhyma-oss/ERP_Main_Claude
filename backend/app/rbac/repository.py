"""
RBAC Repositories.

Query-specific extensions for ``roles`` and ``permissions``, plus the one
query that matters most for authorization: resolving the full, de-duplicated
set of permission codes granted to a given user through all of their roles.
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.base_repository import BaseRepository
from app.rbac.models import Permission, Role, RolePermission, UserRole


class PermissionRepository(BaseRepository[Permission]):
    """Repository for permission rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Permission`` model."""
        super().__init__(session, Permission)

    async def get_by_code(self, code: str) -> Permission | None:
        """Fetch a permission by its unique code (e.g. ``"user.create"``)."""
        stmt = select(Permission).where(Permission.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Permission]:
        """Return every permission, ordered by module then code."""
        stmt = select(Permission).order_by(Permission.module, Permission.code)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class RoleRepository(BaseRepository[Role]):
    """Repository for role rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Role`` model."""
        super().__init__(session, Role)

    async def get_by_name(self, name: str) -> Role | None:
        """Fetch a role by its unique name."""
        stmt = select(Role).where(Role.name == name)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_with_permissions(self, role_id: uuid.UUID) -> Role | None:
        """Fetch a role with its permission links eagerly loaded, to avoid N+1 lazy-loads."""
        stmt = (
            select(Role)
            .where(Role.id == role_id)
            .options(selectinload(Role.permission_links).selectinload(RolePermission.permission))
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Role]:
        """Return every role, ordered by name."""
        stmt = select(Role).order_by(Role.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_permission_codes_for_user(self, user_id: uuid.UUID) -> set[str]:
        """
        Resolve the full, de-duplicated set of permission codes granted to a user.

        Walks ``user_roles -> role_permissions -> permissions`` in a single
        query. This is the query the login/refresh flow calls to embed the
        ``perms`` claim in a freshly issued access token.
        """
        stmt = (
            select(Permission.code)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .join(UserRole, UserRole.role_id == RolePermission.role_id)
            .where(UserRole.user_id == user_id)
            .distinct()
        )
        result = await self.session.execute(stmt)
        return set(result.scalars().all())

    async def add_permission(self, role: Role, permission: Permission) -> RolePermission:
        """Grant a permission to a role, if not already granted."""
        # Queries for the existing link directly rather than reading
        # role.permission_links -- a freshly created Role instance (as
        # returned by create(), before any subsequent re-query) has never
        # loaded that lazy="selectin" relationship, and touching it here
        # would trigger an implicit lazy-load INSIDE already-running async
        # code, which some async drivers (observed with aiosqlite; not
        # reliably safe on any driver) cannot service and raises
        # MissingGreenlet. A direct, explicitly-awaited query has no such
        # restriction.
        stmt = select(RolePermission).where(
            RolePermission.role_id == role.id, RolePermission.permission_id == permission.id
        )
        existing = (await self.session.execute(stmt)).scalar_one_or_none()
        if existing is not None:
            return existing
        link = RolePermission(role_id=role.id, permission_id=permission.id)
        self.session.add(link)
        await self.session.flush()
        return link

    async def remove_permission(self, role: Role, permission_id: uuid.UUID) -> bool:
        """Revoke a permission from a role. Returns True if a link was removed."""
        # See add_permission() above for why this queries directly rather
        # than reading role.permission_links.
        stmt = select(RolePermission).where(
            RolePermission.role_id == role.id, RolePermission.permission_id == permission_id
        )
        link = (await self.session.execute(stmt)).scalar_one_or_none()
        if link is None:
            return False
        await self.session.delete(link)
        await self.session.flush()
        return True


class UserRoleRepository(BaseRepository[UserRole]):
    """Repository for the user <-> role association table."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``UserRole`` model."""
        super().__init__(session, UserRole)

    async def get(self, user_id: uuid.UUID, role_id: uuid.UUID) -> UserRole | None:
        """Fetch a single user-role assignment, if it exists."""
        stmt = select(UserRole).where(UserRole.user_id == user_id, UserRole.role_id == role_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_for_user(self, user_id: uuid.UUID) -> list[UserRole]:
        """List every role assignment for a user, with the role eagerly loaded."""
        stmt = select(UserRole).where(UserRole.user_id == user_id).options(selectinload(UserRole.role))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())