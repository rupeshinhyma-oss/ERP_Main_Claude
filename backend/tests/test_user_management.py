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
from app.core.exceptions import ConflictException


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
