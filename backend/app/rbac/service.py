"""
RBAC Service.

Business logic for role & permission management: creating/updating/deleting
roles, granting/revoking permissions, and resolving a user's roles. System
roles (currently just ``super_admin``) are protected from deletion and
renaming here -- not just by convention -- so an admin can never
accidentally lock every administrator out of the system through the API.
"""

from __future__ import annotations

import uuid

from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.rbac.models import Permission, Role
from app.rbac.repository import PermissionRepository, RoleRepository, UserRoleRepository


class RBACService:
    """Orchestrates role & permission management on top of the RBAC repositories."""

    role_not_found_message = "Role not found."
    permission_not_found_message = "Permission not found."

    def __init__(
        self,
        role_repository: RoleRepository,
        permission_repository: PermissionRepository,
        user_role_repository: UserRoleRepository,
    ) -> None:
        """Bind this service to its repositories."""
        self.role_repository = role_repository
        self.permission_repository = permission_repository
        self.user_role_repository = user_role_repository

    # --- Lookups ------------------------------------------------------------------
    async def get_role_or_raise(self, role_id: uuid.UUID) -> Role:
        """Fetch a role by ID or raise :class:`NotFoundException`."""
        role = await self.role_repository.get_by_id(role_id)
        if role is None:
            raise NotFoundException(self.role_not_found_message)
        return role

    async def get_permission_or_raise(self, permission_id: uuid.UUID) -> Permission:
        """Fetch a permission by ID or raise :class:`NotFoundException`."""
        permission = await self.permission_repository.get_by_id(permission_id)
        if permission is None:
            raise NotFoundException(self.permission_not_found_message)
        return permission

    async def list_roles(self) -> list[Role]:
        """List every role."""
        return await self.role_repository.list_all()

    async def list_permissions(self) -> list[Permission]:
        """List every permission."""
        return await self.permission_repository.list_all()

    async def list_roles_for_user(self, user_id: uuid.UUID) -> list[Role]:
        """List every role currently assigned to a user."""
        links = await self.user_role_repository.list_for_user(user_id)
        return [link.role for link in links]

    async def get_permission_codes_for_role(self, role_id: uuid.UUID) -> list[str]:
        """List the permission codes granted to a single role."""
        role = await self.role_repository.get_with_permissions(role_id)
        if role is None:
            raise NotFoundException(self.role_not_found_message)
        return sorted(link.permission.code for link in role.permission_links)

    # --- Role management ------------------------------------------------------------
    async def create_role(self, *, name: str, description: str | None, permission_codes: list[str]) -> Role:
        """Create a new role and grant it the given permission codes, by code."""
        if await self.role_repository.get_by_name(name) is not None:
            raise ConflictException("A role with that name already exists.")

        role = await self.role_repository.create(name=name, description=description, is_system=False)
        for code in permission_codes:
            permission = await self.permission_repository.get_by_code(code)
            if permission is None:
                raise NotFoundException(f"Unknown permission code: {code!r}.")
            await self.role_repository.add_permission(role, permission)
        return role

    async def update_role(self, role_id: uuid.UUID, *, name: str | None, description: str | None) -> Role:
        """Update a role's name/description. Rejects renaming a system role."""
        role = await self.get_role_or_raise(role_id)
        if name is not None and name != role.name:
            if role.is_system:
                raise ForbiddenException("System roles cannot be renamed.")
            if await self.role_repository.get_by_name(name) is not None:
                raise ConflictException("A role with that name already exists.")
            role.name = name
        if description is not None:
            role.description = description
        await self.role_repository.session.flush()
        return role

    async def delete_role(self, role_id: uuid.UUID) -> None:
        """Delete a role. Rejects deleting a system role."""
        role = await self.get_role_or_raise(role_id)
        if role.is_system:
            raise ForbiddenException("System roles cannot be deleted.")
        await self.role_repository.delete(role)

    # --- Permission grants -----------------------------------------------------------
    async def grant_permission(self, role_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        """Grant a permission to a role, if not already granted."""
        role = await self.get_role_or_raise(role_id)
        permission = await self.get_permission_or_raise(permission_id)
        await self.role_repository.add_permission(role, permission)

    async def revoke_permission(self, role_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        """Revoke a permission from a role."""
        role = await self.get_role_or_raise(role_id)
        removed = await self.role_repository.remove_permission(role, permission_id)
        if not removed:
            raise NotFoundException("The role does not have that permission.")
