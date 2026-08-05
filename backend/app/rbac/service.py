"""
RBAC Service.

Business logic for role & permission management: creating/updating/deleting
roles, department permissions, designation permissions, individual user permissions,
and resolving a user's multi-source permissions. System roles (super_admin, admin, user)
are protected from deletion and renaming.
"""

from __future__ import annotations

import uuid

from app.cache.base import CacheBackend
from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.rbac.models import DepartmentPermission, DesignationPermission, Permission, Role, UserPermission
from app.rbac.repository import (
    DepartmentPermissionRepository,
    DesignationPermissionRepository,
    PermissionRepository,
    RoleRepository,
    UserPermissionRepository,
    UserRoleRepository,
)


class RBACService:
    """Orchestrates role & permission management on top of the RBAC repositories."""

    role_not_found_message = "Role not found."
    permission_not_found_message = "Permission not found."

    def __init__(
        self,
        role_repository: RoleRepository,
        permission_repository: PermissionRepository,
        user_role_repository: UserRoleRepository,
        department_permission_repository: DepartmentPermissionRepository | None = None,
        designation_permission_repository: DesignationPermissionRepository | None = None,
        user_permission_repository: UserPermissionRepository | None = None,
        cache: CacheBackend | None = None,
    ) -> None:
        """Bind this service to its repositories."""
        self.role_repository = role_repository
        self.permission_repository = permission_repository
        self.user_role_repository = user_role_repository
        self.department_permission_repository = (
            department_permission_repository or DepartmentPermissionRepository(role_repository.session)
        )
        self.designation_permission_repository = (
            designation_permission_repository or DesignationPermissionRepository(role_repository.session)
        )
        self.user_permission_repository = (
            user_permission_repository or UserPermissionRepository(role_repository.session)
        )
        self.cache = cache

    async def invalidate_user_permissions_cache(self, user_id: uuid.UUID | None = None) -> None:
        """Invalidate user permissions cache to ensure immediate update."""
        if self.cache:
            if user_id:
                key = CacheBackend.build_key("user_perms", str(user_id))
                await self.cache.delete(key)
            else:
                await self.cache.clear_pattern("user_perms:*")

    # --- Lookups ------------------------------------------------------------------
    async def get_role_or_raise(self, role_id: uuid.UUID) -> Role:
        """Fetch a role by ID or raise NotFoundException."""
        role = await self.role_repository.get_by_id(role_id)
        if role is None:
            raise NotFoundException(self.role_not_found_message)
        return role

    async def get_permission_or_raise(self, permission_id: uuid.UUID) -> Permission:
        """Fetch a permission by ID or raise NotFoundException."""
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
        await self.invalidate_user_permissions_cache()
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
        await self.invalidate_user_permissions_cache()
        return role

    async def delete_role(self, role_id: uuid.UUID) -> None:
        """Delete a role. Rejects deleting a system role."""
        role = await self.get_role_or_raise(role_id)
        if role.is_system:
            raise ForbiddenException("System roles cannot be deleted.")
        await self.role_repository.delete(role)
        await self.invalidate_user_permissions_cache()

    # --- Role Permission grants ------------------------------------------------------
    async def grant_permission(self, role_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        """Grant a permission to a role, if not already granted."""
        role = await self.get_role_or_raise(role_id)
        permission = await self.get_permission_or_raise(permission_id)
        await self.role_repository.add_permission(role, permission)
        await self.invalidate_user_permissions_cache()

    async def revoke_permission(self, role_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        """Revoke a permission from a role."""
        role = await self.get_role_or_raise(role_id)
        removed = await self.role_repository.remove_permission(role, permission_id)
        if not removed:
            raise NotFoundException("The role does not have that permission.")
        await self.invalidate_user_permissions_cache()

    # --- Department Permissions ----------------------------------------------------
    async def list_department_permissions(self, department_id: uuid.UUID) -> list[DepartmentPermission]:
        return await self.department_permission_repository.list_for_department(department_id)

    async def grant_department_permission(
        self, department_id: uuid.UUID, permission_id: uuid.UUID, granted_by: uuid.UUID | None = None
    ) -> DepartmentPermission:
        await self.get_permission_or_raise(permission_id)
        link = await self.department_permission_repository.add_permission(department_id, permission_id, granted_by)
        await self.invalidate_user_permissions_cache()
        return link

    async def revoke_department_permission(self, department_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        removed = await self.department_permission_repository.remove_permission(department_id, permission_id)
        if not removed:
            raise NotFoundException("The department does not have that permission.")
        await self.invalidate_user_permissions_cache()

    # --- Designation Permissions ---------------------------------------------------
    async def list_designation_permissions(self, designation_id: uuid.UUID) -> list[DesignationPermission]:
        return await self.designation_permission_repository.list_for_designation(designation_id)

    async def grant_designation_permission(
        self, designation_id: uuid.UUID, permission_id: uuid.UUID, granted_by: uuid.UUID | None = None
    ) -> DesignationPermission:
        await self.get_permission_or_raise(permission_id)
        link = await self.designation_permission_repository.add_permission(designation_id, permission_id, granted_by)
        await self.invalidate_user_permissions_cache()
        return link

    async def revoke_designation_permission(self, designation_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        removed = await self.designation_permission_repository.remove_permission(designation_id, permission_id)
        if not removed:
            raise NotFoundException("The designation does not have that permission.")
        await self.invalidate_user_permissions_cache()

    # --- Individual User Permissions ------------------------------------------------
    async def list_user_permissions(self, user_id: uuid.UUID) -> list[UserPermission]:
        return await self.user_permission_repository.list_for_user(user_id)

    async def assign_user_permission(
        self, user_id: uuid.UUID, permission_id: uuid.UUID, is_granted: bool = True, granted_by: uuid.UUID | None = None
    ) -> UserPermission:
        await self.get_permission_or_raise(permission_id)
        link = await self.user_permission_repository.add_permission(user_id, permission_id, is_granted, granted_by)
        await self.invalidate_user_permissions_cache(user_id)
        return link

    async def remove_user_permission(self, user_id: uuid.UUID, permission_id: uuid.UUID) -> None:
        removed = await self.user_permission_repository.remove_permission(user_id, permission_id)
        if not removed:
            raise NotFoundException("The user does not have that permission override.")
        await self.invalidate_user_permissions_cache(user_id)

    # --- Effective Permissions & Breakdown -----------------------------------------
    async def get_user_effective_permissions(self, user_id: uuid.UUID) -> dict:
        return await self.role_repository.get_effective_permissions_breakdown_for_user(user_id)

    # --- Clone Permission Set -------------------------------------------------------
    async def clone_permission_set(
        self,
        *,
        source_type: str,
        source_id: uuid.UUID,
        target_type: str,
        target_id: uuid.UUID,
        cloned_by: uuid.UUID | None = None,
    ) -> int:
        """Clone all permission links from a source entity (role, department, designation, user) to a target entity."""
        source_perm_ids: list[uuid.UUID] = []
        if source_type == "role":
            role = await self.role_repository.get_with_permissions(source_id)
            if not role:
                raise NotFoundException("Source role not found.")
            source_perm_ids = [link.permission_id for link in role.permission_links]
        elif source_type == "department":
            links = await self.department_permission_repository.list_for_department(source_id)
            source_perm_ids = [link.permission_id for link in links]
        elif source_type == "designation":
            links = await self.designation_permission_repository.list_for_designation(source_id)
            source_perm_ids = [link.permission_id for link in links]
        elif source_type == "user":
            links = await self.user_permission_repository.list_for_user(source_id)
            source_perm_ids = [link.permission_id for link in links if link.is_granted]
        else:
            raise ConflictException("Invalid source_type. Expected: 'role', 'department', 'designation', or 'user'.")

        cloned_count = 0
        if target_type == "role":
            role = await self.get_role_or_raise(target_id)
            for perm_id in source_perm_ids:
                perm = await self.permission_repository.get_by_id(perm_id)
                if perm:
                    await self.role_repository.add_permission(role, perm)
                    cloned_count += 1
        elif target_type == "department":
            for perm_id in source_perm_ids:
                await self.department_permission_repository.add_permission(target_id, perm_id, granted_by=cloned_by)
                cloned_count += 1
        elif target_type == "designation":
            for perm_id in source_perm_ids:
                await self.designation_permission_repository.add_permission(target_id, perm_id, granted_by=cloned_by)
                cloned_count += 1
        elif target_type == "user":
            for perm_id in source_perm_ids:
                await self.user_permission_repository.add_permission(target_id, perm_id, is_granted=True, granted_by=cloned_by)
                cloned_count += 1
        else:
            raise ConflictException("Invalid target_type. Expected: 'role', 'department', 'designation', or 'user'.")

        await self.invalidate_user_permissions_cache()
        return cloned_count
