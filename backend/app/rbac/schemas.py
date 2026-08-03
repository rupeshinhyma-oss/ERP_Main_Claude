"""RBAC Pydantic Schemas (request/response contracts for the roles & permissions API)."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class PermissionRead(BaseModel):
    """A single permission, as returned by the permission-listing endpoint."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    module: str
    description: str | None
    created_at: datetime


class RoleCreate(BaseModel):
    """Payload to create a new role."""

    name: str = Field(..., min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=255)
    permission_codes: list[str] = Field(
        default_factory=list, description="Permission codes to grant immediately, e.g. ['user.read']."
    )


class RoleUpdate(BaseModel):
    """Payload to update a role's name/description. System roles cannot be renamed."""

    name: str | None = Field(default=None, min_length=2, max_length=100)
    description: str | None = Field(default=None, max_length=255)


class RoleRead(BaseModel):
    """A role, as returned by listing/detail endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None
    is_system: bool
    created_at: datetime
    updated_at: datetime


class RoleWithPermissions(RoleRead):
    """A role with its granted permission codes expanded."""

    permissions: list[str] = Field(default_factory=list)


class GrantPermissionRequest(BaseModel):
    """Payload to grant a permission to a role."""

    permission_id: uuid.UUID
