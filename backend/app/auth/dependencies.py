"""
Auth Dependencies.

FastAPI dependency-injection wiring for the auth module: how to build an
``AuthService`` per request, how to resolve the authenticated
:class:`CurrentUser` from the ``Authorization`` header, and how to pull
client IP/device metadata out of the request for session tracking.

``require_permission()`` itself lives in :mod:`app.rbac.dependencies`
(it needs ``CurrentUser`` from here, but nothing here needs RBAC), keeping
the dependency graph a DAG rather than a cycle.
"""

from __future__ import annotations

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.repository import PasswordHistoryRepository, SessionRepository, TokenBlacklistRepository
from app.auth.service import AuthService, CurrentUser, LoginContext
from app.cache.base import CacheBackend
from app.cache.dependency import get_cache
from app.database.session import get_db_session
from app.rbac.repository import RoleRepository
from app.users.repository import UserRepository

_bearer_scheme = HTTPBearer(auto_error=True, description="Access token issued by POST /auth/login")


def get_auth_service(
    db: AsyncSession = Depends(get_db_session),
    cache: CacheBackend = Depends(get_cache),
) -> AuthService:
    """Build a request-scoped :class:`AuthService` wired to its repositories."""
    return AuthService(
        user_repository=UserRepository(db),
        role_repository=RoleRepository(db),
        session_repository=SessionRepository(db),
        token_blacklist_repository=TokenBlacklistRepository(db),
        password_history_repository=PasswordHistoryRepository(db),
        cache=cache,
    )


from app.core.exceptions import ForbiddenException

_ALLOWED_PATHS_WHEN_MUST_CHANGE_PASSWORD = {
    "/api/v1/auth/change-password",
    "/api/v1/auth/logout",
    "/api/v1/auth/profile",
    "/api/v1/auth/refresh",
}


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    auth_service: AuthService = Depends(get_auth_service),
) -> CurrentUser:
    """
    Resolve the authenticated :class:`CurrentUser` from the ``Authorization: Bearer`` header.

    This is the single dependency every protected route should depend on
    (directly, or transitively via ``require_permission()``).
    """
    user = await auth_service.verify_access_token(credentials.credentials)
    path = request.url.path.rstrip("/")
    if user.must_change_password and path not in _ALLOWED_PATHS_WHEN_MUST_CHANGE_PASSWORD:
        raise ForbiddenException("Password change required. Please change your password to continue.")
    return user


def get_client_ip(request: Request) -> str | None:
    """
    Best-effort client IP extraction, honoring a trusted reverse proxy's ``X-Forwarded-For``.

    Takes the first (left-most) hop in ``X-Forwarded-For`` when present,
    since that is the original client in the conventional proxy chain
    ordering; falls back to the direct connection's address otherwise.
    """
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client:
        return request.client.host
    return None


def get_login_context(request: Request) -> LoginContext:
    """Build a :class:`LoginContext` (IP, user agent, device info) from the current request."""
    user_agent = request.headers.get("user-agent")
    device_info = request.headers.get("x-device-info") or user_agent
    return LoginContext(ip_address=get_client_ip(request), user_agent=user_agent, device_info=device_info)
