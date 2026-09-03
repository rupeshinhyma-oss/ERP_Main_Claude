"""
RBAC Repositories.

Query-specific extensions for ``roles``, ``permissions``, ``user_permissions``,
and the permission calculation resolving effective permissions across:
1. Assigned System / Custom Roles
2. Individual User Permission Overrides (explicit grants & revokes)
"""

from __future__ import annotations

import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.base_repository import BaseRepository
from app.rbac.models import (
    DepartmentHierarchy,
    Permission,
    Role,
    RolePermission,
    UserPermission,
    UserRole,
)


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

    async def get_by_name(self, name: str, *, include_deleted: bool = False) -> Role | None:
        """Fetch a role by its unique name."""
        base = select(Role) if include_deleted else self._base_select()
        stmt = base.where(func.lower(Role.name) == name.lower())
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_with_permissions(self, role_id: uuid.UUID) -> Role | None:
        """Fetch a (non-deleted) role with its permission links eagerly loaded, to avoid N+1 lazy-loads."""
        stmt = (
            self._base_select()
            .where(Role.id == role_id)
            .options(selectinload(Role.permission_links).selectinload(RolePermission.permission))
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[Role]:
        """Return every non-deleted role, ordered by name."""
        stmt = self._base_select().order_by(Role.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) role already uses this department code."""
        stmt = self._base_select().with_only_columns(Role.id).where(Role.code == code)
        if exclude_id is not None:
            stmt = stmt.where(Role.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_children(self, parent_department_id: uuid.UUID) -> list[Role]:
        """Return every direct child department of a role, for the nested department tree."""
        return await self.get_children(parent_department_id)

    async def get_parents(self, role_id: uuid.UUID) -> list[Role]:
        """Return all parent departments for a given role/department."""
        stmt = (
            self._base_select()
            .join(DepartmentHierarchy, DepartmentHierarchy.parent_department_id == Role.id)
            .where(DepartmentHierarchy.child_department_id == role_id)
            .order_by(Role.name)
        )
        res = await self.session.execute(stmt)
        parents = list(res.scalars().all())
        parent_ids = {p.id for p in parents}

        # Fallback / sync from legacy Role.parent_department_id
        child_role = await self.get_by_id(role_id)
        if child_role and child_role.parent_department_id and child_role.parent_department_id not in parent_ids:
            legacy_parent = await self.get_by_id(child_role.parent_department_id)
            if legacy_parent:
                parents.append(legacy_parent)
                link = DepartmentHierarchy(
                    parent_department_id=child_role.parent_department_id,
                    child_department_id=role_id,
                )
                self.session.add(link)
                await self.session.flush()

        return parents

    async def get_children(self, role_id: uuid.UUID) -> list[Role]:
        """Return all child departments for a given role/department."""
        stmt = (
            self._base_select()
            .join(DepartmentHierarchy, DepartmentHierarchy.child_department_id == Role.id)
            .where(DepartmentHierarchy.parent_department_id == role_id)
            .order_by(Role.name)
        )
        res = await self.session.execute(stmt)
        children = list(res.scalars().all())
        child_ids = {c.id for c in children}

        # Fallback / sync from legacy Role.parent_department_id == role_id
        legacy_stmt = (
            self._base_select()
            .where(Role.parent_department_id == role_id)
            .order_by(Role.name)
        )
        legacy_res = await self.session.execute(legacy_stmt)
        for c in legacy_res.scalars().all():
            if c.id not in child_ids:
                children.append(c)
                link = DepartmentHierarchy(
                    parent_department_id=role_id,
                    child_department_id=c.id,
                )
                self.session.add(link)
                await self.session.flush()

        return children

    async def add_parent_link(self, child_id: uuid.UUID, parent_id: uuid.UUID) -> None:
        """Add a parent-child department relationship link."""
        if child_id == parent_id:
            return
        stmt = select(DepartmentHierarchy).where(
            DepartmentHierarchy.parent_department_id == parent_id,
            DepartmentHierarchy.child_department_id == child_id,
        )
        res = await self.session.execute(stmt)
        if res.scalar_one_or_none() is None:
            link = DepartmentHierarchy(parent_department_id=parent_id, child_department_id=child_id)
            self.session.add(link)
            await self.session.flush()

        # Keep Role.parent_department_id populated
        child_role = await self.get_by_id(child_id)
        if child_role and not child_role.parent_department_id:
            child_role.parent_department_id = parent_id
            await self.session.flush()

    async def remove_parent_link(self, child_id: uuid.UUID, parent_id: uuid.UUID) -> None:
        """Remove a parent-child department relationship link."""
        stmt = delete(DepartmentHierarchy).where(
            DepartmentHierarchy.parent_department_id == parent_id,
            DepartmentHierarchy.child_department_id == child_id,
        )
        await self.session.execute(stmt)
        await self.session.flush()

        # Update Role.parent_department_id if it matched the removed parent
        child_role = await self.get_by_id(child_id)
        if child_role and child_role.parent_department_id == parent_id:
            remaining = await self.get_parents(child_id)
            child_role.parent_department_id = remaining[0].id if remaining else None
            await self.session.flush()

    async def would_create_cycle(self, role_id: uuid.UUID, new_parent_id: uuid.UUID) -> bool:
        """
        Return True if setting new_parent_id as this role's parent would create a cycle.
        Traverses all ancestors of new_parent_id in the DAG.
        """
        if role_id == new_parent_id:
            return True

        queue = [new_parent_id]
        visited: set[uuid.UUID] = set()

        while queue:
            curr = queue.pop(0)
            if curr == role_id:
                return True
            if curr in visited:
                continue
            visited.add(curr)

            # Query all parents of curr from department_hierarchy
            stmt = select(DepartmentHierarchy.parent_department_id).where(
                DepartmentHierarchy.child_department_id == curr
            )
            res = await self.session.execute(stmt)
            for p_id in res.scalars().all():
                if p_id not in visited:
                    queue.append(p_id)

            # Also check Role.parent_department_id
            stmt_role = select(Role.parent_department_id).where(Role.id == curr)
            res_role = await self.session.execute(stmt_role)
            legacy_p = res_role.scalar_one_or_none()
            if legacy_p and legacy_p not in visited:
                queue.append(legacy_p)

        return False

    async def get_permission_codes_for_user(self, user_id: uuid.UUID) -> set[str]:
        """
        Resolve the full, de-duplicated set of permission codes granted to a user.

        Combines:
        1. Assigned Role Permissions (union across user's assigned roles)
        2. Individual User Permission Overrides (highest priority: explicit grants & revokes)

        If the user has the super_admin role, returns all system permissions.
        """
        # 1. Check if user has super_admin role
        #
        # ``Role.deleted_at.is_(None)`` is required here (and on stmt_roles
        # just below) now that ``Role`` supports soft-delete: without it, a
        # role that has been "deleted" through the admin API still sits in
        # the ``roles`` table with ``deleted_at`` set, and this query would
        # keep granting super_admin (or that role's other permissions) to
        # anyone still assigned to it -- i.e. deleting a role would have no
        # actual security effect until it was purged from Trash, which
        # could be up to ``settings.TRASH_RETENTION_DAYS`` (4 years) later.
        stmt_super_admin = (
            select(Role.name)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id, Role.name == "super_admin", Role.deleted_at.is_(None))
        )
        if (await self.session.execute(stmt_super_admin)).scalar_one_or_none() is not None:
            all_perms_stmt = select(Permission.code)
            res = await self.session.execute(all_perms_stmt)
            return set(res.scalars().all())

        # 2. System / Custom Role permissions
        stmt_roles = (
            select(Permission.code)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .join(UserRole, UserRole.role_id == RolePermission.role_id)
            .join(Role, Role.id == RolePermission.role_id)
            .where(UserRole.user_id == user_id, Role.deleted_at.is_(None))
            .distinct()
        )
        role_perms = set((await self.session.execute(stmt_roles)).scalars().all())

        # 3. Individual User permissions (overrides: explicit grants & revokes)
        stmt_user_perms = (
            select(Permission.code, UserPermission.is_granted)
            .join(UserPermission, UserPermission.permission_id == Permission.id)
            .where(UserPermission.user_id == user_id)
        )
        user_perm_rows = (await self.session.execute(stmt_user_perms)).all()

        user_grants = {code for code, is_granted in user_perm_rows if is_granted}
        user_denies = {code for code, is_granted in user_perm_rows if not is_granted}

        # Combine: (Role Permissions + User Grants) - User Denies
        effective = (role_perms | user_grants) - user_denies
        return effective

    async def get_effective_permissions_breakdown_for_user(self, user_id: uuid.UUID) -> dict:
        """Fetch full user metadata and permission source breakdown (Read-Only inspector)."""
        from app.users.models import User

        # Fetch User
        stmt_user = select(User).where(User.id == user_id)
        user = (await self.session.execute(stmt_user)).scalar_one_or_none()
        if not user:
            return {}

        # Fetch System / Custom Roles (excludes soft-deleted roles -- see
        # the note in get_permission_codes_for_user above for why this
        # matters, not just for display but for what "is_super_admin"
        # correctly means below).
        stmt_user_roles = (
            select(Role.name)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id, Role.deleted_at.is_(None))
        )
        system_roles = list((await self.session.execute(stmt_user_roles)).scalars().all())
        is_super_admin = "super_admin" in system_roles

        # System Role permissions mapping (code -> list of role names)
        stmt_roles_with_names = (
            select(Permission.code, Role.name)
            .join(RolePermission, RolePermission.permission_id == Permission.id)
            .join(UserRole, UserRole.role_id == RolePermission.role_id)
            .join(Role, Role.id == UserRole.role_id)
            .where(UserRole.user_id == user_id)
        )
        role_name_map: dict[str, list[str]] = {}
        for code, rname in (await self.session.execute(stmt_roles_with_names)).all():
            if code not in role_name_map:
                role_name_map[code] = []
            if rname not in role_name_map[code]:
                role_name_map[code].append(rname)

        role_perms_set = set(role_name_map.keys())

        employee_name = user.full_name or user.display_name or user.username

        # Individual User Overrides
        stmt_user_perms = (
            select(Permission.code, UserPermission.is_granted)
            .join(UserPermission, UserPermission.permission_id == Permission.id)
            .where(UserPermission.user_id == user_id)
        )
        user_perm_rows = (await self.session.execute(stmt_user_perms)).all()

        user_grants_set = {code for code, is_granted in user_perm_rows if is_granted}
        user_denies_set = {code for code, is_granted in user_perm_rows if not is_granted}

        effective_set = await self.get_permission_codes_for_user(user_id)

        # Build detailed permission sources list
        permission_sources = []
        for code in sorted(list(effective_set)):
            source = "System Role"
            override_type = "None"
            roles_granting = role_name_map.get(code, [])

            if is_super_admin:
                source = "Super Administrator"
                roles_granting = ["super_admin"]
            elif code in user_grants_set:
                source = "Individual User"
                override_type = "Granted"
            elif code in role_perms_set:
                source = "System Role"

            permission_sources.append({
                "code": code,
                "module": code.split(".")[0] if "." in code else "system",
                "source": source,
                "role_names": roles_granting,
                "override_type": override_type,
            })

        return {
            "user_info": {
                "user_id": str(user.id),
                "username": user.username,
                "employee_name": employee_name,
                "system_roles": system_roles,
                "status": user.status.value,
            },
            "is_super_admin": is_super_admin,
            "role_permissions": sorted(list(role_perms_set)),
            "user_grants": sorted(list(user_grants_set)),
            "user_denies": sorted(list(user_denies_set)),
            "effective_permissions": sorted(list(effective_set)),
            "permission_sources": permission_sources,
        }

    async def add_permission(self, role: Role, permission: Permission) -> RolePermission:
        """Grant a permission to a role, if not already granted."""
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

    async def list_for_role(self, role_id: uuid.UUID) -> list[UserRole]:
        """List every assignment for a role, with the user eagerly loaded."""
        stmt = select(UserRole).where(UserRole.role_id == role_id).options(selectinload(UserRole.user))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class UserPermissionRepository(BaseRepository[UserPermission]):
    """Repository for direct individual user permission overrides."""

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, UserPermission)

    async def list_for_user(self, user_id: uuid.UUID) -> list[UserPermission]:
        stmt = (
            select(UserPermission)
            .where(UserPermission.user_id == user_id)
            .options(selectinload(UserPermission.permission))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def add_permission(
        self, user_id: uuid.UUID, permission_id: uuid.UUID, is_granted: bool = True, granted_by: uuid.UUID | None = None
    ) -> UserPermission:
        stmt = select(UserPermission).where(
            UserPermission.user_id == user_id,
            UserPermission.permission_id == permission_id,
        )
        existing = (await self.session.execute(stmt)).scalar_one_or_none()
        if existing is not None:
            existing.is_granted = is_granted
            existing.granted_by = granted_by
            await self.session.flush()
            return existing
        link = UserPermission(
            user_id=user_id, permission_id=permission_id, is_granted=is_granted, granted_by=granted_by
        )
        self.session.add(link)
        await self.session.flush()
        return link

    async def remove_permission(self, user_id: uuid.UUID, permission_id: uuid.UUID) -> bool:
        stmt = select(UserPermission).where(
            UserPermission.user_id == user_id,
            UserPermission.permission_id == permission_id,
        )
        link = (await self.session.execute(stmt)).scalar_one_or_none()
        if link is None:
            return False
        await self.session.delete(link)
        await self.session.flush()
        return True

    async def set_user_permissions_bulk(
        self,
        user_id: uuid.UUID,
        overrides: list[tuple[uuid.UUID, bool]],
        granted_by: uuid.UUID | None = None,
    ) -> None:
        """Replace all direct permission overrides for a user with the provided list."""
        stmt_del = delete(UserPermission).where(UserPermission.user_id == user_id)
        await self.session.execute(stmt_del)
        for perm_id, is_granted in overrides:
            link = UserPermission(
                user_id=user_id,
                permission_id=perm_id,
                is_granted=is_granted,
                granted_by=granted_by,
            )
            self.session.add(link)
        await self.session.flush()