"""Brand Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def validate_brand_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """Validate one raw import row and return clean field kwargs, or raise on bad data."""
    name = (raw_row.get("name") or "").strip()
    code = (raw_row.get("code") or "").strip()

    if not name:
        raise BadRequestException(f"Row {row_number}: 'name' is required.")
    if not code:
        import re
        code = "BR-" + re.sub(r"[^A-Z0-9]", "", name.upper())[:8]

    status_raw = (raw_row.get("status") or "active").strip().lower()
    try:
        status = RecordStatus(status_raw)
    except ValueError as exc:
        raise BadRequestException(
            f"Row {row_number}: invalid status {status_raw!r}. Must be 'active' or 'inactive'."
        ) from exc

    return {
        "name": name,
        "code": code,
        "description": (raw_row.get("description") or "").strip() or None,
        "logo_url": (raw_row.get("logo_url") or "").strip() or None,
        "status": status,
    }
