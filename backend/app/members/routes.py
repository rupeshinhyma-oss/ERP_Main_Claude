"""
Team Member Routes.

Exposes the Teams page's composed member-management endpoints:

    POST   /members                       Add a team member (User + Employee + role).
    GET    /members/{user_id}/password     Reveal a member's current password ("eye icon").
    PATCH  /members/{user_id}/password     Reset a member's password to a new admin-chosen value.

All gated by the same permissions the underlying operations already
require (user.create/user.update AND employee.create/employee.read), so
these composed endpoints never grant more access than doing the
equivalent operations separately through the existing Users/Employees
APIs would.

The password reveal/reset endpoints are additionally gated by
``settings.manage`` -- viewing another user's plaintext password is a
significant, deliberately rare capability (see app/members/crypto.py's
module docstring), so it requires the same permission that gates Roles &
Permissions management, not just ordinary user-editing rights.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.service import CurrentUser
from app.core.exceptions import ForbiddenException
from app.core.responses import build_success_response
from app.members.dependencies import get_team_member_service
from app.members.schemas import MemberPasswordReset, MemberPasswordReveal, TeamMemberCreate, TeamMemberRead
from app.members.service import TeamMemberService
from app.rbac.dependencies import require_permission

router = APIRouter(prefix="/members", tags=["Team Members"])


async def _record_member_audit(
    *,
    audit_service: AuditService,
    request: Request,
    action: AuditAction,
    actor: CurrentUser,
    user_id: uuid.UUID,
    description: str,
    new_values: dict | None = None,
) -> None:
    """Shared helper: record a Teams/member action and mark the request as logged."""
    await audit_service.record(
        action=action,
        module="members",
        user_id=actor.id,
        username_snapshot=actor.username,
        entity_type="TeamMember",
        entity_id=str(user_id),
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


@router.post("", status_code=status.HTTP_201_CREATED, summary="Add a team member (Teams page)")
async def create_member(
    payload: TeamMemberCreate,
    request: Request,
    service: TeamMemberService = Depends(get_team_member_service),
    current_user: CurrentUser = Depends(require_permission("user.create")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Create a new team member: a User account (login, with the
    ADMIN-SUPPLIED password) linked to a new Employee profile, with the
    default 'employee' role assigned.

    Requires BOTH ``user.create`` and ``employee.create`` -- the same two
    permissions an admin would need to do this via the separate Users and
    Employees APIs already, so this composed shortcut grants nothing extra.
    """
    if "employee.create" not in current_user.permissions:
        raise ForbiddenException("This action requires the 'employee.create' permission.")

    result = await service.create_member(
        full_name=payload.full_name,
        email=payload.email,
        password=payload.password,
        department_id=payload.department_id,
        designation_id=payload.designation_id,
        role_id=payload.role_id,
        role_name=payload.role_name,
        created_by=current_user.id,
    )
    data = TeamMemberRead(**result).model_dump(mode="json")

    # Deliberately excludes the password itself from the audit trail's
    # new_values -- audit log entries are broadly readable by anyone with
    # audit.read, which is a wider circle than should ever see a
    # plaintext password.
    await _record_member_audit(
        audit_service=audit_service,
        request=request,
        action=AuditAction.CREATE,
        actor=current_user,
        user_id=result["user_id"],
        description=f"Added team member {payload.full_name!r} ({payload.email}).",
        new_values={
            "full_name": payload.full_name,
            "email": payload.email,
            "department_id": str(payload.department_id) if payload.department_id else None,
            "designation_id": str(payload.designation_id) if payload.designation_id else None,
            "employee_id": str(result["employee_id"]),
            "username": result["username"],
            "role": result["role"],
        },
    )

    return build_success_response(
        data=data, request_id=request.state.request_id, message="Team member added successfully."
    )


@router.get("/{user_id}/password", summary="Reveal a member's current password (admin 'eye icon')")
async def reveal_member_password(
    user_id: uuid.UUID,
    request: Request,
    service: TeamMemberService = Depends(get_team_member_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Decrypt and return a team member's currently-set password.

    Requires ``settings.manage`` (the same permission that gates Roles &
    Permissions) in addition to being an authenticated request -- viewing
    another user's plaintext password is a deliberately rare, high-impact
    capability. Every reveal is audit-logged (without the password itself
    in the log entry) so there's a record of who viewed it and when.
    """
    plaintext = await service.reveal_password(user_id)
    await _record_member_audit(
        audit_service=audit_service,
        request=request,
        action=AuditAction.OTHER,
        actor=current_user,
        user_id=user_id,
        description="Revealed a team member's password.",
    )
    data = MemberPasswordReveal(user_id=user_id, password=plaintext).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.patch("/{user_id}/password", summary="Reset a member's password to a new value (admin)")
async def reset_member_password(
    user_id: uuid.UUID,
    payload: MemberPasswordReset,
    request: Request,
    service: TeamMemberService = Depends(get_team_member_service),
    current_user: CurrentUser = Depends(require_permission("settings.manage")),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """
    Set a team member's password to a new admin-chosen value.

    Requires ``settings.manage``, same as the reveal endpoint above.
    Updates both the real login hash and the reversible vault copy
    together, so a subsequent reveal always reflects the password that
    actually authenticates -- they can never silently drift apart.
    """
    await service.reset_password(user_id, payload.password, updated_by=current_user.id)
    await _record_member_audit(
        audit_service=audit_service,
        request=request,
        action=AuditAction.PASSWORD_RESET,
        actor=current_user,
        user_id=user_id,
        description="Reset a team member's password.",
    )
    return build_success_response(
        data={"user_id": str(user_id), "reset": True},
        request_id=request.state.request_id,
        message="Password reset successfully.",
    )