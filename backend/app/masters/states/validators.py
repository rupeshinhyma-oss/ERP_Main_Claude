"""State Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def validate_state_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """
    Validate one raw import row and return clean field kwargs, or raise on bad data.

    Note: ``country_code`` is resolved to a ``country_id`` by the service
    layer (which has DB access), not here -- this function is pure/DB-free
    so it can be unit-tested without a database.
    """
    name = (raw_row.get("name") or "").strip()
    country_code = (raw_row.get("country_code") or "").strip().upper()

    if not name:
        raise BadRequestException(f"Row {row_number}: 'name' is required.")
    if not country_code:
        raise BadRequestException(f"Row {row_number}: 'country_code' is required.")

    status_raw = (raw_row.get("status") or "active").strip().lower()
    try:
        status = RecordStatus(status_raw)
    except ValueError as exc:
        raise BadRequestException(
            f"Row {row_number}: invalid status {status_raw!r}. Must be 'active' or 'inactive'."
        ) from exc

    return {
        "name": name,
        "country_code": country_code,
        "code": (raw_row.get("code") or "").strip() or None,
        "status": status,
    }
