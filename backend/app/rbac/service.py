"""
RBAC Service.

Business logic for role & permission management: creating/updating/deleting
roles, individual user permissions, and resolving a user's multi-source
permissions.

Exactly two system roles exist and are protected from deletion, renaming,
and re-creation under a different meaning: ``super_admin`` (shown to users
as "Admin" -- reserved for the single bootstrap admin account only, see
``app.users.service.UserService.assign_role``) and ``user`` (the default
role every other new account gets). Everything else is a regular,
fully-editable custom role.
"""

from __future__ import annotations

import uuid

from sqlalchemy.exc import IntegrityError

from app.cache.base import CacheBackend
from app.core.exceptions import ConflictException, ForbiddenException, NotFoundException
from app.rbac.models import Permission, Role, UserPermission
from app.rbac.repository import (
    PermissionRepository,
    RoleRepository,
    UserPermissionRepository,
    UserRoleRepository,
)

# Role names that are reserved for the system and can never be created,
# renamed to, or deleted through the admin API -- "super_admin" (shown to
# users as "Admin", reserved for the bootstrap admin account only) and
# "user" (the default role auto-assigned to every new account).
#
# "admin" is ALSO reserved even though it isn't a real system role name --
# a previous version of this app used to seed a duplicate "admin" role
# alongside "super_admin", and without this entry someone could recreate a
# same-named role through "+ ADD NEW" today, producing two confusingly
# similar rows ("admin" and "Admin") in the Roles & Permissions list. The
# comparison below is case-insensitive, so "Admin", "ADMIN", etc. are
# blocked too.
RESERVED_ROLE_NAMES = {"super_admin", "user", "admin"}


