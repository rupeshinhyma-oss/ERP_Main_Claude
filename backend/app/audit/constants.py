"""
Audit Constants.

Defines the closed set of audit action types (:class:`AuditAction`) and the
list of sensitive field names that must never be persisted to the audit
log in plain form (see :mod:`app.audit.masking`).
"""

from __future__ import annotations

from enum import Enum


class AuditAction(str, Enum):
    """The closed set of actions the audit log can record.

    Kept as a single enum (rather than a free-text string) so that every
    caller, the database column, and API filters agree on exactly the same
    vocabulary -- see the Phase 3 spec's required action list.
    """

    CREATE = "CREATE"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    LOGIN = "LOGIN"
    LOGIN_FAILED = "LOGIN_FAILED"
    LOGOUT = "LOGOUT"
    PASSWORD_CHANGE = "PASSWORD_CHANGE"
    PASSWORD_RESET = "PASSWORD_RESET"
    ROLE_ASSIGNED = "ROLE_ASSIGNED"
    ROLE_REMOVED = "ROLE_REMOVED"
    IMPORT = "IMPORT"
    EXPORT = "EXPORT"
    FILE_UPLOAD = "FILE_UPLOAD"
    FILE_DELETE = "FILE_DELETE"
    OTHER = "OTHER"


# Field names (case-insensitive, matched anywhere in a nested payload) that
# must never appear in an audit log's old/new values in plain form. Matched
# against dict keys recursively by app.audit.masking.mask_sensitive_data.
SENSITIVE_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "password",
        "current_password",
        "new_password",
        "confirm_password",
        "temporary_password",
        "password_hash",
        "hashed_password",
        "token",
        "access_token",
        "refresh_token",
        "id_token",
        "jwt",
        "secret",
        "client_secret",
        "api_key",
        "apikey",
        "authorization",
        "jti",
    }
)

MASKED_VALUE = "***MASKED***"

# Hard cap on how many characters of a single field's JSON-encoded value are
# kept, so one giant payload (e.g. a bulk import body) cannot blow up the
# audit_logs table or the response payload of the audit list API.
MAX_FIELD_VALUE_LENGTH = 2000
