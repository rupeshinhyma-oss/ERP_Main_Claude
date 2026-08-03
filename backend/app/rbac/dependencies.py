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
from app.core.exceptions import ForbiddenException
from app.database.session import get_db_session
from app.rbac.repository import PermissionRepository, RoleRepository, UserRoleRepository
from app.rbac.service import RBACService


def get_rbac_service(db: AsyncSession = Depends(get_db_session)) -> RBACService:
    """Build a request-scoped :class:`RBACService` wired to its repositories."""
    return RBACService(
        role_repository=RoleRepository(db),
        permission_repository=PermissionRepository(db),
        user_role_repository=UserRoleRepository(db),
    )


def require_permission(permission_code: str) -> Callable[..., Coroutine[Any, Any, CurrentUser]]:
    """
    Build a FastAPI dependency that authorizes a request against a single permission code.

    Usage::

        @router.post("/users", dependencies=[Depends(require_permission("user.create"))])
        async def create_user(...): ...

    The permission set is read from the caller's already-verified access
    token (see ``CurrentUser.permissions``), so this performs no additional
    database query -- it is a pure in-memory set-membership check on data
    that was itself sourced from the ``role_permissions`` table at token
    issuance time.
    """

    async def _checker(current_user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
        if permission_code not in current_user.permissions:
            raise ForbiddenException(f"This action requires the {permission_code!r} permission.")
        return current_user

    return _checker
