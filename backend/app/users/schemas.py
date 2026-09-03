"""Users Pydantic Schemas (request/response contracts for the user-management API)."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

from app.users.models import EmploymentStatus, EmploymentType, Gender


class UserCreate(BaseModel):
    """
    Payload for an admin creating a new person record, with login access OPTIONAL
    (Employee/User merge -- see ``User`` model docstring in ``app.users.models``).
    """

    first_name: str = Field(..., min_length=1, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    display_name: str = Field(
        ..., min_length=1, max_length=200, description="Required. Shown throughout the system in place of the username."
    )

    has_login: bool = Field(
        default=True,
        description="Whether this person gets ERP login credentials. False creates a workforce "
        "record with no login access (e.g. factory worker, driver, temporary labor, consultant) "
        "-- email/phone/password are not required in that case.",
    )

    employee_code: str | None = Field(default=None, max_length=50)
    username: str | None = Field(
        default=None,
        min_length=3,
        max_length=100,
        description="Optional. If omitted (and has_login=True), the system generates a unique username automatically.",
    )
    email: EmailStr | None = Field(default=None, description="Required if has_login=True.")
    phone: str | None = Field(
        default=None, min_length=6, max_length=30, description="Required if has_login=True. Used as a login identifier."
    )

    manager_id: uuid.UUID | None = None
    position_id: uuid.UUID | None = None

    date_of_birth: date | None = None
    gender: Gender | None = None
    date_of_joining: date | None = None
    employment_type: EmploymentType | None = EmploymentType.FULL_TIME
    employment_status: EmploymentStatus | None = EmploymentStatus.ACTIVE

    address: str | None = None
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)
    emergency_contact: str | None = Field(default=None, max_length=255)
    notes: str | None = None

    password: str | None = Field(
        default=None, min_length=1, description="Required if has_login=True. The initial password for the new account."
    )
    role_ids: list[uuid.UUID] = Field(default_factory=list)
    individual_permission_ids: list[uuid.UUID] = Field(
        default_factory=list, description="Optional direct individual permission override IDs to assign to the new user."
    )

    @model_validator(mode="after")
    def _require_login_fields_when_has_login(self) -> "UserCreate":
        """When has_login is True, email/phone/password must actually be present."""
        if self.has_login:
            missing = [
                name for name, value in (("email", self.email), ("phone", self.phone), ("password", self.password))
                if not value
            ]
            if missing:
                raise ValueError(
                    f"{', '.join(missing)} required when has_login is true (the default)."
                )
        return self


class UserRead(BaseModel):
    """A user account, as returned by admin listing/detail endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    first_name: str | None = None
    middle_name: str | None = None
    last_name: str | None = None
    display_name: str | None = None
    full_name: str | None = None

    employee_code: str | None = None
    has_login: bool = True
    username: str | None = None
    email: str | None = None
    phone: str | None = None

    manager_id: uuid.UUID | None = None
    position_id: uuid.UUID | None = None
    position_name: str | None = None

    date_of_birth: date | None = None
    gender: str | None = None
    date_of_joining: date | None = None
    employment_type: str | None = None
    employment_status: str | None = None

    address: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    postal_code: str | None = None
    emergency_contact: str | None = None
    notes: str | None = None

    status: str
    is_active: bool
    must_change_password: bool
    last_login_at: datetime | None = None
    failed_login_count: int = 0
    locked_until: datetime | None = None
    version: int = 1
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class UserWithRoles(UserRead):
    """A user account with its assigned role names expanded and manager name."""

    roles: list[str] = Field(default_factory=list)
    created_by_username: str | None = None
    employee_name: str | None = None
    manager_name: str | None = None
    position_id: uuid.UUID | None = None
    position_name: str | None = None


class UserUpdate(BaseModel):
    """Payload to update a user's non-credential profile fields."""

    version: int | None = None
    username: str | None = Field(default=None, min_length=3, max_length=100)
    first_name: str | None = Field(default=None, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    display_name: str | None = Field(default=None, max_length=200)

    employee_code: str | None = Field(default=None, max_length=50)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)

    manager_id: uuid.UUID | None = None
    position_id: uuid.UUID | None = None

    date_of_birth: date | None = None
    gender: Gender | None = None
    date_of_joining: date | None = None
    employment_type: EmploymentType | None = None
    employment_status: EmploymentStatus | None = None

    address: str | None = None
    city: str | None = Field(default=None, max_length=100)
    state: str | None = Field(default=None, max_length=100)
    country: str | None = Field(default=None, max_length=100)
    postal_code: str | None = Field(default=None, max_length=20)
    emergency_contact: str | None = Field(default=None, max_length=255)
    notes: str | None = None


class AssignRoleRequest(BaseModel):
    """
    Payload to assign a role/department for a user.

    The assignment-metadata fields are optional and default to a plain
    PRIMARY, active, no-end-date assignment -- exactly what the old
    (pre-Department-merge) single-field request did -- so existing callers
    that only ever sent ``role_id`` keep working unchanged.
    """

    role_id: uuid.UUID
    assignment_type: str = Field(
        default="PRIMARY", description="PRIMARY, SECONDARY, TEMPORARY, PROJECT, or ACTING."
    )
    is_primary: bool = False
    effective_from: date | None = None
    effective_to: date | None = None


class ResetPasswordRequest(BaseModel):
    """Payload for an admin resetting a user's password."""

    new_password: str | None = Field(
        default=None,
        description="Optional custom password to set for the user. If omitted, a temporary password is generated."
    )
    must_change_password: bool = Field(
        default=True,
        description="Whether the user must change password on next login."
    )


class ResetPasswordResponse(BaseModel):
    """
    Response for an admin-generated password reset.

    ``temporary_password`` is returned exactly once, at generation time --
    it is never retrievable again (only its Argon2 hash is persisted), so
    the admin must relay it to the user through a secure out-of-band
    channel immediately.
    """

    temporary_password: str
    message: str = "Password has been updated."