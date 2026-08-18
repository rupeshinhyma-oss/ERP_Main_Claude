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
    """Payload to grant a permission to a role."""

    permission_id: uuid.UUID


class BulkPermissionOverrideItem(BaseModel):
    """A single permission override item in a bulk update."""

    permission_id: uuid.UUID
    is_granted: bool = Field(default=True, description="True to grant, False to deny.")


class BulkUserPermissionsRequest(BaseModel):
    """Payload to replace all direct permission overrides for a user."""

    overrides: list[BulkPermissionOverrideItem] = Field(default_factory=list)


class AssignUserPermissionRequest(BaseModel):
    """Payload to grant or revoke an individual user permission."""

    permission_id: uuid.UUID
    is_granted: bool = Field(default=True, description="True to grant permission override, False to explicitly deny/revoke.")


class ClonePermissionSetRequest(BaseModel):
    """Payload to clone permission set between entities (role, user)."""

    source_type: str = Field(..., description="'role' or 'user'")
    source_id: uuid.UUID
    target_type: str = Field(..., description="'role' or 'user'")
    target_id: uuid.UUID


class EffectivePermissionsBreakdown(BaseModel):
    """Effective permissions breakdown for a user."""

    is_super_admin: bool
    role_permissions: list[str] = Field(default_factory=list)
    user_grants: list[str] = Field(default_factory=list)
    user_denies: list[str] = Field(default_factory=list)
    effective_permissions: list[str] = Field(default_factory=list)


class RoleDeletionAffectedUser(BaseModel):
    """One user who would be affected by deleting a role."""

    id: uuid.UUID
    username: str
    display_name: str


class RoleDeletionImpact(BaseModel):
    """
    Preview of what deleting a role would affect, shown to the admin before
    they confirm -- lets the UI ask "N users are on this role, reassign
    them to:" instead of silently orphaning their access.
    """

    role_id: uuid.UUID
    role_name: str
    is_system: bool
    affected_user_count: int
    affected_users: list[RoleDeletionAffectedUser] = Field(default_factory=list)


class DeleteRoleRequest(BaseModel):
    """
    Optional payload for deleting a role that still has users assigned.

    If the role has zero assigned users, this can be omitted entirely. If
    it has one or more, ``reassign_to_role_id`` is required -- the delete
    is rejected with a clear error otherwise, rather than silently
    orphaning those users' access.
    """

    reassign_to_role_id: uuid.UUID | None = Field(
        default=None,
        description="Role to move affected users to before deleting this role. Required if any users are assigned.",
    )