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

    async def list_users(self, *, offset: int, limit: int) -> tuple[list[User], int]:
        """Return a page of users and the total matching count."""
        users = await self.user_repository.list(offset=offset, limit=limit, order_by=User.created_at.desc())
        total = await self.user_repository.count()
        return users, total

    # --- Admin: Create User -------------------------------------------------------
    async def create_user(
        self,
        *,
        employee_code: str | None,
        username: str,
        email: str,
        phone: str | None,
        role_ids: list[uuid.UUID],
        created_by: uuid.UUID,
    ) -> tuple[User, str]:
        """
        Create a new user account with a generated temporary password.

        Returns ``(user, temporary_password)`` -- the plaintext temporary
        password is returned exactly once so the caller (route) can relay
        it to the admin; only its hash is ever persisted.
        """
        if await self.user_repository.username_or_email_exists(username=username, email=email):
            raise ConflictException("A user with that username or email already exists.")

        temporary_password = generate_temporary_password()
        user = await self.user_repository.create(
            employee_code=employee_code,
            username=username,
            email=email,
            phone=phone,
            password_hash=hash_password(temporary_password),
            status=UserStatus.PENDING,
            is_active=True,
            must_change_password=True,
            failed_login_count=0,
            created_by=created_by,
            updated_by=created_by,
        )

        for role_id in role_ids:
            await self.assign_role(user.id, role_id, assigned_by=created_by)

        return user, temporary_password

    async def update_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID, **fields: object) -> User:
        """Update a user's profile fields, ignoring unset (None) values."""
        user = await self.get_by_id_or_raise(user_id)
        changes = {k: v for k, v in fields.items() if v is not None}
        if changes:
            changes["updated_by"] = updated_by
            await self.user_repository.update(user, **changes)
        return user

    # --- Admin: Reset Password ------------------------------------------------------
    async def admin_reset_password(self, user_id: uuid.UUID) -> str:
        """Generate a new temporary password for a user, revoking all of their sessions."""
        user = await self.get_by_id_or_raise(user_id)
        temporary_password = generate_temporary_password()
        await self.auth_service.admin_reset_password(user, temporary_password)
        return temporary_password

    # --- Admin: Activate / Deactivate / Unlock ---------------------------------------
    async def activate_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Activate a pending or inactive user account."""
        user = await self.get_by_id_or_raise(user_id)
        await self.user_repository.update(
            user, status=UserStatus.ACTIVE, is_active=True, updated_by=updated_by
        )
        return user

    async def deactivate_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Deactivate a user account and force-logout all of their active sessions."""
        user = await self.get_by_id_or_raise(user_id)
        await self.user_repository.update(
            user, status=UserStatus.INACTIVE, is_active=False, updated_by=updated_by
        )
        await self.auth_service.force_logout_user(user.id, reason="account_deactivated")
        return user

    async def unlock_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Clear a user's failed-login lockout state."""
        user = await self.get_by_id_or_raise(user_id)
        await self.user_repository.update(
            user, failed_login_count=0, locked_until=None, updated_by=updated_by
        )
        return user

    # --- Admin: Role assignment ------------------------------------------------------
    async def assign_role(self, user_id: uuid.UUID, role_id: uuid.UUID, *, assigned_by: uuid.UUID) -> None:
        """Assign a role to a user, if not already assigned."""
        await self.get_by_id_or_raise(user_id)  # 404s cleanly if the user doesn't exist
        await self.rbac_service.get_role_or_raise(role_id)  # 404s cleanly if the role doesn't exist

        existing = await self.user_role_repository.get(user_id, role_id)
        if existing is not None:
            raise ConflictException("The user already has that role.")

        await self.user_role_repository.create(
            user_id=user_id,
            role_id=role_id,
            assigned_at=datetime.now(timezone.utc),
            assigned_by=assigned_by,
        )

    async def remove_role(self, user_id: uuid.UUID, role_id: uuid.UUID) -> None:
        """Remove a role assignment from a user."""
        link = await self.user_role_repository.get(user_id, role_id)
        if link is None:
            raise NotFoundException("The user does not have that role.")
        await self.user_role_repository.delete(link)

    # --- Admin: Sessions / Force logout -----------------------------------------------
    async def view_active_sessions(self, user_id: uuid.UUID):  # noqa: ANN201
        """List a user's currently active login sessions."""
        await self.get_by_id_or_raise(user_id)
        return await self.auth_service.list_sessions(user_id)

    async def force_logout_user(self, user_id: uuid.UUID) -> int:
        """Force-logout a user by revoking every one of their active sessions."""
        await self.get_by_id_or_raise(user_id)
        return await self.auth_service.force_logout_user(user_id, reason="admin_force_logout")
