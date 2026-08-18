"""
RBAC Management Routes.

Implements the admin-facing role & permission management API: list
permissions, system roles CRUD, department permission CRUD, designation permission
CRUD, individual user permission CRUD, user effective permission breakdown, and
clone permission sets. Every route is gated by the ``settings.manage`` permission.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.rbac.dependencies import get_rbac_service, require_permission
from app.rbac.schemas import (
    AssignUserPermissionRequest,
    BulkUserPermissionsRequest,
    ClonePermissionSetRequest,
    DeleteRoleRequest,
    EffectivePermissionsBreakdown,
    GrantPermissionRequest,
    PermissionRead,
    RoleCreate,
    RoleDeletionImpact,
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
    """List every permission in the system."""
    permissions = await rbac_service.list_permissions()
    data = [PermissionRead.model_validate(p).model_dump(mode="json") for p in permissions]
    return build_success_response(data=data, request_id=request.state.request_id)


# --- System Roles -----------------------------------------------------------
@router.post("/roles", status_code=status.HTTP_201_CREATED, summary="Create a role (admin)")
async def create_role(
    payload: RoleCreate,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new role, optionally granting it an initial set of permission codes."""
    role = await rbac_service.create_role(
        name=payload.name, description=payload.description, permission_codes=payload.permission_codes
    )
    data = (await _role_with_permissions(role, rbac_service)).model_dump(mode="json")
    await audit_service.record(
        action=AuditAction.CREATE,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Role",
        entity_id=str(role.id),
        new_values={"name": role.name, "description": role.description, "permissions": payload.permission_codes},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_201_CREATED,
        description=f"Created role {role.name!r}.",
    )
    request.state.audit_logged = True
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
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update a role's name/description. System roles cannot be renamed."""
    role = await rbac_service.update_role(role_id, name=payload.name, description=payload.description)
    data = (await _role_with_permissions(role, rbac_service)).model_dump(mode="json")
    await audit_service.record(
        action=AuditAction.UPDATE,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Role",
        entity_id=str(role_id),
        new_values={"name": payload.name, "description": payload.description},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Updated role {role.name!r}.",
    )
    request.state.audit_logged = True
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/roles/{role_id}/deletion-impact", summary="Preview what deleting a role would affect (admin)")
async def get_role_deletion_impact(
    role_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    """
    Show how many users are currently assigned to a role, and who they are,
    before actually deleting it -- the frontend uses this to render a
    confirmation dialog offering to reassign them (defaulting to the "user"
    role) instead of silently leaving them with no role at all.
    """
    impact = await rbac_service.get_role_deletion_impact(role_id)
    return build_success_response(data=impact, request_id=request.state.request_id)


@router.delete("/roles/{role_id}", summary="Delete a role (admin)")
async def delete_role(
    role_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Delete a role that has no users currently assigned to it. System roles
    cannot be deleted. If the role still has users assigned, this is
    rejected -- use POST /roles/{role_id}/delete-with-reassignment instead,
    which moves them to another role first.
    """
    role = await rbac_service.get_role_or_raise(role_id)
    reassigned_count = await rbac_service.delete_role(role_id, reassigned_by=current_user.id)
    await audit_service.record(
        action=AuditAction.DELETE,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Role",
        entity_id=str(role_id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Deleted role {role.name!r}.",
    )
    request.state.audit_logged = True
    return build_success_response(
        data={"deleted": True, "reassigned_user_count": reassigned_count},
        request_id=request.state.request_id,
    )


@router.post(
    "/roles/{role_id}/delete-with-reassignment",
    summary="Delete a role, moving its users to another role first (admin)",
)
async def delete_role_with_reassignment(
    role_id: uuid.UUID,
    payload: DeleteRoleRequest,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Delete a role that still has users assigned to it, first moving every
    one of those users to ``reassign_to_role_id`` (the frontend defaults
    this to the "user" role) so nobody is silently left with no role and no
    permissions once the role they were on disappears.
    """
    role = await rbac_service.get_role_or_raise(role_id)
    reassigned_count = await rbac_service.delete_role(
        role_id, reassign_to_role_id=payload.reassign_to_role_id, reassigned_by=current_user.id
    )
    await audit_service.record(
        action=AuditAction.DELETE,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Role",
        entity_id=str(role_id),
        new_values={
            "reassigned_user_count": reassigned_count,
            "reassigned_to_role_id": str(payload.reassign_to_role_id) if payload.reassign_to_role_id else None,
        },
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Deleted role {role.name!r}; reassigned {reassigned_count} user(s).",
    )
    request.state.audit_logged = True
    return build_success_response(
        data={"deleted": True, "reassigned_user_count": reassigned_count},
        request_id=request.state.request_id,
    )


@router.post("/roles/{role_id}/permissions", summary="Grant a permission to a role (admin)")
async def grant_permission(
    role_id: uuid.UUID,
    payload: GrantPermissionRequest,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Grant a permission to a role, if not already granted."""
    await rbac_service.grant_permission(role_id, payload.permission_id, actor_user_id=current_user.id)
    await audit_service.record(
        action=AuditAction.PERMISSION_ASSIGNED,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Role",
        entity_id=str(role_id),
        new_values={"granted_permission_id": str(payload.permission_id)},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Granted permission {payload.permission_id} to role.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"granted": True}, request_id=request.state.request_id)


@router.delete("/roles/{role_id}/permissions/{permission_id}", summary="Revoke a permission from a role (admin)")
async def revoke_permission(
    role_id: uuid.UUID,
    permission_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Revoke a permission from a role."""
    await rbac_service.revoke_permission(role_id, permission_id, actor_user_id=current_user.id)
    await audit_service.record(
        action=AuditAction.PERMISSION_REMOVED,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="Role",
        entity_id=str(role_id),
        new_values={"revoked_permission_id": str(permission_id)},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Revoked permission {permission_id} from role.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"revoked": True}, request_id=request.state.request_id)


# --- Individual User Permissions ---------------------------------------------
@router.get("/users/{user_id}/permissions", summary="List user permission overrides (admin)")
async def list_user_permissions(
    user_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    links = await rbac_service.list_user_permissions(user_id)
    data = [
        {
            **PermissionRead.model_validate(link.permission).model_dump(mode="json"),
            "is_granted": link.is_granted,
        }
        for link in links
    ]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/users/{user_id}/permissions", summary="Assign user permission override (admin)")
async def assign_user_permission(
    user_id: uuid.UUID,
    payload: AssignUserPermissionRequest,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    await rbac_service.assign_user_permission(
        user_id, payload.permission_id, is_granted=payload.is_granted, granted_by=current_user.id
    )
    await audit_service.record(
        action=AuditAction.USER_OVERRIDE_ADDED,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="User",
        entity_id=str(user_id),
        new_values={"permission_id": str(payload.permission_id), "is_granted": payload.is_granted},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Assigned user permission override (is_granted={payload.is_granted}) to user {user_id}.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"assigned": True}, request_id=request.state.request_id)


@router.delete("/users/{user_id}/permissions/{permission_id}", summary="Remove user permission override (admin)")
async def remove_user_permission(
    user_id: uuid.UUID,
    permission_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    await rbac_service.remove_user_permission(user_id, permission_id)
    await audit_service.record(
        action=AuditAction.USER_OVERRIDE_REMOVED,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="User",
        entity_id=str(user_id),
        new_values={"permission_id": str(permission_id), "removed": True},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Removed user permission override from user {user_id}.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)


@router.put("/users/{user_id}/permissions/bulk", summary="Set bulk user permission overrides (admin)")
async def set_user_permissions_bulk(
    user_id: uuid.UUID,
    payload: BulkUserPermissionsRequest,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    overrides_tuples = [(item.permission_id, item.is_granted) for item in payload.overrides]
    count = await rbac_service.set_user_permissions_bulk(
        user_id, overrides_tuples, granted_by=current_user.id
    )
    await audit_service.record(
        action=AuditAction.PERMISSION_CHANGED,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="User",
        entity_id=str(user_id),
        new_values={"override_count": count},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Updated {count} direct permission overrides for user {user_id}.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"count": count}, request_id=request.state.request_id)


# --- Effective Permissions Breakdown ----------------------------------------
@router.get("/users/{user_id}/effective-permissions", response_model=None, summary="Get user effective permissions breakdown (admin)")
async def get_user_effective_permissions(
    user_id: uuid.UUID,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    _current_user: CurrentUser = Depends(require_permission("settings.manage")),
) -> dict:
    data = await rbac_service.get_user_effective_permissions(user_id)
    return build_success_response(data=data, request_id=request.state.request_id)


# --- Clone Permission Set ----------------------------------------------------
@router.post("/clone-permissions", summary="Clone permission set between entities (admin)")
async def clone_permission_set(
    payload: ClonePermissionSetRequest,
    request: Request,
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    cloned_count = await rbac_service.clone_permission_set(
        source_type=payload.source_type,
        source_id=payload.source_id,
        target_type=payload.target_type,
        target_id=payload.target_id,
        cloned_by=current_user.id,
    )
    await audit_service.record(
        action=AuditAction.PERMISSION_CHANGED,
        module="rbac",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type=payload.target_type.capitalize(),
        entity_id=str(payload.target_id),
        new_values={
            "source_type": payload.source_type,
            "source_id": str(payload.source_id),
            "cloned_permissions_count": cloned_count,
        },
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=f"Cloned {cloned_count} permission(s) from {payload.source_type} ({payload.source_id}) to {payload.target_type} ({payload.target_id}).",
    )
    request.state.audit_logged = True
    return build_success_response(data={"cloned_count": cloned_count}, request_id=request.state.request_id)