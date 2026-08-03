"""
Sensitive-Field Masking.

Every value written into ``audit_logs.old_values`` / ``audit_logs.new_values``
must pass through :func:`mask_sensitive_data` first. This is the single
choke point that guarantees passwords, hashes, tokens, and secrets never
land in the audit trail, regardless of which module or route triggered the
audit entry.
"""

from __future__ import annotations

import json
from typing import Any

from app.audit.constants import MASKED_VALUE, MAX_FIELD_VALUE_LENGTH, SENSITIVE_FIELD_NAMES


def _is_sensitive_key(key: str) -> bool:
    """Return True if a field name is considered sensitive (case-insensitive, substring match)."""
    lowered = key.lower()
    return any(sensitive in lowered for sensitive in SENSITIVE_FIELD_NAMES)


def mask_sensitive_data(value: Any) -> Any:
    """
    Recursively mask sensitive keys in a dict/list structure.

    Non-container values are returned unchanged. Dict keys matching
    :data:`SENSITIVE_FIELD_NAMES` (case-insensitively, substring match, e.g.
    ``"new_password"`` matches ``"password"``) have their value replaced
    with :data:`MASKED_VALUE` without recursing into it (so a nested secret
    object doesn't leak any of its own children either).
    """
    if isinstance(value, dict):
        masked: dict[str, Any] = {}
        for key, val in value.items():
            if _is_sensitive_key(str(key)):
                masked[key] = MASKED_VALUE
            else:
                masked[key] = mask_sensitive_data(val)
        return masked
    if isinstance(value, list):
        return [mask_sensitive_data(item) for item in value]
    return value


def to_safe_json(value: Any) -> str | None:
    """
    Mask, then serialize a value to a length-capped JSON string for storage.

    Returns ``None`` for ``None`` input (so the DB column stays NULL rather
    than storing the literal string ``"null"``). Falls back to
    ``str(value)`` if the value is not JSON-serializable (e.g. an ORM
    instance was passed by mistake), so audit writes never raise and block
    the underlying business action.
    """
    if value is None:
        return None
    masked = mask_sensitive_data(value)
    try:
        text = json.dumps(masked, default=str, ensure_ascii=False)
    except (TypeError, ValueError):
        text = str(masked)
    if len(text) > MAX_FIELD_VALUE_LENGTH:
        text = text[:MAX_FIELD_VALUE_LENGTH] + "...(truncated)"
    return text
