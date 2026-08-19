"""Auth Pydantic Schemas (request/response contracts for the authentication API)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    """Payload for ``POST /auth/login``."""

    identifier: str = Field(
        ..., description="Username, email address, or phone number.", min_length=1
    )
    password: str = Field(..., min_length=1)


class RefreshRequest(BaseModel):
    """Payload for ``POST /auth/refresh``."""

    refresh_token: str


class LogoutRequest(BaseModel):
    """Payload for ``POST /auth/logout``."""

    refresh_token: str


class ChangePasswordRequest(BaseModel):
    """Payload for ``POST /auth/change-password``."""

    current_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=1)


class ForgotPasswordRequest(BaseModel):
    """Payload for ``POST /auth/forgot-password``."""

    identifier: str = Field(
        ..., description="Username, email address, or phone number.", min_length=1
    )


class ProfileResponse(BaseModel):
    """Response payload for ``GET /auth/profile``: the caller's own profile, roles, and permissions."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    first_name: str | None = None
    last_name: str | None = None
    employee_code: str | None
    username: str
    email: str
    phone: str | None
    status: str
    is_active: bool
    must_change_password: bool
    last_login_at: datetime | None
    password_changed_at: datetime | None
    created_at: datetime
    roles: list[str] = Field(default_factory=list)
    permissions: list[str] = Field(default_factory=list)


class TokenResponse(BaseModel):
    """Response payload carrying a fresh access/refresh token pair."""

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int = Field(..., description="Access token lifetime in seconds.")
    user: ProfileResponse | None = None


class SessionRead(BaseModel):
    """A single login session, as returned by the active-sessions listing endpoint."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    device_info: str | None
    user_agent: str | None
    ip_address: str | None
    is_revoked: bool
    expires_at: datetime
    last_used_at: datetime
    created_at: datetime
