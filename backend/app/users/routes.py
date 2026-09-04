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
from app.core.exceptions import BadRequestException
from app.core.responses import build_success_response
from app.database.session import get_db_session
from app.rbac.dependencies import get_rbac_service, require_permission
from app.rbac.repository import UserRoleRepository
from app.rbac.service import RBACService
from app.users.models import User
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

    pos_id = None
    pos_name = None

    if db is not None:
        from sqlalchemy import select
        if user.manager_id:
            mgr_res = await db.execute(select(User).where(User.id == user.manager_id))
            mgr = mgr_res.scalar_one_or_none()
            if mgr:
                mgr_name = mgr.full_name

        try:
            from app.org_structure.models import EmployeePositionAssignment, Position, OrgRecordStatus
            pos_stmt = (
                select(Position.id, Position.name)
                .join(EmployeePositionAssignment, EmployeePositionAssignment.position_id == Position.id)
                .where(
                    EmployeePositionAssignment.employee_id == user.id,
                    EmployeePositionAssignment.is_primary.is_(True),
                    EmployeePositionAssignment.status == OrgRecordStatus.ACTIVE,
                )
            )
            pos_res = await db.execute(pos_stmt)
            pos_row = pos_res.first()
            if not pos_row:
                fallback_stmt = (
                    select(Position.id, Position.name)
                    .join(EmployeePositionAssignment, EmployeePositionAssignment.position_id == Position.id)
                    .where(
                        EmployeePositionAssignment.employee_id == user.id,
                        EmployeePositionAssignment.status == OrgRecordStatus.ACTIVE,
                    )
                )
                pos_res = await db.execute(fallback_stmt)
                pos_row = pos_res.first()
            if pos_row:
                pos_id = pos_row[0]
                pos_name = pos_row[1]
        except Exception:
            pass

    role_names = [r.name for r in roles]
    if not role_names:
        role_names = ["user"]

    user_dict = UserRead.model_validate(user).model_dump()
    user_dict["roles"] = role_names
    user_dict["employee_name"] = user.full_name
    user_dict["manager_name"] = mgr_name
    user_dict["position_id"] = pos_id
    user_dict["position_name"] = pos_name

    return UserWithRoles(**user_dict)


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
        has_login=payload.has_login,
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
        position_id=payload.position_id,
        created_by=current_user.id,
    )
    user_data = await _user_with_roles(user, rbac_service, db=db)
    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        target_user_id=user.id,
        description=f"Created {'user' if payload.has_login else 'employee'} {user.full_name!r}.",
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
    _current_user: CurrentUser = Depends(require_permission("user.view")),
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


@router.get("/all", summary="List all users (unpaginated for manager pickers and lookups)")
async def list_all_users(
    request: Request,
    user_service: UserService = Depends(get_user_service),
    _current_user: CurrentUser = Depends(require_permission("user.view")),
) -> dict:
    """Return every non-deleted user, for manager dropdowns and lookups."""
    users = await user_service.user_repository.list_all()
    data = [UserRead.model_validate(u).model_dump(mode="json") for u in users]
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/department-manager/{role_id}", summary="Get the department manager for a role/department")
async def get_department_manager(
    role_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    _current_user: CurrentUser = Depends(require_permission("user.view")),
) -> dict:
    """Find and return the manager for a given department/role."""
    from collections import Counter
    from sqlalchemy import case, func, select
    from app.org_structure.models import DepartmentLeadershipAssignment, LeadershipType, OrgRecordStatus
    from app.rbac.models import UserRole

    # 1. Primary source: DepartmentLeadershipAssignment for this department
    lead_stmt = (
        select(DepartmentLeadershipAssignment)
        .where(
            DepartmentLeadershipAssignment.department_id == role_id,
            DepartmentLeadershipAssignment.status == OrgRecordStatus.ACTIVE,
        )
        .order_by(
            case(
                (DepartmentLeadershipAssignment.leadership_type == LeadershipType.PRIMARY_MANAGER, 1),
                (DepartmentLeadershipAssignment.leadership_type == LeadershipType.DEPARTMENT_HEAD, 2),
                (DepartmentLeadershipAssignment.leadership_type == LeadershipType.ACTING_MANAGER, 3),
                (DepartmentLeadershipAssignment.leadership_type == LeadershipType.ASSISTANT_MANAGER, 4),
                else_=5,
            )
        )
    )
    lead_res = await db.execute(lead_stmt)
    lead = lead_res.scalar_one_or_none()
    if lead and lead.employee_id:
        user = await db.get(User, lead.employee_id)
        if user and not user.deleted_at:
            return build_success_response(
                data={
                    "manager_id": str(user.id),
                    "manager_name": user.full_name,
                    "username": user.username,
                },
                request_id=request.state.request_id,
            )

    # 2. Secondary source: Check users assigned to this role
    role_users_stmt = (
        select(User)
        .join(UserRole, UserRole.user_id == User.id)
        .where(UserRole.role_id == role_id, User.deleted_at.is_(None))
    )
    role_users = list((await db.execute(role_users_stmt)).scalars().all())

    if role_users:
        role_user_ids = {u.id for u in role_users}

        # Is one of the department users managing others in this department?
        for u in role_users:
            sub_count_stmt = select(func.count(User.id)).where(
                User.manager_id == u.id,
                User.id.in_(role_user_ids),
                User.deleted_at.is_(None),
            )
            cnt = (await db.execute(sub_count_stmt)).scalar() or 0
            if cnt > 0:
                return build_success_response(
                    data={
                        "manager_id": str(u.id),
                        "manager_name": u.full_name,
                        "username": u.username,
                    },
                    request_id=request.state.request_id,
                )

        # Or do the department members share a common manager?
        managers = [u.manager_id for u in role_users if u.manager_id is not None]
        if managers:
            common_mgr_id = Counter(managers).most_common(1)[0][0]
            mgr_user = await db.get(User, common_mgr_id)
            if mgr_user and not mgr_user.deleted_at:
                return build_success_response(
                    data={
                        "manager_id": str(mgr_user.id),
                        "manager_name": mgr_user.full_name,
                        "username": mgr_user.username,
                    },
                    request_id=request.state.request_id,
                )

    return build_success_response(
        data={"manager_id": None, "manager_name": None, "username": None},
        request_id=request.state.request_id,
    )


