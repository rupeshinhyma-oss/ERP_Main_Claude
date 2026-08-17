"""
User Management Routes.

Implements the admin-facing user-management API: create user, list/get
users, update profile, reset password, activate/deactivate/unlock, role
assignment, and session/force-logout management. Every route is gated by a
specific RBAC permission via ``require_permission()``.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.dependencies import get_auth_service, get_current_user
from app.auth.schemas import SessionRead
from app.auth.service import AuthService, CurrentUser
from app.common.pagination import PageMeta, PageParams
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.rbac.dependencies import get_rbac_service, require_permission
from app.rbac.repository import UserRoleRepository
from app.rbac.service import RBACService
from app.users.repository import UserRepository
from app.users.schemas import (
    AssignRoleRequest,
    ResetPasswordRequest,
    ResetPasswordResponse,
    UserCreate,
    UserRead,
    UserUpdate,
    UserWithRoles,
)
from app.users.service import UserService

router = APIRouter(prefix="/users", tags=["Users"])


def get_user_service(
    db: AsyncSession = Depends(get_db_session),
    rbac_service: RBACService = Depends(get_rbac_service),
    auth_service: AuthService = Depends(get_auth_service),
) -> UserService:
    """Build a request-scoped :class:`UserService` wired to its repositories and collaborators."""
    return UserService(
        user_repository=UserRepository(db),
        user_role_repository=UserRoleRepository(db),
        rbac_service=rbac_service,
        auth_service=auth_service,
    )


async def _user_with_roles(
    user: User, rbac_service: RBACService, db: AsyncSession | None = None
) -> UserWithRoles:
    """Shape a ``User`` ORM instance into the response schema, with role names and manager expanded."""
    roles = await rbac_service.list_roles_for_user(user.id)
    mgr_name = None

    if db is not None:
        from sqlalchemy import select
        if user.manager_id:
            mgr_res = await db.execute(select(User).where(User.id == user.manager_id))
            mgr = mgr_res.scalar_one_or_none()
            if mgr:
                mgr_name = mgr.full_name

    return UserWithRoles(
        **UserRead.model_validate(user).model_dump(),
        roles=[r.name for r in roles],
        employee_name=user.full_name,
        manager_name=mgr_name,
    )


async def _record_user_action(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    target_user_id: uuid.UUID,
    description: str,
    new_values: dict | None = None,
) -> None:
    """Shared helper: record an admin action against a target user and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="users",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="User",
        entity_id=str(target_user_id),
        new_values=new_values,
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description=description,
    )
    request.state.audit_logged = True