class RBACService:
    """Orchestrates role & permission management on top of the RBAC repositories."""

    role_not_found_message = "Role not found."
    permission_not_found_message = "Permission not found."

    def __init__(
        self,
        role_repository: RoleRepository,
        permission_repository: PermissionRepository,
        user_role_repository: UserRoleRepository,
        user_permission_repository: UserPermissionRepository | None = None,
        cache: CacheBackend | None = None,
    ) -> None:
        """Bind this service to its repositories."""
        self.role_repository = role_repository
        self.permission_repository = permission_repository
        self.user_role_repository = user_role_repository
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
                # Every cached key for this namespace is named "user_perms:<id>"
                # (see build_key above) -- delete_namespace() removes all of
                # them at once. NOTE: this used to call a "clear_pattern"
                # method that no CacheBackend implementation actually has;
                # that was a bug that made every role create/update/delete
                # crash with a raw 500 ("no attribute 'clear_pattern'").
                await self.cache.delete_namespace("user_perms")

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
    async def create_role(
        self,
        *,
        name: str,
        description: str | None,
        permission_codes: list[str],
        code: str | None = None,
        parent_department_id: uuid.UUID | None = None,
    ) -> Role:
        """
        Create a new role/department and grant it the given permission codes, by code.

        ``code`` and ``parent_department_id`` are the organizational-department
        fields carried over from the Department/Role merge (see ``Role``
        docstring in ``app.rbac.models``) -- both optional, since a Role
        can be a pure permission bundle with no organizational placement.
        """
        normalized_name = name.strip()
        if not normalized_name:
            raise ConflictException("Role name cannot be empty.")
        if normalized_name.lower() in RESERVED_ROLE_NAMES:
            raise ConflictException(
                f"{normalized_name!r} is a reserved system role name and cannot be used for a new role."
            )
        if await self.role_repository.get_by_name(normalized_name) is not None:
            raise ConflictException("A role with that name already exists.")
        if code and await self.role_repository.code_exists(code):
            raise ConflictException(f"Department code {code!r} is already in use.")
        if parent_department_id is not None:
            await self.get_role_or_raise(parent_department_id)  # 404s cleanly if the parent doesn't exist

        # Resolve every permission code up-front, before creating anything,
        # so an unknown code fails fast without leaving a half-created role
        # behind with only some of its intended permissions granted.
        resolved_permissions: list[Permission] = []
        for perm_code in permission_codes:
            permission = await self.permission_repository.get_by_code(perm_code)
            if permission is None:
                raise NotFoundException(f"Unknown permission code: {perm_code!r}.")
            resolved_permissions.append(permission)

        try:
            role = await self.role_repository.create(
                name=normalized_name, description=description, is_system=False,
                code=code, parent_department_id=parent_department_id,
            )
            for permission in resolved_permissions:
                await self.role_repository.add_permission(role, permission)
            if parent_department_id is not None:
                await self.role_repository.add_parent_link(role.id, parent_department_id)
        except IntegrityError as exc:
            # Defense-in-depth against a race: two requests creating a role
            # with the same name at nearly the same instant can both pass
            # the get_by_name() check above before either commits. The
            # database's unique constraint on roles.name is the real
            # guarantee; translate its violation into the same friendly
            # conflict error rather than letting it surface as a raw 500.
            await self.role_repository.session.rollback()
            raise ConflictException("A role with that name already exists.") from exc

        await self.invalidate_user_permissions_cache()
        return role

    async def update_role(
        self,
        role_id: uuid.UUID,
        *,
        name: str | None,
        description: str | None,
        code: str | None = None,
        parent_department_id: uuid.UUID | None = None,
        unset_parent: bool = False,
    ) -> Role:
        """Update a role/department's name/description/organizational fields. Rejects renaming a system role."""
        role = await self.get_role_or_raise(role_id)
        if name is not None and name.strip() != role.name:
            if role.is_system:
                raise ForbiddenException("System roles cannot be renamed.")
            normalized_name = name.strip()
            if not normalized_name:
                raise ConflictException("Role name cannot be empty.")
            if normalized_name.lower() in RESERVED_ROLE_NAMES:
                raise ConflictException(
                    f"{normalized_name!r} is a reserved system role name and cannot be used."
                )
            if await self.role_repository.get_by_name(normalized_name) is not None:
                raise ConflictException("A role with that name already exists.")
            role.name = normalized_name
        if description is not None:
            role.description = description
        if code is not None:
            if code and await self.role_repository.code_exists(code, exclude_id=role_id):
                raise ConflictException(f"Department code {code!r} is already in use.")
            role.code = code or None
        if unset_parent:
            if role.parent_department_id:
                await self.role_repository.remove_parent_link(role_id, role.parent_department_id)
            role.parent_department_id = None
        elif parent_department_id is not None:
            if parent_department_id != role.parent_department_id:
                await self.get_role_or_raise(parent_department_id)
                if await self.role_repository.would_create_cycle(role_id, parent_department_id):
                    raise ConflictException("This would create a circular department hierarchy.")
                await self.role_repository.add_parent_link(role_id, parent_department_id)
                role.parent_department_id = parent_department_id
        try:
            await self.role_repository.session.flush()
        except IntegrityError as exc:
            await self.role_repository.session.rollback()
            raise ConflictException("A role with that name already exists.") from exc
        await self.invalidate_user_permissions_cache()
        return role

    async def get_hierarchy(self, role_id: uuid.UUID) -> dict[str, list[Role]]:
        """Return connected parents and children for a department."""
        await self.get_role_or_raise(role_id)
        parents = await self.role_repository.get_parents(role_id)
        children = await self.role_repository.get_children(role_id)
        return {"parents": parents, "children": children}

    async def add_parent_department(self, child_id: uuid.UUID, parent_id: uuid.UUID) -> dict[str, list[Role]]:
        """Add a parent department to this child department."""
        if child_id == parent_id:
            raise ConflictException("A department cannot be its own parent.")
        await self.get_role_or_raise(child_id)
        await self.get_role_or_raise(parent_id)

        if await self.role_repository.would_create_cycle(child_id, parent_id):
            raise ConflictException("This would create a circular department hierarchy.")

        await self.role_repository.add_parent_link(child_id, parent_id)
        return await self.get_hierarchy(child_id)

    async def remove_parent_department(self, child_id: uuid.UUID, parent_id: uuid.UUID) -> dict[str, list[Role]]:
        """Remove a parent department link."""
        await self.get_role_or_raise(child_id)
        await self.role_repository.remove_parent_link(child_id, parent_id)
        return await self.get_hierarchy(child_id)

    async def add_child_department(self, parent_id: uuid.UUID, child_id: uuid.UUID) -> dict[str, list[Role]]:
        """Add a child department under this parent department."""
        if child_id == parent_id:
            raise ConflictException("A department cannot be its own child.")
        await self.get_role_or_raise(parent_id)
        await self.get_role_or_raise(child_id)

        if await self.role_repository.would_create_cycle(child_id, parent_id):
            raise ConflictException("This would create a circular department hierarchy.")

        await self.role_repository.add_parent_link(child_id, parent_id)
        return await self.get_hierarchy(parent_id)

    async def remove_child_department(self, parent_id: uuid.UUID, child_id: uuid.UUID) -> dict[str, list[Role]]:
        """Remove a child department link."""
        await self.get_role_or_raise(parent_id)
        await self.role_repository.remove_parent_link(child_id, parent_id)
        return await self.get_hierarchy(parent_id)

    async def get_role_deletion_impact(self, role_id: uuid.UUID) -> dict:
        """
        Preview what deleting a role would affect: the role itself, plus
        every user currently assigned to it. The frontend uses this to show
        a confirmation dialog ("N users are on this role -- reassign them
        to:") before actually calling delete_role().
        """
        role = await self.get_role_or_raise(role_id)
        assignments = await self.user_role_repository.list_for_role(role_id)
        affected_users = [
            {
                "id": str(link.user.id),
                "username": link.user.username,
                "display_name": link.user.display_name or link.user.full_name or link.user.username,
            }
            for link in assignments
            if link.user is not None
        ]
        return {
            "role_id": str(role.id),
            "role_name": role.name,
            "is_system": role.is_system,
            "affected_user_count": len(affected_users),
            "affected_users": affected_users,
        }

    async def delete_role(
        self,
        role_id: uuid.UUID,
        *,
        reassign_to_role_id: uuid.UUID | None = None,
        reassigned_by: uuid.UUID | None = None,
    ) -> int:
        """
        Delete a role. Rejects deleting a system role.

        If any users are currently assigned to this role, ``reassign_to_role_id``
        must name another role to move them to first (defaulting, in the
        caller, to the "user" role) -- otherwise those users would silently
        lose whatever access this role granted them the moment it's deleted,
        with no record of what happened. Returns the number of users
        reassigned.
        """
        role = await self.get_role_or_raise(role_id)
        if role.is_system:
            raise ForbiddenException("System roles cannot be deleted.")

        assignments = await self.user_role_repository.list_for_role(role_id)
        reassigned_count = 0
        if assignments:
            if reassign_to_role_id is None:
                raise ConflictException(
                    f"{len(assignments)} user(s) are still assigned to this role. "
                    "Specify a role to reassign them to before deleting it."
                )
            if reassign_to_role_id == role_id:
                raise ConflictException("Cannot reassign users to the role being deleted.")
            target_role = await self.get_role_or_raise(reassign_to_role_id)

            for link in assignments:
                # Skip a user who (unusually) already holds the target role
                # too -- just drop the old link, nothing to add.
                existing_target_link = await self.user_role_repository.get(link.user_id, target_role.id)
                if existing_target_link is None:
                    await self.user_role_repository.create(
                        user_id=link.user_id,
                        role_id=target_role.id,
                        assigned_at=link.assigned_at,
                        assigned_by=reassigned_by,
                    )
                await self.user_role_repository.delete(link)
                reassigned_count += 1

        await self.role_repository.delete(role)
        await self.invalidate_user_permissions_cache()
        return reassigned_count

    # --- Role Permission grants ------------------------------------------------------
    async def grant_permission(self, role_id: uuid.UUID, permission_id: uuid.UUID, *, actor_user_id: uuid.UUID | None = None) -> None:
        """Grant a permission to a role, if not already granted."""
        role = await self.get_role_or_raise(role_id)
        if role.name == "super_admin" and actor_user_id:
            roles = await self.list_roles_for_user(actor_user_id)
            if not any(r.name == "super_admin" for r in roles):
                raise ForbiddenException("Only Super Administrators can modify Super Administrator permissions.")
        permission = await self.get_permission_or_raise(permission_id)
        await self.role_repository.add_permission(role, permission)
        await self.invalidate_user_permissions_cache()

    async def revoke_permission(self, role_id: uuid.UUID, permission_id: uuid.UUID, *, actor_user_id: uuid.UUID | None = None) -> None:
        """Revoke a permission from a role."""
        role = await self.get_role_or_raise(role_id)
        if role.name == "super_admin" and actor_user_id:
            roles = await self.list_roles_for_user(actor_user_id)
            if not any(r.name == "super_admin" for r in roles):
                raise ForbiddenException("Only Super Administrators can modify Super Administrator permissions.")
        removed = await self.role_repository.remove_permission(role, permission_id)
        if not removed:
            raise NotFoundException("The role does not have that permission.")
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

    async def set_user_permissions_bulk(
        self,
        user_id: uuid.UUID,
        overrides: list[tuple[uuid.UUID, bool]],
        granted_by: uuid.UUID | None = None,
    ) -> int:
        """Replace all direct permission overrides for a user with the provided list."""
        for perm_id, _ in overrides:
            await self.get_permission_or_raise(perm_id)
        await self.user_permission_repository.set_user_permissions_bulk(
            user_id, overrides=overrides, granted_by=granted_by
        )
        await self.invalidate_user_permissions_cache(user_id)
        return len(overrides)

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
        """Clone all permission links from a source entity (role, user) to a target entity."""
        source_perm_ids: list[uuid.UUID] = []
        if source_type == "role":
            role = await self.role_repository.get_with_permissions(source_id)
            if not role:
                raise NotFoundException("Source role not found.")
            source_perm_ids = [link.permission_id for link in role.permission_links]
        elif source_type == "user":
            links = await self.user_permission_repository.list_for_user(source_id)
            source_perm_ids = [link.permission_id for link in links if link.is_granted]
        else:
            raise ConflictException("Invalid source_type. Expected: 'role' or 'user'.")

        cloned_count = 0
        if target_type == "role":
            role = await self.get_role_or_raise(target_id)
            for perm_id in source_perm_ids:
                perm = await self.permission_repository.get_by_id(perm_id)
                if perm:
                    await self.role_repository.add_permission(role, perm)
                    cloned_count += 1
        elif target_type == "user":
            for perm_id in source_perm_ids:
                await self.user_permission_repository.add_permission(target_id, perm_id, is_granted=True, granted_by=cloned_by)
                cloned_count += 1
        else:
            raise ConflictException("Invalid target_type. Expected: 'role' or 'user'.")

        await self.invalidate_user_permissions_cache()
        return cloned_count