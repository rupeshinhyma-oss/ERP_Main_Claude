"""
RBAC Repositories.

Query-specific extensions for ``roles``, ``permissions``, ``user_permissions``,
and the permission calculation resolving effective permissions across:
1. Assigned System / Custom Roles
2. Individual User Permission Overrides (explicit grants & revokes)
"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.common.base_repository import BaseRepository
from app.rbac.models import (
    DepartmentPermission,
    DesignationPermission,
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

        Combines:
        1. Assigned Role Permissions (union across user's assigned roles)
        2. Individual User Permission Overrides (highest priority: explicit grants & revokes)

        If the user has the super_admin role, returns all system permissions.
        """
        # 1. Check if user has super_admin or admin role (both have full system access)
        stmt_super_admin = (
            select(Role.name)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id, Role.name.in_(["super_admin", "admin"]))
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
            .where(UserRole.user_id == user_id)
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
        from app.departments.models import Department
        from app.designations.models import Designation

        # Fetch User
        stmt_user = select(User).where(User.id == user_id)
        user = (await self.session.execute(stmt_user)).scalar_one_or_none()
        if not user:
            return {}

        # Fetch System / Custom Roles
        stmt_user_roles = (
            select(Role.name)
            .join(UserRole, UserRole.role_id == Role.id)
            .where(UserRole.user_id == user_id)
        )
        system_roles = list((await self.session.execute(stmt_user_roles)).scalars().all())
        is_super_admin = any(r in ["super_admin", "admin"] for r in system_roles)

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

        # User details (Department + Designation for display only)
        employee_name = user.full_name or user.display_name or user.username
        department_name = "N/A"
        designation_name = "N/A"

        if user.department_id:
            stmt_dept_obj = select(Department).where(Department.id == user.department_id)
            dept_obj = (await self.session.execute(stmt_dept_obj)).scalar_one_or_none()
            if dept_obj:
                department_name = dept_obj.name

        if user.designation_id:
            stmt_desig_obj = select(Designation).where(Designation.id == user.designation_id)
            desig_obj = (await self.session.execute(stmt_desig_obj)).scalar_one_or_none()
            if desig_obj:
                designation_name = desig_obj.title or desig_obj.name

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
                "department": department_name,
                "designation": designation_name,
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
        stmt = select(UserRole).where(Role.id == role_id).join(UserRole, UserRole.role_id == Role.id).options(selectinload(UserRole.user))
        result = await self.session.execute(stmt)
        return list(result.scalars().all())


class DepartmentPermissionRepository(BaseRepository[DepartmentPermission]):
    """Repository for department permission rows."""

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, DepartmentPermission)

    async def list_for_department(self, department_id: uuid.UUID) -> list[DepartmentPermission]:
        stmt = (
            select(DepartmentPermission)
            .where(DepartmentPermission.department_id == department_id)
            .options(selectinload(DepartmentPermission.permission))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def add_permission(
        self, department_id: uuid.UUID, permission_id: uuid.UUID, granted_by: uuid.UUID | None = None
    ) -> DepartmentPermission:
        stmt = select(DepartmentPermission).where(
            DepartmentPermission.department_id == department_id,
            DepartmentPermission.permission_id == permission_id,
        )
        existing = (await self.session.execute(stmt)).scalar_one_or_none()
        if existing is not None:
            return existing
        link = DepartmentPermission(department_id=department_id, permission_id=permission_id, granted_by=granted_by)
        self.session.add(link)
        await self.session.flush()
        return link

    async def remove_permission(self, department_id: uuid.UUID, permission_id: uuid.UUID) -> bool:
        stmt = select(DepartmentPermission).where(
            DepartmentPermission.department_id == department_id,
            DepartmentPermission.permission_id == permission_id,
        )
        link = (await self.session.execute(stmt)).scalar_one_or_none()
        if link is None:
            return False
        await self.session.delete(link)
        await self.session.flush()
        return True


class DesignationPermissionRepository(BaseRepository[DesignationPermission]):
    """Repository for designation permission rows."""

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, DesignationPermission)

    async def list_for_designation(self, designation_id: uuid.UUID) -> list[DesignationPermission]:
        stmt = (
            select(DesignationPermission)
            .where(DesignationPermission.designation_id == designation_id)
            .options(selectinload(DesignationPermission.permission))
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def add_permission(
        self, designation_id: uuid.UUID, permission_id: uuid.UUID, granted_by: uuid.UUID | None = None
    ) -> DesignationPermission:
        stmt = select(DesignationPermission).where(
            DesignationPermission.designation_id == designation_id,
            DesignationPermission.permission_id == permission_id,
        )
        existing = (await self.session.execute(stmt)).scalar_one_or_none()
        if existing is not None:
            return existing
        link = DesignationPermission(designation_id=designation_id, permission_id=permission_id, granted_by=granted_by)
        self.session.add(link)
        await self.session.flush()
        return link

    async def remove_permission(self, designation_id: uuid.UUID, permission_id: uuid.UUID) -> bool:
        stmt = select(DesignationPermission).where(
            DesignationPermission.designation_id == designation_id,
            DesignationPermission.permission_id == permission_id,
        )
        link = (await self.session.execute(stmt)).scalar_one_or_none()
        if link is None:
            return False
        await self.session.delete(link)
        await self.session.flush()
        return True


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