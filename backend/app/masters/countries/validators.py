"""
Country Validators.

Row-level validation for CSV/Excel import, kept separate from
``service.py`` so the parsing/shape rules for one imported row are easy to
find and unit-test in isolation.
"""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def validate_country_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """Validate one raw import row and return clean field kwargs, or raise on bad data."""
    name = (raw_row.get("name") or "").strip()
    code = (raw_row.get("code") or "").strip().upper()

    if not name:
        raise BadRequestException(f"Row {row_number}: 'name' is required.")
    if not code:
        raise BadRequestException(f"Row {row_number}: 'code' is required.")

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
        "iso2": (raw_row.get("iso2") or "").strip().upper() or None,
        "iso3": (raw_row.get("iso3") or "").strip().upper() or None,
        "phone_code": (raw_row.get("phone_code") or "").strip() or None,
        "nationality": (raw_row.get("nationality") or "").strip() or None,
        "currency": (raw_row.get("currency") or "").strip().upper() or None,
        "status": status,
    }
