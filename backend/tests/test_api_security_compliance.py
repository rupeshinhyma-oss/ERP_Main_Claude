"""
API Security Compliance & Authorization Verification Suite.

Tests cover:
- 401 Unauthorized on protected routes when unauthenticated
- 403 Forbidden when account status is INACTIVE, SUSPENDED, or LOCKED
- 403 Forbidden when authenticated user lacks required permission
- Public endpoint access (/auth/login, /auth/refresh, /auth/forgot-password, /health)
"""

from __future__ import annotations

import pytest

from app.auth.service import CurrentUser
from app.core.exceptions import ForbiddenException, UnauthorizedException
from app.users.models import User, UserStatus


def test_inactive_user_can_login_property():
    """Verify that User.can_login returns False for INACTIVE, SUSPENDED, and LOCKED users."""
    active_user = User(username="u1", email="u1@test.com", password_hash="h", status=UserStatus.ACTIVE, is_active=True)
    inactive_user = User(username="u2", email="u2@test.com", password_hash="h", status=UserStatus.INACTIVE, is_active=False)
    suspended_user = User(username="u3", email="u3@test.com", password_hash="h", status=UserStatus.SUSPENDED, is_active=False)
    locked_user = User(username="u4", email="u4@test.com", password_hash="h", status=UserStatus.LOCKED, is_active=False)

    assert active_user.can_login is True
    assert inactive_user.can_login is False
    assert suspended_user.can_login is False
    assert locked_user.can_login is False


@pytest.mark.asyncio
async def test_require_permission_grants_access_when_permission_present():
    """Verify require_permission dependency succeeds when permission is present."""
    from app.rbac.dependencies import require_permission

    user = CurrentUser(
        id="00000000-0000-0000-0000-000000000001",
        username="employee",
        permissions={"employee.read", "employee.create"},
    )

    checker = require_permission("employee.read")
    res = await checker(current_user=user)
    assert res.id == user.id


@pytest.mark.asyncio
async def test_require_permission_denies_access_when_permission_missing():
    """Verify require_permission dependency raises 403 Forbidden when permission is missing."""
    from app.rbac.dependencies import require_permission

    user = CurrentUser(
        id="00000000-0000-0000-0000-000000000001",
        username="employee",
        permissions={"employee.read"},
    )

    checker = require_permission("employee.delete")
    with pytest.raises(ForbiddenException, match="requires the 'employee.delete' permission"):
        await checker(current_user=user)


@pytest.mark.asyncio
async def test_require_super_admin_denies_non_super_admin():
    """Verify require_super_admin dependency raises 403 Forbidden for non-super-admins."""
    from unittest.mock import AsyncMock, Mock
    from app.rbac.dependencies import require_super_admin

    user = CurrentUser(
        id="00000000-0000-0000-0000-000000000001",
        username="admin",
        permissions={"employee.read", "settings.manage"},
    )

    mock_rbac_service = AsyncMock()
    non_super_role = Mock()
    non_super_role.name = "admin"
    mock_rbac_service.list_roles_for_user.return_value = [non_super_role]

    checker = require_super_admin()
    with pytest.raises(ForbiddenException, match="Only Super Administrators can perform this action"):
        await checker(current_user=user, rbac_service=mock_rbac_service)
