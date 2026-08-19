"""
Authentication Routes.

Implements the six public authentication endpoints:

    POST /api/v1/auth/login
    POST /api/v1/auth/logout
    POST /api/v1/auth/refresh
    POST /api/v1/auth/change-password
    POST /api/v1/auth/forgot-password
    GET  /api/v1/auth/profile

Routes are intentionally thin: they parse input, delegate to
``AuthService``, and shape the standard response envelope.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.audit.constants import AuditAction
from app.audit.dependencies import get_audit_service
from app.audit.service import AuditService
from app.auth.dependencies import get_auth_service, get_current_user, get_login_context
from app.auth.schemas import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    LogoutRequest,
    ProfileResponse,
    RefreshRequest,
    TokenResponse,
)
from app.auth.security import InvalidTokenError, TokenType, decode_token
from app.auth.service import AuthService, CurrentUser, LoginContext
from app.core.config import settings
from app.core.exceptions import UnauthorizedException
from app.core.responses import build_success_response
from app.rbac.dependencies import get_rbac_service
from app.rbac.service import RBACService
from app.users.repository import UserRepository
from app.database.session import get_db_session
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/auth", tags=["Authentication"])

_bearer_scheme = HTTPBearer(auto_error=True)


def _token_response(
    access_token: str, refresh_token: str, user: ProfileResponse | None = None
) -> TokenResponse:
    """Build the standard token-pair response payload."""
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        user=user,
    )


@router.post("/login", summary="Authenticate and receive an access/refresh token pair")
async def login(
    payload: LoginRequest,
    request: Request,
    auth_service: AuthService = Depends(get_auth_service),
    rbac_service: RBACService = Depends(get_rbac_service),
    context: LoginContext = Depends(get_login_context),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Verify credentials and issue a new token pair, tracked as a new session."""
    user, access_token, refresh_token = await auth_service.login(
        identifier=payload.identifier, password=payload.password, context=context
    )
    roles = await rbac_service.list_roles_for_user(user.id)
    permissions = await auth_service.get_user_effective_permissions(user.id)
    profile = ProfileResponse(
        id=user.id,
        first_name=user.first_name,
        last_name=user.last_name,
        employee_code=user.employee_code,
        username=user.username,
        email=user.email,
        phone=user.phone,
        status=user.status.value,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
        last_login_at=user.last_login_at,
        password_changed_at=user.password_changed_at,
        created_at=user.created_at,
        roles=[role.name for role in roles],
        permissions=sorted(permissions),
    )

    await audit_service.record(
        action=AuditAction.LOGIN,
        module="auth",
        user_id=user.id,
        username_snapshot=user.username,
        entity_type="User",
        entity_id=str(user.id),
        ip_address=context.ip_address,
        user_agent=context.user_agent,
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description="Successful login.",
    )
    request.state.audit_logged = True
    data = _token_response(access_token, refresh_token, user=profile).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/refresh", summary="Exchange a refresh token for a new token pair")
async def refresh(
    payload: RefreshRequest,
    request: Request,
    auth_service: AuthService = Depends(get_auth_service),
    context: LoginContext = Depends(get_login_context),
) -> dict:
    """Rotate the given refresh token, revoking it and issuing a brand new pair."""
    access_token, new_refresh_token = await auth_service.refresh(
        refresh_token=payload.refresh_token, context=context
    )
    data = _token_response(access_token, new_refresh_token).model_dump(mode="json")
    return build_success_response(data=data, request_id=request.state.request_id)


@router.post("/logout", summary="End the current session")
async def logout(
    payload: LogoutRequest,
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    auth_service: AuthService = Depends(get_auth_service),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Blacklist the current access token and revoke the session behind the given refresh token."""
    try:
        access_payload = decode_token(credentials.credentials, expected_type=TokenType.ACCESS)
    except InvalidTokenError as exc:
        raise UnauthorizedException("Invalid or expired access token.") from exc

    from datetime import datetime, timezone

    exp = datetime.fromtimestamp(access_payload["exp"], tz=timezone.utc)
    await auth_service.logout(
        access_token_jti=access_payload["jti"], access_token_exp=exp, refresh_token=payload.refresh_token
    )
    await audit_service.record(
        action=AuditAction.LOGOUT,
        module="auth",
        user_id=uuid.UUID(access_payload["sub"]),
        entity_type="User",
        entity_id=access_payload["sub"],
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description="User logged out.",
    )
    request.state.audit_logged = True
    return build_success_response(data={"logged_out": True}, request_id=request.state.request_id)


@router.post("/change-password", summary="Change your own password")
async def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    auth_service: AuthService = Depends(get_auth_service),
    db: AsyncSession = Depends(get_db_session),
    audit_service: AuditService = Depends(get_audit_service),
) -> dict:
    """Change the authenticated user's password, then revoke all of their sessions."""
    user_repository = UserRepository(db)
    user = await user_repository.get_by_id(current_user.id)
    if user is None:
        raise UnauthorizedException("User account no longer exists.")

    await auth_service.change_password(
        user, current_password=payload.current_password, new_password=payload.new_password
    )
    await audit_service.record(
        action=AuditAction.PASSWORD_CHANGE,
        module="auth",
        user_id=current_user.id,
        username_snapshot=current_user.username,
        entity_type="User",
        entity_id=str(current_user.id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        request_id=request.state.request_id,
        http_method=request.method,
        endpoint=request.url.path,
        response_status=status.HTTP_200_OK,
        description="User changed their own password; all sessions revoked.",
    )
    request.state.audit_logged = True
    return build_success_response(
        data={"message": "Password changed successfully. Please log in again."},
        request_id=request.state.request_id,
    )


@router.post("/forgot-password", summary="Request a password reset", status_code=status.HTTP_200_OK)
async def forgot_password(
    payload: ForgotPasswordRequest,
    request: Request,
    auth_service: AuthService = Depends(get_auth_service),
) -> dict:
    """
    Request a password reset.

    Always returns the same generic response, whether or not the identifier
    matches a real account, to avoid leaking which usernames/emails exist.
    Password resets in this system are admin-generated (see
    ``POST /users/{id}/reset-password``); this endpoint only flags the
    account and notifies administrators out-of-band.
    """
    await auth_service.forgot_password(payload.identifier)
    return build_success_response(
        data={
            "message": (
                "If an account matches that username or email, an administrator has been "
                "notified to reset your password."
            )
        },
        request_id=request.state.request_id,
    )


@router.get("/profile", summary="Get the authenticated user's profile")
async def get_profile(
    request: Request,
    current_user: CurrentUser = Depends(get_current_user),
    rbac_service: RBACService = Depends(get_rbac_service),
    db: AsyncSession = Depends(get_db_session),
) -> dict:
    """Return the authenticated user's own profile, including resolved roles and permissions."""
    user_repository = UserRepository(db)
    user = await user_repository.get_by_id(current_user.id)
    if user is None:
        raise UnauthorizedException("User account no longer exists.")

    roles = await rbac_service.list_roles_for_user(user.id)
    profile = ProfileResponse(
        id=user.id,
        first_name=user.first_name,
        last_name=user.last_name,
        employee_code=user.employee_code,
        username=user.username,
        email=user.email,
        phone=user.phone,
        status=user.status.value,
        is_active=user.is_active,
        must_change_password=user.must_change_password,
        last_login_at=user.last_login_at,
        password_changed_at=user.password_changed_at,
        created_at=user.created_at,
        roles=[role.name for role in roles],
        permissions=sorted(current_user.permissions),
    )
    return build_success_response(data=profile.model_dump(mode="json"), request_id=request.state.request_id)
