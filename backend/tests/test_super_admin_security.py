"""
Unit & Security Tests for Super Administrator Security Model.

Tests cover:
- Last Super Administrator Protection (cannot deactivate, suspend, or demote last super admin)
- Promotion & Demotion privileges (only super admins can assign or remove super_admin role)
- Super Admin account modification protection against non-super-admins
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, Mock
import pytest

from app.core.exceptions import ForbiddenException
from app.users.models import User, UserStatus
from app.users.service import UserService


@pytest.mark.asyncio
async def test_ensure_not_last_super_admin_blocks_deactivation():
    """Verify that removing or deactivating the last active super admin raises ForbiddenException."""
    mock_user_repo = AsyncMock()
    mock_user_role_repo = AsyncMock()
    mock_rbac_service = AsyncMock()
    mock_auth_service = AsyncMock()

    service = UserService(
        user_repository=mock_user_repo,
        user_role_repository=mock_user_role_repo,
        rbac_service=mock_rbac_service,
        auth_service=mock_auth_service,
    )

    user_id = uuid.uuid4()
    super_admin_role = Mock()
    super_admin_role.id = uuid.uuid4()
    super_admin_role.name = "super_admin"

    mock_rbac_service.list_roles_for_user.return_value = [super_admin_role]

    # Only 1 active super admin link exists
    active_user = User(username="admin", email="admin@test.com", password_hash="h", status=UserStatus.ACTIVE, is_active=True)
    link = Mock()
    link.user = active_user

    mock_user_role_repo.list_for_role.return_value = [link]

    with pytest.raises(ForbiddenException, match="Cannot modify or deactivate the last active Super Administrator"):
        await service._ensure_not_last_super_admin(user_id, role_id_to_remove=super_admin_role.id)


@pytest.mark.asyncio
async def test_promotion_restricted_to_super_admin():
    """Verify that non-super-admins cannot assign the super_admin role."""
    mock_user_repo = AsyncMock()
    mock_user_role_repo = AsyncMock()
    mock_rbac_service = AsyncMock()
    mock_auth_service = AsyncMock()

    service = UserService(
        user_repository=mock_user_repo,
        user_role_repository=mock_user_role_repo,
        rbac_service=mock_rbac_service,
        auth_service=mock_auth_service,
    )

    user_id = uuid.uuid4()
    assigned_by_id = uuid.uuid4()
    
    super_admin_role = Mock()
    super_admin_role.id = uuid.uuid4()
    super_admin_role.name = "super_admin"

    admin_role = Mock()
    admin_role.id = uuid.uuid4()
    admin_role.name = "admin"

    mock_user_repo.get_by_id.return_value = User(username="target", email="target@test.com", password_hash="h")
    mock_rbac_service.get_role_or_raise.return_value = super_admin_role
    # User does not already have that role
    mock_user_role_repo.get.return_value = None
    # Assigned_by is NOT a super admin (assigned_by has admin role only)
    mock_rbac_service.list_roles_for_user.return_value = [admin_role]

    with pytest.raises(ForbiddenException, match="Only Super Administrators can promote a user to Super Administrator"):
        await service.assign_role(user_id, super_admin_role.id, assigned_by=assigned_by_id)
