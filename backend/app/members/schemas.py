"""
Team Member Schemas.

The "Add Member" flow (Teams page) creates a login-capable
:class:`~app.users.models.User` account and links it to a new
:class:`~app.employees.models.Employee` HR profile in one atomic
operation -- neither existing module's create endpoint does both, by
design (User = credentials, Employee = HR profile, deliberately separate
concerns). This module composes them for that one specific UI flow
without modifying either existing module.

DELIBERATE SECURITY DEVIATION (explicit product requirement): unlike
every other credential in this system, the admin sets this password
directly and can view/reset it later in plain text via the Teams page's
"eye icon". This requires a REVERSIBLE encrypted copy of the password to
be stored (see app.members.crypto / app.members.models.MemberPasswordVault),
in addition to the normal one-way Argon2 hash that actually authenticates
logins. See app/members/crypto.py's module docstring for the full
security rationale and caveats.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.auth.security import validate_password_strength


def _validate_password_field(cls, value: str) -> str:
    """Shared field_validator body: enforce the existing password policy on an admin-supplied password."""
    violations = validate_password_strength(value)
    if violations:
        raise ValueError(" ".join(violations))
    return value


class TeamMemberCreate(BaseModel):
    """
    Payload for the Teams page's "Add Member" form.

    Name, Email, and Password are required; Department and Designation
    are optional. The password is set directly by the admin (not
    generated), validated against the same password policy as every
    other account in the system.
    """

    full_name: str = Field(..., min_length=1, max_length=200, description="Split into first/last name internally.")
    email: EmailStr
    password: str = Field(..., min_length=1, max_length=255)
    department_id: uuid.UUID | None = None
    designation_id: uuid.UUID | None = None
    role_id: uuid.UUID | None = None
    role_name: str | None = None

    _validate_password = field_validator("password")(_validate_password_field)


class TeamMemberRead(BaseModel):
    """
    The created/updated member, as returned by create/detail endpoints.

    Does NOT include the password itself -- that's only ever returned by
    the dedicated reveal endpoint (``GET /members/{user_id}/password``),
    gated by its own permission check, so a member's password is never
    incidentally included in a general list/detail response.
    """

    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    employee_id: uuid.UUID
    employee_code: str | None = None
    full_name: str
    username: str
    email: str
    department_id: uuid.UUID | None
    designation_id: uuid.UUID | None
    role: str
    must_change_password: bool
    created_at: datetime


class MemberPasswordReveal(BaseModel):
    """Response for the admin 'eye icon' reveal -- the plaintext password, decrypted on demand."""

    user_id: uuid.UUID
    password: str


class MemberPasswordReset(BaseModel):
    """Payload for an admin resetting a member's password to a new admin-chosen value."""

    password: str = Field(..., min_length=1, max_length=255)

    _validate_password = field_validator("password")(_validate_password_field)