@router.get("/{user_id}", summary="Get a user (admin)")
async def get_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    db: AsyncSession = Depends(get_db_session),
    _current_user: CurrentUser = Depends(require_permission("user.view")),
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
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Update a user's non-credential profile fields."""
    if current_user.id != user_id and "user.action" not in current_user.permissions and not current_user.is_super_admin:
        from app.core.exceptions import ForbiddenException
        raise ForbiddenException("You do not have permission to modify this user account.")

    position_id_specified = "position_id" in payload.model_fields_set
    target_position_id = payload.position_id if position_id_specified else None

    update_dict = payload.model_dump(exclude_unset=True)
    update_dict.pop("position_id", None)

    user = await user_service.update_user(
        user_id,
        updated_by=current_user.id,
        **update_dict,
    )

    pos_id = None
    pos_name = None
    if position_id_specified:
        try:
            from app.org_structure.assignments_repository import EmployeePositionAssignmentRepository
            from app.org_structure.models import EmployeePositionAssignment, OrgRecordStatus, Position, PositionAssignmentType
            assignment_repo = EmployeePositionAssignmentRepository(db)

            # Deactivate previous active primary position assignments
            active_assignments = await assignment_repo.list_for_employee(user_id, active_only=True)
            for a in active_assignments:
                if a.is_primary:
                    await assignment_repo.update(a, is_primary=False, status=OrgRecordStatus.INACTIVE)

            if target_position_id:
                existing = await assignment_repo.get_exact(user_id, target_position_id, PositionAssignmentType.PRIMARY)
                if existing is not None:
                    await assignment_repo.update(existing, status=OrgRecordStatus.ACTIVE, is_primary=True)
                else:
                    await assignment_repo.create(
                        employee_id=user_id,
                        position_id=target_position_id,
                        assignment_type=PositionAssignmentType.PRIMARY,
                        is_primary=True,
                        status=OrgRecordStatus.ACTIVE,
                    )
                pos_obj = await db.get(Position, target_position_id)
                if pos_obj:
                    pos_id = pos_obj.id
                    pos_name = pos_obj.name
        except Exception:
            pass

    audit_payload = dict(update_dict)
    if position_id_specified:
        audit_payload["position_id"] = str(target_position_id) if target_position_id else None

    await _record_user_action(
        audit_service=audit_service,
        request=request,
        action=AuditAction.UPDATE,
        actor=current_user,
        target_user_id=user_id,
        description=f"Updated profile for {user.full_name!r}.",
        new_values=audit_payload,
    )
    user_dict = UserRead.model_validate(user).model_dump(mode="json")
    if position_id_specified:
        user_dict["position_id"] = str(pos_id) if pos_id else None
        user_dict["position_name"] = pos_name
    return build_success_response(data=user_dict, request_id=request.state.request_id)


@router.post("/{user_id}/reset-password", summary="Admin-generated password reset or custom password set")
async def reset_password(
    user_id: uuid.UUID,
    request: Request,
    payload: ResetPasswordRequest | None = None,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
        description=f"Activated {user.full_name!r}.",
        new_values={"status": user.status.value, "is_active": True},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/deactivate", summary="Deactivate a user")
async def deactivate_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
        description=f"Deactivated {user.full_name!r}; all sessions revoked.",
        new_values={"status": user.status.value, "is_active": False},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/suspend", summary="Suspend a user")
async def suspend_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
        description=f"Suspended {user.full_name!r}; all sessions revoked.",
        new_values={"status": user.status.value, "is_active": False},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/unsuspend", summary="Unsuspend a user")
async def unsuspend_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
        description=f"Unsuspended {user.full_name!r}; account restored to active.",
        new_values={"status": user.status.value, "is_active": True},
    )
    data = UserRead.model_validate(user).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/{user_id}/unlock", summary="Unlock a locked-out user")
async def unlock_user(
    user_id: uuid.UUID,
    request: Request,
    user_service: UserService = Depends(get_user_service),
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
        description=f"Cleared lockout for {user.full_name!r}.",
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
    current_user: CurrentUser = Depends(require_permission("user.action")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Assign a role to a user."""
    role = await rbac_service.get_role_or_raise(payload.role_id)
    await user_service.assign_role(
        user_id, payload.role_id, assigned_by=current_user.id,
        assignment_type=payload.assignment_type, is_primary=payload.is_primary,
        effective_from=payload.effective_from, effective_to=payload.effective_to,
    )
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
    current_user: CurrentUser = Depends(require_permission("user.action")),
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
    _current_user: CurrentUser = Depends(require_permission("user.view")),
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
    current_user: CurrentUser = Depends(require_permission("user.action")),
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


@router.delete("/{user_id}", summary="Delete a user (permanently disabled)")
async def delete_user(
    user_id: uuid.UUID,
    current_user: CurrentUser = Depends(require_permission("user.action")),
) -> dict:
    """User deletion has been permanently disabled; users must only be deactivated."""
    raise BadRequestException(
        "User deletion has been permanently disabled. User accounts cannot be deleted to preserve audit and transaction history. Please deactivate the user instead."
    )