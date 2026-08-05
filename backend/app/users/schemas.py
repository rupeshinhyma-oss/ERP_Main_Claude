"""Users Pydantic Schemas (request/response contracts for the user-management API)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field


class UserCreate(BaseModel):
    """Payload for an admin creating a new user account."""

    employee_code: str | None = Field(default=None, max_length=50)
    username: str = Field(..., min_length=3, max_length=100)
    email: EmailStr
    phone: str | None = Field(default=None, max_length=30)
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
    employee_code: str | None
    username: str
    email: str
    phone: str | None
    status: str
    is_active: bool
    must_change_password: bool
    last_login_at: datetime | None
    failed_login_count: int
    locked_until: datetime | None
    created_by: uuid.UUID | None = None
    created_at: datetime
    updated_at: datetime


class UserWithRoles(UserRead):
    """A user account with its assigned role names expanded and creator username."""

    roles: list[str] = Field(default_factory=list)
    created_by_username: str | None = None


class UserUpdate(BaseModel):
    """Payload to update a user's non-credential profile fields."""

    employee_code: str | None = Field(default=None, max_length=50)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)


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

