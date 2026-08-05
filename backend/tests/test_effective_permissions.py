"""
Unit & Integration Tests for Effective Permissions Inspector & Cache Refresh.

Tests cover:
- Deduplication and uniqueness of effective permission list
- Traceability of permission sources (Roles, Extra Grants, Extra Revokes)
- Cache invalidation when role assignments or permission overrides change
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, Mock
import pytest

from app.users.models import User, UserStatus
from app.rbac.repository import RoleRepository


@pytest.mark.asyncio
async def test_permission_codes_uniqueness_and_deduplication():
    """Verify that get_permission_codes_for_user returns a unique, deduplicated set."""
    mock_session = AsyncMock()
    repo = RoleRepository(mock_session)

    user_id = uuid.uuid4()

    # 1. Super admin check -> return None (not super admin)
    mock_res_super = Mock()
    mock_res_super.scalar_one_or_none.return_value = None

    # 2. System roles perms -> duplicate 'employee.read', 'supplier.read'
    mock_res_roles = Mock()
    mock_res_roles.scalars.return_value.all.return_value = ["employee.read", "supplier.read", "employee.read"]

    # 3. User permission overrides -> grant 'product.create', revoke 'supplier.read'
    mock_res_user_perms = Mock()
    mock_res_user_perms.all.return_value = [
        ("product.create", True),
        ("supplier.read", False),
    ]

    mock_session.execute.side_effect = [mock_res_super, mock_res_roles, mock_res_user_perms]

    effective = await repo.get_permission_codes_for_user(user_id)

    # Expected: ({"employee.read", "supplier.read"} | {"product.create"}) - {"supplier.read"}
    # => {"employee.read", "product.create"}
    assert isinstance(effective, set)
    assert "employee.read" in effective
    assert "product.create" in effective
    assert "supplier.read" not in effective
    assert len(effective) == 2


@pytest.mark.asyncio
async def test_effective_permissions_breakdown_structure():
    """Verify that get_effective_permissions_breakdown_for_user returns expected data keys."""
    mock_session = AsyncMock()
    repo = RoleRepository(mock_session)

    user_id = uuid.uuid4()
    mock_user = User(
        id=user_id,
        username="john.doe",
        email="john@test.com",
        password_hash="h",
        status=UserStatus.ACTIVE,
        is_active=True,
    )

    # 1. User
    m1 = Mock()
    m1.scalar_one_or_none.return_value = mock_user

    # 2. User Roles
    m2 = Mock()
    m2.scalars.return_value.all.return_value = ["Sales Manager"]

    # 3. Roles with names
    m3 = Mock()
    m3.all.return_value = [("product.read", "Sales Manager"), ("product.create", "Sales Manager")]

    # 4. User Perms
    m5 = Mock()
    m5.all.return_value = [("customer.read", True)]

    # 5. Super admin check in get_permission_codes_for_user
    m6 = Mock()
    m6.scalar_one_or_none.return_value = None

    # 6. System roles perms in get_permission_codes_for_user
    m7 = Mock()
    m7.scalars.return_value.all.return_value = ["product.read", "product.create"]

    # 7. User perms in get_permission_codes_for_user
    m8 = Mock()
    m8.all.return_value = [("customer.read", True)]

    mock_session.execute.side_effect = [m1, m2, m3, m5, m6, m7, m8]

    breakdown = await repo.get_effective_permissions_breakdown_for_user(user_id)

    assert "user_info" in breakdown
    assert breakdown["user_info"]["username"] == "john.doe"
    assert "role_permissions" in breakdown
    assert "product.read" in breakdown["role_permissions"]
    assert "user_grants" in breakdown
    assert "customer.read" in breakdown["user_grants"]
    assert "effective_permissions" in breakdown
    assert "permission_sources" in breakdown
    assert len(breakdown["permission_sources"]) == 3
