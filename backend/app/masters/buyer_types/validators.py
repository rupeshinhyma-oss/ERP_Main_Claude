"""BuyerType row validation logic for bulk import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus


def validate_buyer_type_row(row: dict[str, Any]) -> dict[str, Any]:
    """Validate and clean a single raw row from CSV/Excel import."""
    cleaned: dict[str, Any] = {}

    name = str(row.get("name") or "").strip()
    if not name:
        raise ValueError("Name is required.")
    cleaned["name"] = name

    code = str(row.get("code") or "").strip()
    if code:
        cleaned["code"] = code

    desc = str(row.get("description") or "").strip()
    if desc:
        cleaned["description"] = desc

    raw_status = str(row.get("status") or "").strip().lower()
    if raw_status in ("inactive", "0", "disabled"):
        cleaned["status"] = RecordStatus.INACTIVE
    else:
        cleaned["status"] = RecordStatus.ACTIVE

    return cleaned
