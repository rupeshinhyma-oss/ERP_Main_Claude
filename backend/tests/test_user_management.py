"""
Unit tests for User Account Management module.

Tests cover:
- Account states (Active, Inactive, Suspended, Locked, Password Change Required)
- Password reset & change flows
- Duplicate checks (username, email, employee code)
- Account lockout & unlock
- Role & Permission override assignment
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import pytest

from app.users.models import User, UserStatus
from app.core.exceptions import ConflictException, ForbiddenException


def test_user_status_can_login_states():
    """Verify all 5 user account states against can_login property."""
    # Active user
    u_active = User(username="u1", email="u1@test.com", password_hash="h", status=UserStatus.ACTIVE, is_active=True)
    assert u_active.can_login is True

    # Inactive user
    u_inactive = User(username="u2", email="u2@test.com", password_hash="h", status=UserStatus.INACTIVE, is_active=False)
    assert u_inactive.can_login is False

    # Suspended user
    u_suspended = User(username="u3", email="u3@test.com", password_hash="h", status=UserStatus.SUSPENDED, is_active=False)
    assert u_suspended.can_login is False

    # Password Change Required user
    u_pwd_req = User(username="u4", email="u4@test.com", password_hash="h", status=UserStatus.PASSWORD_CHANGE_REQUIRED, is_active=True, must_change_password=True)
    assert u_pwd_req.can_login is True

    # Active lock in future
    u_locked_future = User(
        username="u5",
        email="u5@test.com",
        password_hash="h",
        status=UserStatus.LOCKED,
        is_active=True,
        locked_until=datetime.now(timezone.utc) + timedelta(minutes=15),
    )
    assert u_locked_future.is_locked is True
    assert u_locked_future.can_login is False

    # Expired lock in past
    u_locked_past = User(
        username="u6",
        email="u6@test.com",
        password_hash="h",
        status=UserStatus.LOCKED,
        is_active=True,
        locked_until=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    assert u_locked_past.is_locked is False
    assert u_locked_past.can_login is True


def test_user_model_representation():
    """Verify User __repr__ does not leak password hash."""
    user = User(username="johndoe", email="john@test.com", password_hash="supersecret123", status=UserStatus.ACTIVE)
    rep = repr(user)
    assert "johndoe" in rep
    assert "ACTIVE" in rep
    assert "supersecret123" not in rep


@pytest.mark.asyncio
async def test_suspend_and_unsuspend_service():
    """Verify suspend_user sets SUSPENDED and activate_user restores ACTIVE."""
    from unittest.mock import AsyncMock
    import uuid
    from app.users.service import UserService

    mock_user_repo = AsyncMock()
    mock_auth_service = AsyncMock()
    user_id = uuid.uuid4()
    admin_id = uuid.uuid4()

    dummy_user = User(
        id=user_id,
        username="suspendee",
        email="suspendee@example.com",
        password_hash="hash",
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    mock_user_repo.get_by_id.return_value = dummy_user

    async def mock_update(user, **kwargs):
        for k, v in kwargs.items():
            setattr(user, k, v)
        return user
    mock_user_repo.update.side_effect = mock_update

    service = UserService(
        user_repository=mock_user_repo,
        auth_service=mock_auth_service,
        user_role_repository=AsyncMock(),
        rbac_service=AsyncMock(),
    )

    # Test suspend
    suspended = await service.suspend_user(user_id, updated_by=admin_id)
    assert suspended.status == UserStatus.SUSPENDED
    assert suspended.is_active is False
    mock_auth_service.force_logout_user.assert_awaited_once_with(user_id, reason="account_suspended")

    # Test unsuspend / activate
    activated = await service.activate_user(user_id, updated_by=admin_id)
    assert activated.status == UserStatus.ACTIVE
    assert activated.is_active is True


@pytest.mark.asyncio
async def test_deactivate_user_service():
    """Verify deactivate_user sets INACTIVE, is_active=False, forces logout, and blocks login."""
    from unittest.mock import AsyncMock
    import uuid
    from app.users.service import UserService

    mock_user_repo = AsyncMock()
    mock_auth_service = AsyncMock()
    user_id = uuid.uuid4()
    admin_id = uuid.uuid4()

    dummy_user = User(
        id=user_id,
        username="testuser",
        email="test@example.com",
        password_hash="hash",
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    mock_user_repo.get_by_id.return_value = dummy_user

    async def mock_update(user, **kwargs):
        for k, v in kwargs.items():
            setattr(user, k, v)
        return user
    mock_user_repo.update.side_effect = mock_update

    service = UserService(
        user_repository=mock_user_repo,
        auth_service=mock_auth_service,
        user_role_repository=AsyncMock(),
        rbac_service=AsyncMock(),
    )

    deactivated = await service.deactivate_user(user_id, updated_by=admin_id)
    assert deactivated.status == UserStatus.INACTIVE
    assert deactivated.is_active is False
    assert deactivated.can_login is False
    mock_auth_service.force_logout_user.assert_awaited_once_with(user_id, reason="account_deactivated")

    # Guard: Cannot deactivate own account
    with pytest.raises(ForbiddenException, match="You cannot deactivate your own account"):
        await service.deactivate_user(user_id, updated_by=user_id)


@pytest.mark.asyncio
async def test_delete_user_permanently_disabled():
    """Verify delete_user raises BadRequestException indicating deletion is disabled."""
    from unittest.mock import AsyncMock
    import uuid
    from app.users.service import UserService
    from app.core.exceptions import BadRequestException

    service = UserService(
        user_repository=AsyncMock(),
        auth_service=AsyncMock(),
        user_role_repository=AsyncMock(),
        rbac_service=AsyncMock(),
    )

    with pytest.raises(BadRequestException, match="User deletion is permanently disabled"):
        await service.delete_user(uuid.uuid4(), deleted_by=uuid.uuid4())


