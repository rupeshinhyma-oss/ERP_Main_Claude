"""Users Pydantic Schemas (request/response contracts for the user-management API)."""

from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.users.models import EmploymentStatus, EmploymentType, Gender


class UserCreate(BaseModel):
    """Payload for an admin creating a new user account + profile."""

    first_name: str | None = Field(default=None, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    display_name: str | None = Field(default=None, max_length=200)

    employee_code: str | None = Field(default=None, max_length=50)
    username: str = Field(..., min_length=3, max_length=100)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
    
    department_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None

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

    initial_password: str | None = Field(
        default=None,
        description="Optional custom initial password. If omitted, a temporary password is generated."
    )
    role_ids: list[uuid.UUID] = Field(default_factory=list)
    individual_permission_ids: list[uuid.UUID] = Field(
        default_factory=list, description="Optional direct individual permission override IDs to assign to the new user."
    )


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
    username: str
    email: str
    phone: str | None = None

    department_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None

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
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class UserWithRoles(UserRead):
    """A user account with its assigned role names expanded, manager name, and department/designation."""

    roles: list[str] = Field(default_factory=list)
    created_by_username: str | None = None
    employee_name: str | None = None
    department_name: str | None = None
    designation_title: str | None = None
    designation_name: str | None = None
    manager_name: str | None = None


class UserUpdate(BaseModel):
    """Payload to update a user's non-credential profile fields."""

    first_name: str | None = Field(default=None, max_length=100)
    middle_name: str | None = Field(default=None, max_length=100)
    last_name: str | None = Field(default=None, max_length=100)
    display_name: str | None = Field(default=None, max_length=200)

    employee_code: str | None = Field(default=None, max_length=50)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)

    department_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    manager_id: uuid.UUID | None = None

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
    """Payload to assign or remove a role for a user."""

    role_id: uuid.UUID


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

