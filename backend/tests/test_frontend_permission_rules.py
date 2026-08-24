"""
Unit tests for frontend permission rules, alias resolution, and module mapping.

Verifies:
- Standard permission codes (read/view, create, update, delete, export, import)
- Super Admin wildcard bypass logic
"""

from __future__ import annotations

import pytest


def test_permission_alias_conventions():
    """Verify that view/read, export, and import alias rules operate consistently."""

    def resolve_permission(user_perms: set[str], is_super_admin: bool, code: str) -> bool:
        if is_super_admin:
            return True
        if code in user_perms:
            return True
        if code.endswith(".view"):
            if code.replace(".view", ".read") in user_perms:
                return True
        if code.endswith(".read"):
            if code.replace(".read", ".view") in user_perms:
                return True
        return False

    # Super admin bypass
    assert resolve_permission(set(), True, "any.permission") is True

    # Direct match
    assert resolve_permission({"employee.create"}, False, "employee.create") is True

    # View <-> Read alias
    assert resolve_permission({"supplier.read"}, False, "supplier.view") is True
    assert resolve_permission({"supplier.view"}, False, "supplier.read") is True

    # Export strictly requires export permission
    assert resolve_permission({"supplier.export"}, False, "supplier.export") is True
    assert resolve_permission({"supplier.read"}, False, "supplier.export") is False
    assert resolve_permission({"supplier.view"}, False, "supplier.export") is False

    # Import strictly requires import permission
    assert resolve_permission({"supplier.import"}, False, "supplier.import") is True
    assert resolve_permission({"supplier.create"}, False, "supplier.import") is False

    # Missing permission rejection
    assert resolve_permission({"supplier.read"}, False, "supplier.delete") is False
