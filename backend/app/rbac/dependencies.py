"""
RBAC Dependencies.

Exposes :func:`require_permission`, the single enforcement point every
permission-protected route in the application depends on, plus the
:class:`RBACService` factory used by the roles/permissions management API.
"""

from __future__ import annotations

from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.cache.base import CacheBackend
from app.cache.dependency import get_cache
from app.core.exceptions import ForbiddenException
from app.database.session import get_db_session
from app.rbac.repository import PermissionRepository, RoleRepository, UserRoleRepository
from app.rbac.service import RBACService


def get_rbac_service(
    db: AsyncSession = Depends(get_db_session),
    cache: CacheBackend = Depends(get_cache),
) -> RBACService:
    """Build a request-scoped :class:`RBACService` wired to its repositories."""
    return RBACService(
        role_repository=RoleRepository(db),
        permission_repository=PermissionRepository(db),
        user_role_repository=UserRoleRepository(db),
        cache=cache,
    )


def require_permission(permission_code: str) -> Callable[..., Coroutine[Any, Any, CurrentUser]]:
    """
    Build a FastAPI dependency that authorizes a request against a single permission code.
    """

    async def _checker(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if permission_code not in current_user.permissions:
            raise ForbiddenException(f"This action requires the {permission_code!r} permission.")
        return current_user

    return _checker


def require_any_permission(*permission_codes: str) -> Callable[..., Coroutine[Any, Any, CurrentUser]]:
    """
    Build a FastAPI dependency that authorizes a request if the user holds ANY ONE of several
    permission codes (as opposed to :func:`require_permission`, which requires exactly one fixed code).

    Used where a route's fine-grained authorization can't be fully decided until the request body
    is inspected (e.g. Shipment Planning's cell-value/status-color routes: which specific permission
    is required depends on WHICH column or WHICH status color the request targets, resolved deeper in
    the service layer). This dependency only performs the coarse "is this user allowed to even attempt
    this route at all" pass -- letting through anyone with the general permission (e.g.
    planning.cell.edit) OR any of the narrower, column/color-specific permissions (e.g.
    planning.textyn.edit) -- and the service layer still performs the real, specific check once it
    knows exactly which column or color is involved, rejecting the request there if the user's
    specific permission doesn't actually cover that column/color.
    """

    async def _checker(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if not any(code in current_user.permissions for code in permission_codes):
            codes_display = " or ".join(repr(c) for c in permission_codes)
            raise ForbiddenException(f"This action requires one of the following permissions: {codes_display}.")
        return current_user

    return _checker


def require_super_admin() -> Callable[..., Coroutine[Any, Any, CurrentUser]]:
    """
    Build a FastAPI dependency that verifies the current user has the super_admin role.
    """

    async def _checker(
        current_user: CurrentUser = Depends(get_current_user),
        rbac_service: RBACService = Depends(get_rbac_service),
    ) -> CurrentUser:
        roles = await rbac_service.list_roles_for_user(current_user.id)
        if not any(r.name == "super_admin" for r in roles):
            raise ForbiddenException("Only Super Administrators can perform this action.")
        return current_user

    return _checker