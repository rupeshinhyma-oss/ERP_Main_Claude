"""
Central Constants.

Single source of truth for values that would otherwise be duplicated (or
worse, silently drift out of sync) across modules: generic status/role
labels, standard user-facing messages, shared regex patterns, and numeric
limits. Feature modules should import from here rather than redefining
their own copies.

Module-specific enums (e.g. ``app.users.models.UserStatus``) still live in
their own module -- this file is for values genuinely shared *across*
modules, or referenced from generic framework code (repositories, services,
validators) that has no business importing a specific feature module.
"""

from __future__ import annotations

from enum import Enum


class SortOrder(str, Enum):
    """Allowed values for the ``sort_order`` query parameter."""

    ASC = "asc"
    DESC = "desc"


class RecordStatus(str, Enum):
    """
    Generic active/inactive status label, for modules that don't need a
    richer lifecycle enum of their own (contrast with
    ``app.users.models.UserStatus``, which has PENDING/SUSPENDED too).
    """

    ACTIVE = "active"
    INACTIVE = "inactive"


class SystemRole(str, Enum):
    """Well-known role names the system itself depends on (seeded by ``scripts/seed.py``)."""

    SUPER_ADMIN = "super_admin"


class Messages:
    """Standard, reusable user-facing messages, so wording stays consistent across modules."""

    SUCCESS = "Success"
    CREATED = "Resource created successfully."
    UPDATED = "Resource updated successfully."
    DELETED = "Resource deleted successfully."
    NOT_FOUND = "The requested resource was not found."
    ALREADY_EXISTS = "A resource with these details already exists."
    VALIDATION_FAILED = "Request validation failed."
    UNAUTHORIZED = "Authentication is required."
    FORBIDDEN = "You do not have permission to perform this action."
    RATE_LIMITED = "Too many requests. Please try again later."
    INTERNAL_ERROR = "An unexpected error occurred. Please try again later."


class Regex:
    """Shared validation patterns, used by :mod:`app.common.validation` and Pydantic schemas."""

    # 3-100 chars: letters, digits, dot, underscore, hyphen. No leading/trailing separator.
    USERNAME = r"^[A-Za-z0-9](?:[A-Za-z0-9._-]{1,98}[A-Za-z0-9])?$"
    # E.164-ish phone: optional leading +, 7-15 digits.
    PHONE = r"^\+?[0-9]{7,15}$"
    # Permission code convention used by app.rbac, e.g. "user.create".
    PERMISSION_CODE = r"^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$"
    # Slug: lowercase letters, digits, hyphens.
    SLUG = r"^[a-z0-9]+(?:-[a-z0-9]+)*$"


class Limits:
    """
    Numeric limits shared across modules.

    Anything environment-tunable (page size defaults, rate-limit
    thresholds, token lifetimes, password policy) lives in
    ``app.core.config.Settings`` instead, since those genuinely vary by
    deployment. This class is for limits that are structural/code-level
    constants, not deployment configuration.
    """

    MIN_SEARCH_LENGTH = 1
    MAX_SEARCH_LENGTH = 200
    MAX_FILTER_VALUE_LENGTH = 255
    MAX_SORTABLE_FIELDS = 1  # single-column sort for now; extend to multi-column later if needed