@router.post("", status_code=status.HTTP_201_CREATED, summary="Create a user (admin)")
async def create_user(
    payload: UserCreate,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    db: AsyncSession = Depends(get_db_session),
    current_user: CurrentUser = Depends(require_permission("user.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Create a new user account with profile information and initial credentials/roles."""
    user, temporary_password = await user_service.create_user(
        first_name=payload.first_name,
        middle_name=payload.middle_name,
        last_name=payload.last_name,
        display_name=payload.display_name,
        employee_code=payload.employee_code,
        username=payload.username,
        email=payload.email,
        phone=payload.phone,
        manager_id=payload.manager_id,
        date_of_birth=payload.date_of_birth,
        gender=payload.gender,
        date_of_joining=payload.date_of_joining,
        employment_type=payload.employment_type,
        employment_status=payload.employment_status,
        address=payload.address,
        city=payload.city,
        state=payload.state,
        country=payload.country,
        postal_code=payload.postal_code,
        emergency_contact=payload.emergency_contact,
        notes=payload.notes,
        role_ids=payload.role_ids,
        password=payload.password,
        individual_permission_ids=payload.individual_permission_ids,
        created_by=current_user.id,
    )
    user_data = await _user_with_roles(user, rbac_service, db=db)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        target_user_id=user.id,
        description=f"Created user {user.username!r}.",
        new_values={
            "username": payload.username,
            "email": payload.email,
            "employee_code": payload.employee_code,
            "phone": payload.phone,
            "role_ids": [str(rid) for rid in (payload.role_ids or [])],
        },
    )
    data = {**user_data.model_dump(mode="json"), "temporary_password": temporary_password}
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("", summary="List users (admin)")
async def list_users(
    request: Request,
    page_params: PageParams = Depends(),
    query: str | None = Query(default=None),
    status: str | None = Query(default=None),
    user_service: UserService = Depends(get_user_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    db: AsyncSession = Depends(get_db_session),
    _current_user: CurrentUser = Depends(require_permission("user.read")),
) -> dict:
    """List users, paginated, with optional query and status search filters."""
    users, total = await user_service.list_users(
        offset=page_params.offset,
        limit=page_params.limit,
        query=query,
        status=status,
    )
    items = []
    for u in users:
        u_with_roles = await _user_with_roles(u, rbac_service, db=db)
        items.append(u_with_roles.model_dump(mode="json"))
    data = {
        "items": items,
        "total": total,
        "offset": page_params.offset,
        "limit": page_params.limit,
    }
    # meta.pagination alongside the existing items/total/offset/limit shape --
    # kept for backwards compatibility with any caller already reading `total`,
    # while bringing this endpoint in line with every other paginated list
    # endpoint in the API, whose meta.pagination the frontend's shared
    # pagination component reads from.
    meta = PageMeta.build(
        page=page_params.page, page_size=page_params.page_size, total_records=total
    ).as_meta_dict()
    return build_success_response(data=data, request_id=request.state.request_id, meta=meta)


@router.get("/{user_id}", summary="Get a user (admin)")
async def get_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    db: AsyncSession = Depends(get_db_session),
    _current_user: CurrentUser = Depends(require_permission("user.read")),
) -> dict:
    """Fetch a single user, with assigned role names expanded."""
    user = await user_service.get_by_id_or_raise(user_id)
    data = (await _user_with_roles(user, rbac_service, db=db)).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{user_id}", summary="Update a user's profile")
async def update_user(
    user_id: uuid.UUID,
    payload: UserUpdate,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(get_current_user),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Update a user's non-credential profile fields."""
    if current_user.id != user_id and "user.update" not in current_user.permissions:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("You do not have permission to modify this user account.")

    update_dict = payload.model_dump(exclude_unset=True)
    user = await user_service.update_user(
        user_id,
        updated_by=current_user.id,
        **update_dict,
    )
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        target_user_id=user_id,
        description=f"Updated profile for user {user.username!r}.",
        new_values=update_dict,
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/reset-password", summary="Admin-generated password reset or custom password set")
async def reset_password(
    user_id: uuid.UUID,
    request: Request,
    payload: ResetPasswordRequest | None = None,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Set a custom password or generate a new temporary password for a user."""
    custom_pwd = payload.new_password if payload else None
    must_change = payload.must_change_password if payload else True
    password_set = await user_service.admin_reset_password(
        user_id, custom_password=custom_pwd, must_change_password=must_change, reset_by=current_user.id
    )
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.PASSWORD_RESET,
        actor=current_user,
        target_user_id=user_id,
        description=f"Administrator reset/set password for user (custom={bool(custom_pwd)}).",
    )
    data = ResetPasswordResponse(temporary_password=password_set).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/activate", summary="Activate a user")
async def activate_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Activate a pending or inactive user account."""
    user = await user_service.activate_user(user_id, updated_by=current_user.id)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.USER_ACTIVATED,
        actor=current_user,
        target_user_id=user_id,
        description=f"Activated user {user.username!r}.",
        new_values={"status": user.status.value, "is_active": True},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/deactivate", summary="Deactivate a user")
async def deactivate_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Deactivate a user account and force-logout all of their active sessions."""
    user = await user_service.deactivate_user(user_id, updated_by=current_user.id)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.USER_DEACTIVATED,
        actor=current_user,
        target_user_id=user_id,
        description=f"Deactivated user {user.username!r}; all sessions revoked.",
        new_values={"status": user.status.value, "is_active": False},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/suspend", summary="Suspend a user")
async def suspend_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Suspend a user account and force-logout all of their active sessions."""
    user = await user_service.suspend_user(user_id, updated_by=current_user.id)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.STATUS_CHANGED,
        actor=current_user,
        target_user_id=user_id,
        description=f"Suspended user {user.username!r}; all sessions revoked.",
        new_values={"status": user.status.value, "is_active": False},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/unsuspend", summary="Unsuspend a user")
async def unsuspend_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Unsuspend a suspended user account and restore Active status."""
    user = await user_service.activate_user(user_id, updated_by=current_user.id)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.USER_ACTIVATED,
        actor=current_user,
        target_user_id=user_id,
        description=f"Unsuspended user {user.username!r}; account restored to active.",
        new_values={"status": user.status.value, "is_active": True},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/unlock", summary="Unlock a locked-out user")
async def unlock_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Clear a user's failed-login lockout state."""
    user = await user_service.unlock_user(user_id, updated_by=current_user.id)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.USER_UNLOCKED,
        actor=current_user,
        target_user_id=user_id,
        description=f"Cleared lockout for user {user.username!r}.",
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/roles", summary="Assign a role to a user")
async def assign_role(
    user_id: uuid.UUID,
    payload: AssignRoleRequest,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Assign a role to a user."""
    role = await rbac_service.get_role_or_raise(payload.role_id)
    await user_service.assign_role(user_id, payload.role_id, assigned_by=current_user.id)
    action = AuditAction.ADMIN_PROMOTION if role.name in ("super_admin", "admin") else AuditAction.ROLE_ASSIGNED
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=action,
        actor=current_user,
        target_user_id=user_id,
        description=f"Assigned role {role.name!r} to user.",
        new_values={"role_id": str(payload.role_id), "role_name": role.name},
    )
    return build_success_response(data={"assigned": True}, request_id=request.state.request_id)


@router.delete("/{user_id}/roles/{role_id}", summary="Remove a role from a user")
async def remove_role(
    user_id: uuid.UUID,
    role_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Remove a role assignment from a user."""
    role = await rbac_service.get_role_or_raise(role_id)
    await user_service.remove_role(user_id, role_id, removed_by=current_user.id)
    action = AuditAction.ADMIN_REMOVAL if role.name in ("super_admin", "admin") else AuditAction.ROLE_REMOVED
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=action,
        actor=current_user,
        target_user_id=user_id,
        description=f"Removed role {role.name!r} from user.",
        new_values={"role_id": str(role_id), "role_name": role.name},
    )
    return build_success_response(data={"removed": True}, request_id=request.state.request_id)


@router.get("/{user_id}/sessions", summary="View a user's active sessions")
async def view_sessions(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    _current_user: CurrentUser = Depends(require_permission("user.read")),
) -> dict:
    """List a user's currently active login sessions (device, IP, timestamps)."""
    sessions = await user_service.view_active_sessions(user_id)
    data = [SessionRead.model_validate(s).model_dump(mode="json") for s in sessions]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/force-logout", summary="Force logout a user from all sessions")
async def force_logout(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.update")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Revoke every active session for a user, immediately invalidating their refresh tokens."""
    revoked_count = await user_service.force_logout_user(user_id)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.LOGOUT,
        actor=current_user,
        target_user_id=user_id,
        description=f"Administrator force-logged-out user; {revoked_count} session(s) revoked.",
        new_values={"revoked_sessions": revoked_count},
    )
    return build_success_response(
        data={"revoked_sessions": revoked_count}, request_id=request.state.request_id
    )
