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
    role_ids: list[uuid.UUID] = Field(default_factory=list)


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
    created_at: datetime
    updated_at: datetime


class UserWithRoles(UserRead):
    """A user account with its assigned role names expanded."""

    roles: list[str] = Field(default_factory=list)


class UserUpdate(BaseModel):
    """Payload to update a user's non-credential profile fields."""

    employee_code: str | None = Field(default=None, max_length=50)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=30)


class AssignRoleRequest(BaseModel):
    """Payload to assign or remove a role for a user."""

    role_id: uuid.UUID


class ResetPasswordResponse(BaseModel):
    """
    Response for an admin-generated password reset.

    ``temporary_password`` is returned exactly once, at generation time --
    it is never retrievable again (only its Argon2 hash is persisted), so
    the admin must relay it to the user through a secure out-of-band
    channel immediately.
    """

    temporary_password: str
    message: str = "Password has been reset. The user must change it on next login."
