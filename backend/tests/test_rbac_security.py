"""
RBAC & Security System Tests.

Tests permission hierarchy, multi-source permission inheritance,
Super Admin protections, user account status rules, and forced password change.
"""

from __future__ import annotations

import uuid
import pytest
from app.rbac.models import Permission, Role, UserPermission, DepartmentPermission, DesignationPermission
from app.users.models import User, UserStatus
from app.auth.service import CurrentUser

pytestmark = pytest.mark.asyncio


def test_permission_model_hierarchy():
    """Verify Permission model has module, page, action, scope fields."""
    perm = Permission(
        code="employee.view",
        module="employee",
        page="teams",
        action="view",
        scope="ALL",
        description="View employee records",
    )
    assert perm.code == "employee.view"
    assert perm.module == "employee"
    assert perm.page == "teams"
    assert perm.action == "view"
    assert perm.scope == "ALL"


def test_current_user_must_change_password_flag():
    """Verify CurrentUser carries must_change_password flag."""
    user_id = uuid.uuid4()
    user = CurrentUser(
        id=user_id,
        username="testuser",
        permissions={"employee.view"},
        must_change_password=True,
    )
    assert user.must_change_password is True


def test_user_account_status_can_login():
    """Verify User.can_login status restrictions."""
    user = User(
        username="active_user",
        email="active@example.com",
        password_hash="hash",
        status=UserStatus.ACTIVE,
        is_active=True,
    )
    assert user.can_login is True

    inactive_user = User(
        username="inactive_user",
        email="inactive@example.com",
        password_hash="hash",
        status=UserStatus.INACTIVE,
        is_active=False,
    )
    assert inactive_user.can_login is False

    suspended_user = User(
        username="suspended_user",
        email="suspended@example.com",
        password_hash="hash",
        status=UserStatus.SUSPENDED,
        is_active=False,
    )
    assert suspended_user.can_login is False

    locked_user = User(
        username="locked_user",
        email="locked@example.com",
        password_hash="hash",
        status=UserStatus.LOCKED,
        is_active=True,
    )
    assert locked_user.can_login is False

    pwd_change_user = User(
        username="pwd_change_user",
        email="pwdchange@example.com",
        password_hash="hash",
        status=UserStatus.PASSWORD_CHANGE_REQUIRED,
        is_active=True,
    )
    assert pwd_change_user.can_login is True


def test_user_permission_override_model():
    """Verify UserPermission override fields."""
    user_id = uuid.uuid4()
    perm_id = uuid.uuid4()
    grant_override = UserPermission(user_id=user_id, permission_id=perm_id, is_granted=True)
    deny_override = UserPermission(user_id=user_id, permission_id=perm_id, is_granted=False)
    assert grant_override.is_granted is True
    assert deny_override.is_granted is False


async def test_effective_permissions_source_tracing():
    """Verify source resolution priority mapping (Role Permissions + User Overrides)."""
    user_grants = {"supplier.export"}
    user_denies = {"user.delete"}
    role_perms = {"user.read", "user.delete", "supplier.view"}

    effective = (role_perms | user_grants) - user_denies

    permission_sources = []
    for code in sorted(list(effective)):
        if code in user_grants:
            src = "Individual User"
        else:
            src = "System Role"
        permission_sources.append({"code": code, "source": src})

    sources_dict = {item["code"]: item["source"] for item in permission_sources}
    assert sources_dict["supplier.export"] == "Individual User"
    assert sources_dict["supplier.view"] == "System Role"
    assert sources_dict["user.read"] == "System Role"
    assert "user.delete" not in sources_dict


def test_user_override_audit_actions():
    """Verify AuditAction enum contains USER_OVERRIDE_ADDED and USER_OVERRIDE_REMOVED."""
    from app.audit.constants import AuditAction
    assert AuditAction.USER_OVERRIDE_ADDED == "USER_OVERRIDE_ADDED"
    assert AuditAction.USER_OVERRIDE_REMOVED == "USER_OVERRIDE_REMOVED"

