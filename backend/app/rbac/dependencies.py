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
