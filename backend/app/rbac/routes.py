"""
RBAC Management Routes.

Implements the admin-facing role & permission management API: list
permissions, and create/list/get/update/delete roles plus grant/revoke
permission assignments on a role. Every route is gated by the
``settings.manage`` permission, since managing roles and permissions is
itself a highly privileged action.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.rbac.dependencies import get_rbac_service, require_permission
from app.rbac.schemas import (
    GrantPermissionRequest,
    PermissionRead,
    RoleCreate,
    RoleRead,
    RoleUpdate,
    RoleWithPermissions,
)
from app.rbac.service import RBACService

router = APIRouter(prefix="/rbac", tags=["Roles & Permissions"])


async def _role_with_permissions(role, rbac_service: RBACService) -> RoleWithPermissions:  # type: ignore[no-untyped-def]
    """Shape a ``Role`` ORM instance into the response schema, with permission codes expanded."""
    codes = await rbac_service.get_permission_codes_for_role(role.id)
    return RoleWithPermissions(**RoleRead.model_validate(role).model_dump(), permissions=codes)


@router.get("/permissions", summary="List every permission (admin)")
async def list_permissions(
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """List every permission in the system. Permissions are seeded, not creatable via the API."""
    permissions = await rbac_service.list_permissions()
    data = [PermissionRead.model_validate(p).model_dump(mode="json") for p in permissions]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/roles", status_code=status.HTTP_201_CREATED, summary="Create a role (admin)")
async def create_role(
    payload: RoleCreate,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """Create a new role, optionally granting it an initial set of permission codes."""
    role = await rbac_service.create_role(
        name=payload.name, description=payload.description, permission_codes=payload.permission_codes
    )
    data = (await _role_with_permissions(role, rbac_service)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/roles", summary="List every role (admin)")
async def list_roles(
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """List every role, with each role's granted permission codes expanded."""
    roles = await rbac_service.list_roles()
    data = [(await _role_with_permissions(r, rbac_service)).model_dump(mode="json") for r in roles]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/roles/{role_id}", summary="Get a role (admin)")
async def get_role(
    role_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """Fetch a single role, with its granted permission codes expanded."""
    role = await rbac_service.get_role_or_raise(role_id)
    data = (await _role_with_permissions(role, rbac_service)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/roles/{role_id}", summary="Update a role (admin)")
async def update_role(
    role_id: uuid.UUID,
    payload: RoleUpdate,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """Update a role's name/description. System roles cannot be renamed."""
    role = await rbac_service.update_role(role_id, name=payload.name, description=payload.description)
    data = (await _role_with_permissions(role, rbac_service)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.delete("/roles/{role_id}", summary="Delete a role (admin)")
async def delete_role(
    role_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """Delete a role. System roles cannot be deleted."""
    await rbac_service.delete_role(role_id)
    return build_success_response(data={"deleted": True}, request_id=request.state.request_id)


@router.post("/roles/{role_id}/permissions", summary="Grant a permission to a role (admin)")
async def grant_permission(
    role_id: uuid.UUID,
    payload: GrantPermissionRequest,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """Grant a permission to a role, if not already granted."""
    await rbac_service.grant_permission(role_id, payload.permission_id)
    return build_success_response(data={"granted": True}, request_id=request.state.request_id)


@router.delete("/roles/{role_id}/permissions/{permission_id}", summary="Revoke a permission from a role (admin)")
async def revoke_permission(
    role_id: uuid.UUID,
    permission_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """Revoke a permission from a role."""
    await rbac_service.revoke_permission(role_id, permission_id)
    return build_success_response(data={"revoked": True}, request_id=request.state.request_id)
