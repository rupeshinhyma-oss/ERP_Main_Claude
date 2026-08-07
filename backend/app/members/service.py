"""
Team Member Service.

Orchestrates the Teams page's "Add Member" flow by composing three
EXISTING services -- app.users.service.UserService,
app.employees.service.EmployeeService, and app.rbac.service.RBACService --
rather than reimplementing any of their internals (employee-code
generation, uniqueness checks, etc. all stay owned by their original
modules, which are not modified).

DELIBERATE SECURITY DEVIATION (explicit product requirement): the admin
sets the member's password directly (rather than a system-generated
temporary one) and can view/reset it later in plain text via the Teams
page. This requires storing a REVERSIBLE encrypted copy of the password
(app.members.crypto / app.members.models.MemberPasswordVault) in addition
to the normal one-way Argon2 hash that actually authenticates logins --
see app/members/crypto.py's module docstring for the full rationale and
caveats. The one-way hash remains the sole source of truth for login
itself; the vault is consulted ONLY for the admin reveal/reset UI, never
during authentication.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, datetime, timezone

from app.auth.security import hash_password
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.departments.repository import DepartmentRepository
from app.designations.repository import DesignationRepository
from app.employees.models import EmploymentType
from app.employees.service import EmployeeService
from app.members.crypto import decrypt_password, encrypt_password
from app.members.repository import MemberPasswordVaultRepository
from app.rbac.service import RBACService
from app.users.models import UserStatus
from app.users.service import UserService

DEFAULT_MEMBER_ROLE_NAME = "employee"

_USERNAME_SANITIZE_RE = re.compile(r"[^a-z0-9._-]+")


def _derive_username_base(email: str) -> str:
    """Derive a username base from the local part of an email address (before the @)."""
    local_part = email.split("@", 1)[0].lower()
    sanitized = _USERNAME_SANITIZE_RE.sub("", local_part) or "member"
    return sanitized[:90]  # leave room for a numeric disambiguation suffix under the 100-char cap


def _split_full_name(full_name: str) -> tuple[str, str]:
    """Split a single 'full name' input into (first_name, last_name) for the Employee model."""
    parts = full_name.strip().split(None, 1)
    if len(parts) == 1:
        return parts[0], parts[0]  # single-word name: reuse it for both, rather than leaving last_name blank
    return parts[0], parts[1]


class TeamMemberService:
    """
    Orchestrates User + Employee + Role + password-vault management for the
    Teams 'Add Member' flow and its admin password reveal/reset feature.
    """

    def __init__(
        self,
        user_service: UserService,
        employee_service: EmployeeService,
        rbac_service: RBACService,
        department_repository: DepartmentRepository,
        designation_repository: DesignationRepository,
        password_vault_repository: MemberPasswordVaultRepository,
    ) -> None:
        """Bind this service to the existing services/repositories it composes."""
        self.user_service = user_service
        self.employee_service = employee_service
        self.rbac_service = rbac_service
        self.department_repository = department_repository
        self.designation_repository = designation_repository
        self.password_vault_repository = password_vault_repository

    async def _generate_unique_username(self, email: str) -> str:
        """Derive a username from the email's local part, disambiguating with a numeric suffix on collision."""
        base = _derive_username_base(email)
        candidate = base
        suffix = 1
        while await self.user_service.user_repository.get_by_username(candidate) is not None:
            suffix += 1
            candidate = f"{base}{suffix}"
        return candidate

    async def create_member(
        self,
        *,
        full_name: str,
        email: str,
        password: str,
        department_id: uuid.UUID | None,
        designation_id: uuid.UUID | None,
        created_by: uuid.UUID,
    ) -> dict:
        """
        Create a new team member: a User (login, with the ADMIN-SUPPLIED
        password) + Employee (HR profile), linked, with the default
        'employee' role assigned. The password is also stored
        reversible-encrypted in the vault so the admin can view/reset it
        later (see module docstring).

        Raises :class:`ConflictException` if the email is already in use,
        and :class:`BadRequestException` if a given department/designation
        ID doesn't exist, or if the default 'employee' role hasn't been
        seeded yet. Password strength is validated at the schema layer
        (app.members.schemas.TeamMemberCreate), before this is ever called.
        """
        if department_id is not None and await self.department_repository.get_by_id(department_id) is None:
            raise BadRequestException("The specified department does not exist.")
        if designation_id is not None and await self.designation_repository.get_by_id(designation_id) is None:
            raise BadRequestException("The specified designation does not exist.")

        default_role = await self.rbac_service.role_repository.get_by_name(DEFAULT_MEMBER_ROLE_NAME)
        if default_role is None:
            raise BadRequestException(
                f"The default {DEFAULT_MEMBER_ROLE_NAME!r} role has not been seeded. "
                "Run the bootstrap seed script before adding team members."
            )

        if await self.user_service.user_repository.username_or_email_exists(username="", email=email):
            raise ConflictException(f"A user with email {email!r} already exists.")

        username = await self._generate_unique_username(email)

        # Deliberately NOT using UserService.create_user() here: that
        # method always GENERATES a temporary password server-side, which
        # is the opposite of this feature's explicit requirement (the
        # admin sets the password directly). Everything else it would
        # have done (role assignment) is still done via the existing
        # UserService.assign_role() below, so this only diverges from the
        # existing flow at the one point it must.
        user = await self.user_service.user_repository.create(
            employee_code=None,
            username=username,
            email=email,
            phone=None,
            password_hash=hash_password(password),
            status=UserStatus.PENDING,
            is_active=True,
            must_change_password=False,  # the admin set this password deliberately; don't force an immediate change
            failed_login_count=0,
            created_by=created_by,
            updated_by=created_by,
        )
        await self.user_service.assign_role(user.id, default_role.id, assigned_by=created_by)
        await self.password_vault_repository.upsert(user.id, encrypt_password(password))

        first_name, last_name = _split_full_name(full_name)
        try:
            employee = await self.employee_service.create(
                created_by=created_by,
                first_name=first_name,
                last_name=last_name,
                display_name=full_name.strip(),
                email=email,
                phone=None,
                date_of_birth=None,
                gender=None,
                date_of_joining=date.today(),
                department_id=department_id,
                designation_id=designation_id,
                manager_id=None,
                employment_type=EmploymentType.FULL_TIME,
                profile_picture_url=None,
                address=None,
                city=None,
                state=None,
                country=None,
                postal_code=None,
                notes=None,
                user_id=user.id,
            )
        except ConflictException:
            # The User account (and its vault entry) was already created
            # and committed at this point (a genuinely separate, real
            # account); re-raise with a clearer message rather than
            # silently leaving an orphaned user with no employee profile.
            raise ConflictException(
                f"User {username!r} was created, but an employee profile with email {email!r} "
                "already exists. Please check for a duplicate employee record."
            )

        return {
            "user_id": user.id,
            "employee_id": employee.id,
            "employee_code": employee.employee_code,
            "full_name": full_name.strip(),
            "username": username,
            "email": email,
            "department_id": department_id,
            "designation_id": designation_id,
            "role": DEFAULT_MEMBER_ROLE_NAME,
            "must_change_password": False,
            "created_at": user.created_at,
        }

    async def reveal_password(self, user_id: uuid.UUID) -> str:
        """
        Decrypt and return a member's currently-stored password, for the
        Teams page's "eye icon" reveal.

        Raises :class:`NotFoundException` if no vault entry exists for
        this user (e.g. a user created before this feature existed, or
        one created through the ordinary Users admin API rather than the
        Teams "Add Member" flow, which never has a vault entry).
        """
        vault_entry = await self.password_vault_repository.get_by_user_id(user_id)
        if vault_entry is None:
            raise NotFoundException(
                "No stored password is available for this user. It may have been created "
                "outside the Teams 'Add Member' flow, or reset before this feature existed."
            )
        return decrypt_password(vault_entry.encrypted_password)

    async def reset_password(self, user_id: uuid.UUID, new_password: str, *, updated_by: uuid.UUID) -> None:
        """
        Admin-driven password reset: set a member's password to a new
        admin-chosen value, updating both the real login hash and the
        reversible vault copy together so they never drift out of sync.
        """
        user = await self.user_service.user_repository.get_by_id(user_id)
        if user is None:
            raise NotFoundException("User not found.")

        await self.user_service.user_repository.update(
            user,
            password_hash=hash_password(new_password),
            must_change_password=False,
            password_changed_at=datetime.now(timezone.utc),
            updated_by=updated_by,
        )
        await self.password_vault_repository.upsert(user_id, encrypt_password(new_password))