"""
User Service.

Business logic for user account management: admin-driven creation,
activation/deactivation, unlocking, role assignment, and password resets.
Login/session/token concerns are delegated to :class:`app.auth.service.AuthService`
rather than duplicated here, so "what does a security event do to a
session" has exactly one implementation.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from app.auth.security import generate_temporary_password, hash_password
from app.auth.service import AuthService
from app.core.config import settings
from app.core.exceptions import ConflictException, NotFoundException
from app.rbac.repository import UserRoleRepository
from app.rbac.service import RBACService
from app.users.models import User, UserStatus
from app.users.repository import UserRepository


class UserService:
    """Orchestrates user account management on top of the user/role repositories."""

    not_found_message = "User not found."

    def __init__(
        self,
        user_repository: UserRepository,
        user_role_repository: UserRoleRepository,
        rbac_service: RBACService,
        auth_service: AuthService,
    ) -> None:
        """Bind this service to its repositories and collaborating services."""
        self.user_repository = user_repository
        self.user_role_repository = user_role_repository
        self.rbac_service = rbac_service
        self.auth_service = auth_service

    async def get_by_id_or_raise(self, user_id: uuid.UUID) -> User:
        """Fetch a user by ID or raise :class:`NotFoundException`."""
        user = await self.user_repository.get_by_id(user_id)
        if user is None:
            raise NotFoundException(self.not_found_message)
        return user

    async def list_users(
        self,
        *,
        offset: int,
        limit: int,
        query: str | None = None,
        status: str | None = None,
        department_id: uuid.UUID | None = None,
        designation_id: uuid.UUID | None = None,
    ) -> tuple[list[User], int]:
        """Return a page of users and total count with optional filters."""
        return await self.user_repository.search(
            query=query,
            status=status,
            department_id=department_id,
            designation_id=designation_id,
            offset=offset,
            limit=limit,
        )

    async def is_super_admin(self, user_id: uuid.UUID) -> bool:
        """Return True if the user has the super_admin role."""
        roles = await self.rbac_service.list_roles_for_user(user_id)
        return any(r.name == "super_admin" for r in roles)

    async def is_admin_or_super_admin(self, user_id: uuid.UUID) -> bool:
        """Return True if the user has the super_admin or admin role."""
        roles = await self.rbac_service.list_roles_for_user(user_id)
        return any(r.name in ["super_admin", "admin"] for r in roles)

    async def _ensure_not_last_super_admin(
        self, user_id: uuid.UUID, role_id_to_remove: uuid.UUID | None = None
    ) -> None:
        """Prevent deactivating or removing super_admin role from the last active Super Administrator."""
        user_roles = await self.rbac_service.list_roles_for_user(user_id)
        super_admin_role = next((r for r in user_roles if r.name == "super_admin"), None)
        if super_admin_role is None:
            return

        if role_id_to_remove is None or role_id_to_remove == super_admin_role.id:
            all_assignments = await self.user_role_repository.list_for_role(super_admin_role.id)
            active_super_admins = [link for link in all_assignments if link.user and link.user.is_active]
            if len(active_super_admins) <= 1:
                from app.core.exceptions import ForbiddenException
                raise ForbiddenException("Cannot modify or deactivate the last active Super Administrator.")

    # --- Admin: Create User -------------------------------------------------------
    async def create_user(
        self,
        *,
        username: str,
        email: str,
        created_by: uuid.UUID,
        first_name: str | None = None,
        middle_name: str | None = None,
        last_name: str | None = None,
        display_name: str | None = None,
        employee_code: str | None = None,
        phone: str | None = None,
        department_id: uuid.UUID | None = None,
        designation_id: uuid.UUID | None = None,
        manager_id: uuid.UUID | None = None,
        date_of_birth=None,
        gender=None,
        date_of_joining=None,
        employment_type=None,
        employment_status=None,
        address: str | None = None,
        city: str | None = None,
        state: str | None = None,
        country: str | None = None,
        postal_code: str | None = None,
        emergency_contact: str | None = None,
        notes: str | None = None,
        role_ids: list[uuid.UUID] | None = None,
        initial_password: str | None = None,
        individual_permission_ids: list[uuid.UUID] | None = None,
    ) -> tuple[User, str]:
        """
        Create a new user account with a manual or generated temporary password.

        Returns ``(user, password_set)`` -- the plaintext password is returned
        once so the caller can relay it to the admin; only its hash is persisted.
        """
        if await self.user_repository.username_exists(username):
            raise ConflictException("A user with that username already exists.")
        if await self.user_repository.email_exists(email):
            raise ConflictException("A user with that email already exists.")
        if employee_code and await self.user_repository.employee_code_exists(employee_code):
            raise ConflictException("An account is already linked to that employee code.")

        if initial_password and initial_password.strip():
            password_to_set = initial_password.strip()
        else:
            password_to_set = generate_temporary_password()

        user = await self.user_repository.create(
            first_name=first_name,
            middle_name=middle_name,
            last_name=last_name,
            display_name=display_name or (f"{first_name} {last_name}".strip() if (first_name or last_name) else username),
            employee_code=employee_code,
            username=username,
            email=email,
            phone=phone,
            department_id=department_id,
            designation_id=designation_id,
            manager_id=manager_id,
            date_of_birth=date_of_birth,
            gender=gender,
            date_of_joining=date_of_joining,
            employment_type=employment_type,
            employment_status=employment_status,
            address=address,
            city=city,
            state=state,
            country=country,
            postal_code=postal_code,
            emergency_contact=emergency_contact,
            notes=notes,
            password_hash=hash_password(password_to_set),
            status=UserStatus.PASSWORD_CHANGE_REQUIRED,
            is_active=True,
            must_change_password=True,
            failed_login_count=0,
            created_by=created_by,
            updated_by=created_by,
        )

        # Default to 'user' role if no role_ids supplied
        if not role_ids:
            user_role = await self.rbac_service.role_repository.get_by_name("user")
            if user_role:
                role_ids = [user_role.id]

        for role_id in (role_ids or []):
            await self.assign_role(user.id, role_id, assigned_by=created_by)

        for perm_id in (individual_permission_ids or []):
            await self.rbac_service.assign_user_permission(user.id, perm_id, is_granted=True, granted_by=created_by)

        return user, password_to_set

    async def update_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID, **fields: object) -> User:
        """Update a user's profile fields, ignoring unset (None) values."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")

        email = fields.get("email")
        if email and isinstance(email, str) and await self.user_repository.email_exists(email, exclude_user_id=user_id):
            raise ConflictException("A user with that email already exists.")

        employee_code = fields.get("employee_code")
        if employee_code and isinstance(employee_code, str) and await self.user_repository.employee_code_exists(employee_code, exclude_user_id=user_id):
            raise ConflictException("An account is already linked to that employee code.")

        updated_user = await self.user_repository.update(user, updated_by=updated_by, **fields)
        return updated_user

    # --- Admin: Reset / Set Password ------------------------------------------------
    async def admin_reset_password(
        self,
        user_id: uuid.UUID,
        custom_password: str | None = None,
        must_change_password: bool = True,
        reset_by: uuid.UUID | None = None,
    ) -> str:
        """Set a custom password or generate a new temporary password for a user, revoking active sessions."""
        user = await self.get_by_id_or_raise(user_id)
        if reset_by and await self.is_super_admin(user_id) and not await self.is_super_admin(reset_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        if custom_password and custom_password.strip():
            password_to_set = custom_password.strip()
        else:
            password_to_set = generate_temporary_password()
        await self.auth_service._set_password(user, password_to_set, require_change_on_next_login=must_change_password)
        await self.auth_service.force_logout_user(user.id, reason="password_reset")
        return password_to_set

    # --- Admin: Activate / Deactivate / Unlock ---------------------------------------
    async def activate_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Activate a user account."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        await self.user_repository.update(user, status=UserStatus.ACTIVE, is_active=True, updated_by=updated_by)
        return user

    async def deactivate_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Deactivate a user account and force-logout all active sessions."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        await self._ensure_not_last_super_admin(user_id)
        await self.user_repository.update(user, status=UserStatus.INACTIVE, is_active=False, updated_by=updated_by)
        await self.force_logout_user(user_id)
        return user

    async def suspend_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Suspend a user account and force-logout all active sessions."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        await self._ensure_not_last_super_admin(user_id)
        await self.user_repository.update(user, status=UserStatus.SUSPENDED, is_active=False, updated_by=updated_by)
        await self.force_logout_user(user_id)
        return user

    async def unlock_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Clear a user's lockout state."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        new_status = UserStatus.ACTIVE if user.status == UserStatus.LOCKED else user.status
        await self.user_repository.update(
            user, status=new_status, is_active=True, failed_login_count=0, locked_until=None, updated_by=updated_by
        )
        return user

    # --- Admin: Role assignment ------------------------------------------------------
    async def assign_role(self, user_id: uuid.UUID, role_id: uuid.UUID, *, assigned_by: uuid.UUID) -> None:
        """Assign a role to a user, replacing any existing assigned role."""
        target_user = await self.get_by_id_or_raise(user_id)  # 404s cleanly if user doesn't exist
        role = await self.rbac_service.get_role_or_raise(role_id)  # 404s cleanly if role doesn't exist

        if role.name == "super_admin" and not await self.is_super_admin(assigned_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Super Administrators can promote a user to Super Administrator.")

        if role.name == "admin" and not await self.is_admin_or_super_admin(assigned_by):
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("Only Administrators can assign Administrator roles.")

        existing_user_roles = await self.user_role_repository.list_for_user(user_id)
        if len(existing_user_roles) == 1 and existing_user_roles[0].role_id == role_id:
            return

        # Check safety before stripping super_admin role
        has_super_admin = any(
            link.role and link.role.name == "super_admin" for link in existing_user_roles
        )
        if has_super_admin and role.name != "super_admin":
            super_admin_role = next(link.role for link in existing_user_roles if link.role and link.role.name == "super_admin")
            await self._ensure_not_last_super_admin(user_id, super_admin_role.id)

        # Replace existing assigned roles with the single selected role
        for link in existing_user_roles:
            await self.user_role_repository.delete(link)

        await self.user_role_repository.create(
            user_id=user_id,
            role_id=role_id,
            assigned_at=datetime.now(timezone.utc),
            assigned_by=assigned_by,
        )
        await self.rbac_service.invalidate_user_permissions_cache(user_id)

    async def remove_role(self, user_id: uuid.UUID, role_id: uuid.UUID, *, removed_by: uuid.UUID | None = None) -> None:
        """Remove a role assignment from a user, defaulting back to 'user' role if no roles remain."""
        target_user = await self.get_by_id_or_raise(user_id)
        link = await self.user_role_repository.get(user_id, role_id)
        if link is None:
            raise NotFoundException("The user does not have that role.")
        role = await self.rbac_service.get_role_or_raise(role_id)
        if role.name == "super_admin" and target_user.username == settings.BOOTSTRAP_ADMIN_USERNAME:
            from app.core.exceptions import ForbiddenException
            raise ForbiddenException("The super_admin role cannot be removed from the primary system administrator account.")
        await self._ensure_not_last_super_admin(user_id, role_id)
        await self.user_role_repository.delete(link)

        # Default back to 'user' role if no role assignments remain
        remaining_roles = await self.user_role_repository.list_for_user(user_id)
        if not remaining_roles:
            user_role = await self.rbac_service.role_repository.get_by_name("user")
            if user_role and user_role.id != role_id:
                await self.user_role_repository.create(
                    user_id=user_id,
                    role_id=user_role.id,
                    assigned_at=datetime.now(timezone.utc),
                    assigned_by=removed_by or user_id,
                )

        await self.rbac_service.invalidate_user_permissions_cache(user_id)

    # --- Admin: Sessions / Force logout -----------------------------------------------
    async def view_active_sessions(self, user_id: uuid.UUID):  # noqa: ANN201
        """List a user's currently active login sessions."""
        await self.get_by_id_or_raise(user_id)
        return await self.auth_service.list_sessions(user_id)

    async def force_logout_user(self, user_id: uuid.UUID) -> int:
        """Force-logout a user by revoking every one of their active sessions."""
        await self.get_by_id_or_raise(user_id)
        return await self.auth_service.force_logout_user(user_id, reason="admin_force_logout")