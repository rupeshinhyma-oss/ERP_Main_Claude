"""
User Service.

Business logic for user account management: admin-driven creation,
activation/deactivation, unlocking, role assignment, and password resets.
Login/session/token concerns are delegated to :class:`app.auth.service.AuthService`
rather than duplicated here, so "what does a security event do to a
session" has exactly one implementation.
"""

from __future__ import annotations

import re
import secrets
import uuid
from datetime import datetime, timezone

from app.auth.security import generate_temporary_password, hash_password
from app.auth.service import AuthService
from app.core.config import settings
from app.core.exceptions import BadRequestException, ConflictException, ForbiddenException, NotFoundException
from app.rbac.repository import UserRoleRepository
from app.rbac.service import RBACService
from app.users.models import User, UserStatus
from app.users.repository import UserRepository

# The one and only role name that grants full administrator access. Reserved
# exclusively for the hardcoded bootstrap admin account (see scripts/seed.py);
# no one else may ever be assigned this role, regardless of who is asking.
SUPER_ADMIN_ROLE_NAME = "super_admin"

# The role every newly-created account gets by default when the caller
# doesn't specify any role_ids explicitly.
DEFAULT_USER_ROLE_NAME = "user"


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

    @staticmethod
    def _username_base_from(email: str, phone: str) -> str:
        """Derive a readable username stem from the email's local part, falling back to phone."""
        local_part = email.split("@", 1)[0] if "@" in email else ""
        stem = re.sub(r"[^a-zA-Z0-9._-]", "", local_part).strip(".-_")
        if len(stem) >= 3:
            return stem.lower()
        digits_only = re.sub(r"\D", "", phone)
        return f"user{digits_only[-6:]}" if digits_only else "user"

    async def _generate_unique_username(self, *, email: str, phone: str) -> str:
        """
        Generate a unique, system-assigned username.

        Used when an admin creates a user without specifying a username.
        Tries a clean stem derived from the email first (e.g. ``john.doe``);
        if that's taken, appends a short random numeric suffix and retries
        a bounded number of times before falling back to a fully random tag.
        """
        base = self._username_base_from(email, phone)[:90]
        if not await self.user_repository.username_exists(base):
            return base

        for _ in range(20):
            candidate = f"{base}{secrets.randbelow(90000) + 10000}"[:100]
            if not await self.user_repository.username_exists(candidate):
                return candidate

        # Extremely unlikely fallback: fully random suffix, effectively collision-free.
        return f"{base[:80]}{secrets.token_hex(8)}"[:100]

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
    ) -> tuple[list[User], int]:
        """Return a page of users and total count with optional filters."""
        return await self.user_repository.search(
            query=query,
            status=status,
            offset=offset,
            limit=limit,
        )

    async def is_super_admin(self, user_id: uuid.UUID) -> bool:
        """Return True if the user has the super_admin role."""
        roles = await self.rbac_service.list_roles_for_user(user_id)
        return any(r.name == SUPER_ADMIN_ROLE_NAME for r in roles)

    @staticmethod
    def _is_bootstrap_admin_username(username: str | None) -> bool:
        """
        Return True if ``username`` matches the single hardcoded bootstrap
        admin account (``settings.BOOTSTRAP_ADMIN_USERNAME``).

        This is the only account ever allowed to hold the super_admin
        ("Admin") role -- see ``assign_role`` below.
        """
        if not username:
            return False
        return username.strip().lower() == settings.BOOTSTRAP_ADMIN_USERNAME.strip().lower()

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
                raise ForbiddenException("Cannot modify or deactivate the last active Super Administrator.")

    # --- Admin: Create User -------------------------------------------------------
    async def create_user(
        self,
        *,
        first_name: str,
        display_name: str,
        created_by: uuid.UUID,
        has_login: bool = True,
        email: str | None = None,
        phone: str | None = None,
        password: str | None = None,
        last_name: str | None = None,
        username: str | None = None,
        middle_name: str | None = None,
        employee_code: str | None = None,
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
        individual_permission_ids: list[uuid.UUID] | None = None,
        position_id: uuid.UUID | None = None,
    ) -> tuple[User, str | None]:
        """
        Create a new person record, with login credentials OPTIONAL (Employee/User merge:
        ``has_login=False`` records a workforce member with no ERP access -- factory
        worker, driver, temporary labor, consultant -- as a single person record rather
        than a separate Employee entity; see ``User`` model docstring for the full
        rationale).

        ``first_name`` and ``display_name`` are always required. When
        ``has_login=True`` (the default), ``email``, ``phone``, and
        ``password`` are also required, exactly as before this merge --
        this method's default behavior for a normal login-having user is
        unchanged. When ``has_login=False``, none of those three are
        required (and are ignored/stored as NULL even if passed).

        ``last_name`` and ``username`` are optional: if the admin doesn't
        supply a username (and ``has_login`` is True), the system generates
        a unique username automatically (derived from the email, falling
        back to the phone number). Any of username / email / phone can
        later be used to log in. ``display_name`` is what's shown
        throughout the rest of the system (task lists, dropdowns, audit
        views) in place of the raw username.

        Returns ``(user, password_set)`` -- the plaintext password is
        returned once so the caller can relay it to the admin (``None`` for
        a ``has_login=False`` record, since there is no password to relay);
        only its hash is persisted.
        """
        if not first_name or not first_name.strip():
            raise ConflictException("First name is required.")
        if not display_name or not display_name.strip():
            raise ConflictException("Display name is required.")

        if employee_code and await self.user_repository.employee_code_exists(employee_code):
            raise ConflictException("An account is already linked to that employee code.")

        if not has_login:
            # A workforce member with no ERP access: credentials are
            # deliberately left NULL, not defaulted to something synthetic
            # -- there is no login to secure, so there is nothing to hash.
            user = await self.user_repository.create(
                first_name=first_name.strip(),
                middle_name=middle_name,
                last_name=last_name.strip() if last_name and last_name.strip() else None,
                display_name=display_name.strip(),
                employee_code=employee_code,
                has_login=False,
                username=None,
                email=None,
                phone=None,
                password_hash=None,
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
                status=UserStatus.INACTIVE,  # no login is possible regardless, but keep status honest
                is_active=True,
                must_change_password=False,
                failed_login_count=0,
                created_by=created_by,
                updated_by=created_by,
            )
            resolved_role_ids = list(role_ids or [])
            if not resolved_role_ids:
                default_role = await self.rbac_service.role_repository.get_by_name(DEFAULT_USER_ROLE_NAME)
                if default_role is not None:
                    resolved_role_ids = [default_role.id]

            for role_id in resolved_role_ids:
                try:
                    await self.assign_role(user.id, role_id, assigned_by=created_by)
                except ConflictException:
                    pass
            for permission_id in individual_permission_ids or []:
                await self.rbac_service.assign_user_permission(
                    user.id, permission_id, is_granted=True, granted_by=created_by
                )
            if position_id:
                from app.org_structure.assignments_repository import EmployeePositionAssignmentRepository
                from app.org_structure.models import OrgRecordStatus, PositionAssignmentType
                assignment_repo = EmployeePositionAssignmentRepository(self.user_repository.session)
                await assignment_repo.create(
                    employee_id=user.id,
                    position_id=position_id,
                    assignment_type=PositionAssignmentType.PRIMARY,
                    is_primary=True,
                    status=OrgRecordStatus.ACTIVE,
                )
            return user, None

        if not email:
            raise ConflictException("Email is required for a user with login access.")
        if not phone:
            raise ConflictException("Phone number is required for a user with login access.")
        if not password or not password.strip():
            raise ConflictException("A password is required for a user with login access.")

        if username and await self.user_repository.username_exists(username):
            raise ConflictException("A user with that username already exists.")
        if await self.user_repository.email_exists(email):
            raise ConflictException("A user with that email already exists.")
        if await self.user_repository.phone_exists(phone):
            raise ConflictException("A user with that phone number already exists.")

        password_to_set = password.strip()

        resolved_username = username.strip() if username and username.strip() else (
            await self._generate_unique_username(email=email, phone=phone)
        )

        user = await self.user_repository.create(
            first_name=first_name.strip(),
            middle_name=middle_name,
            last_name=last_name.strip() if last_name and last_name.strip() else None,
            display_name=display_name.strip(),
            employee_code=employee_code,
            has_login=True,
            username=resolved_username,
            email=email,
            phone=phone,
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

        resolved_role_ids = list(role_ids or [])

        if not resolved_role_ids:
            # No role explicitly requested: fall back to the default "user"
            # role so every new account can actually log in and see
            # something, rather than landing with zero permissions.
            default_role = await self.rbac_service.role_repository.get_by_name(DEFAULT_USER_ROLE_NAME)
            if default_role is not None:
                resolved_role_ids = [default_role.id]

        for role_id in resolved_role_ids:
            try:
                await self.assign_role(user.id, role_id, assigned_by=created_by)
            except ConflictException:
                # Role already assigned (e.g. duplicate id in the payload,
                # or the default role happened to also be requested
                # explicitly) -- not a real error, just a no-op.
                pass

        for perm_id in (individual_permission_ids or []):
            await self.rbac_service.assign_user_permission(user.id, perm_id, is_granted=True, granted_by=created_by)

        if position_id:
            from app.org_structure.assignments_repository import EmployeePositionAssignmentRepository
            from app.org_structure.models import OrgRecordStatus, PositionAssignmentType
            assignment_repo = EmployeePositionAssignmentRepository(self.user_repository.session)
            await assignment_repo.create(
                employee_id=user.id,
                position_id=position_id,
                assignment_type=PositionAssignmentType.PRIMARY,
                is_primary=True,
                status=OrgRecordStatus.ACTIVE,
            )

        return user, password_to_set

    async def update_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID, **fields: object) -> User:
        """Update a user's profile fields."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")

        username = fields.get("username")
        if username and isinstance(username, str) and await self.user_repository.username_exists(username, exclude_user_id=user_id):
            raise ConflictException("A user with that username already exists.")

        email = fields.get("email")
        if email and isinstance(email, str) and await self.user_repository.email_exists(email, exclude_user_id=user_id):
            raise ConflictException("A user with that email already exists.")

        phone = fields.get("phone")
        if phone and isinstance(phone, str) and await self.user_repository.phone_exists(phone, exclude_user_id=user_id):
            raise ConflictException("A user with that phone number already exists.")

        employee_code = fields.get("employee_code")
        if employee_code and isinstance(employee_code, str) and await self.user_repository.employee_code_exists(employee_code, exclude_user_id=user_id):
            raise ConflictException("An account is already linked to that employee code.")

        changes = dict(fields)
        if changes:
            changes["updated_by"] = updated_by
            await self.user_repository.update(user, **changes)
        return user

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
        """Activate a pending or inactive user account."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        await self.user_repository.update(
            user, status=UserStatus.ACTIVE, is_active=True, updated_by=updated_by
        )
        return user

    async def deactivate_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Deactivate a user account and force-logout all of their active sessions."""
        user = await self.get_by_id_or_raise(user_id)
        if self._is_bootstrap_admin_username(user.username):
            raise ForbiddenException("The system bootstrap administrator account cannot be deactivated.")
        if user.id == updated_by:
            raise ForbiddenException("You cannot deactivate your own account.")
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        await self._ensure_not_last_super_admin(user_id)
        await self.user_repository.update(
            user, status=UserStatus.INACTIVE, is_active=False, updated_by=updated_by
        )
        await self.auth_service.force_logout_user(user.id, reason="account_deactivated")
        return user

    async def suspend_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Suspend a user account and force-logout all of their active sessions."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        await self._ensure_not_last_super_admin(user_id)
        await self.user_repository.update(
            user, status=UserStatus.SUSPENDED, is_active=False, updated_by=updated_by
        )
        await self.auth_service.force_logout_user(user.id, reason="account_suspended")
        return user

    async def unlock_user(self, user_id: uuid.UUID, *, updated_by: uuid.UUID) -> User:
        """Clear a user's failed-login lockout state."""
        user = await self.get_by_id_or_raise(user_id)
        if await self.is_super_admin(user_id) and not await self.is_super_admin(updated_by):
            raise ForbiddenException("Only Super Administrators can modify Super Administrator accounts.")
        new_status = UserStatus.ACTIVE if user.status == UserStatus.LOCKED else user.status
        await self.user_repository.update(
            user, status=new_status, is_active=True, failed_login_count=0, locked_until=None, updated_by=updated_by
        )
        return user

    # --- Admin: Role assignment ------------------------------------------------------
    async def assign_role(
        self,
        user_id: uuid.UUID,
        role_id: uuid.UUID,
        *,
        assigned_by: uuid.UUID,
        assignment_type: str = "PRIMARY",
        is_primary: bool = False,
        effective_from=None,
        effective_to=None,
    ) -> None:
        """
        Assign a role to a user, ADDING it to whatever roles the user already holds.

        A user may hold any number of roles simultaneously (e.g. "Sales
        Manager" + "Task Approver" + "Marketing Viewer" all at once) --
        effective permissions are the union of every held role's grants,
        adjusted by individual overrides (see
        ``RBACRepository.get_permission_codes_for_user``). This method used
        to replace any existing role so a user could only ever hold one at
        a time; that restriction has been removed so multi-role assignment
        actually works end-to-end, not just at the (always multi-role-
        capable) ``user_roles`` table level.

        ``assignment_type``/``is_primary``/``effective_from``/``effective_to``
        are the organizational-department assignment fields carried over
        from the Department/Role merge (see ``UserRole`` docstring in
        ``app.rbac.models``) -- default to a plain, always-active PRIMARY
        assignment so existing callers that don't pass them keep working
        exactly as before.
        """
        user = await self.get_by_id_or_raise(user_id)  # 404s cleanly if the user doesn't exist
        role = await self.rbac_service.get_role_or_raise(role_id)  # 404s cleanly if the role doesn't exist

        if role.name == SUPER_ADMIN_ROLE_NAME:
            # The Admin (super_admin) role is reserved exclusively for the
            # single hardcoded bootstrap admin account -- not even another
            # existing Super Administrator may hand it to a different user.
            if not self._is_bootstrap_admin_username(user.username):
                raise ForbiddenException(
                    "The Admin role can only ever be held by the system's bootstrap "
                    "admin account and cannot be assigned to any other user."
                )

        existing_links = await self.user_role_repository.list_for_user(user_id)
        if any(link.role_id == role_id for link in existing_links):
            raise ConflictException("The user already has that role.")

        await self.user_role_repository.create(
            user_id=user_id,
            role_id=role_id,
            assigned_at=datetime.now(timezone.utc),
            assigned_by=assigned_by,
            assignment_type=assignment_type,
            is_primary=is_primary,
            effective_from=effective_from,
            effective_to=effective_to,
        )
        await self.rbac_service.invalidate_user_permissions_cache(user_id)

    async def remove_role(self, user_id: uuid.UUID, role_id: uuid.UUID, *, removed_by: uuid.UUID | None = None) -> None:
        """
        Remove a single role assignment from a user.

        A user may hold several roles at once; removing one just drops that
        one grant. Only if this removal empties the user's role set entirely
        does the system fall back to assigning the default 'user' role, so
        no account is ever left with zero roles (and therefore zero
        permissions / unable to do anything, including being re-granted a
        role by another admin who can no longer find them via any
        role-scoped view).
        """
        link = await self.user_role_repository.get(user_id, role_id)
        if link is None:
            raise NotFoundException("The user does not have that role.")
        role = await self.rbac_service.get_role_or_raise(role_id)
        if role.name == SUPER_ADMIN_ROLE_NAME and removed_by and not await self.is_super_admin(removed_by):
            raise ForbiddenException("Only Super Administrators can remove Super Administrator rights.")
        await self._ensure_not_last_super_admin(user_id, role_id)
        await self.user_role_repository.delete(link)

        # Fall back to default user role if no other role remains
        remaining_links = await self.user_role_repository.list_for_user(user_id)
        if not remaining_links:
            default_role = await self.rbac_service.role_repository.get_by_name(DEFAULT_USER_ROLE_NAME)
            if default_role and default_role.id != role_id:
                await self.user_role_repository.create(
                    user_id=user_id,
                    role_id=default_role.id,
                    assigned_at=datetime.now(timezone.utc),
                    assigned_by=removed_by,
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

    # --- Admin: Delete User (Disabled) ------------------------------------------------
    async def delete_user(self, user_id: uuid.UUID, *, deleted_by: uuid.UUID) -> None:
        """User deletion has been permanently disabled across the ERP system."""
        raise BadRequestException(
            "User deletion is permanently disabled. User accounts cannot be deleted to preserve audit and transaction history. Please deactivate the user instead."
        )