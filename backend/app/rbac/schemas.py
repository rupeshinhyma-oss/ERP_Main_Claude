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
    page: str | None = None
    action: str | None = None
    scope: str | None = "ALL"
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
    """Payload to grant a permission to a role, department, or designation."""

    permission_id: uuid.UUID


class AssignUserPermissionRequest(BaseModel):
    """Payload to grant or revoke an individual user permission."""

    permission_id: uuid.UUID
    is_granted: bool = Field(default=True, description="True to grant permission override, False to explicitly deny/revoke.")


class BulkUserPermissionOverrideItem(BaseModel):
    """Single permission override item for bulk updates."""

    permission_id: uuid.UUID
    is_granted: bool


class BulkUserPermissionsRequest(BaseModel):
    """Payload to bulk update individual user permission overrides."""

    overrides: list[BulkUserPermissionOverrideItem] = Field(default_factory=list)



class ClonePermissionSetRequest(BaseModel):
    """Payload to clone permission set between entities (role, department, designation, user)."""

    source_type: str = Field(..., description="'role', 'department', 'designation', or 'user'")
    source_id: uuid.UUID
    target_type: str = Field(..., description="'role', 'department', 'designation', or 'user'")
    target_id: uuid.UUID


class EffectivePermissionsBreakdown(BaseModel):
    """Effective permissions breakdown for a user."""

    is_super_admin: bool
    department_id: str | None = None
    designation_id: str | None = None
    role_permissions: list[str] = Field(default_factory=list)
    department_permissions: list[str] = Field(default_factory=list)
    designation_permissions: list[str] = Field(default_factory=list)
    user_grants: list[str] = Field(default_factory=list)
    user_denies: list[str] = Field(default_factory=list)
    effective_permissions: list[str] = Field(default_factory=list)
