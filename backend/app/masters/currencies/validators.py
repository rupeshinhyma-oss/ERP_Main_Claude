"""Currency Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def validate_currency_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """Validate one raw import row and return clean field kwargs, or raise on bad data."""
    name = (raw_row.get("name") or "").strip()
    code = (raw_row.get("code") or "").strip().upper()

    if not name:
        raise BadRequestException(f"Row {row_number}: 'name' is required.")
    if not code:
        raise BadRequestException(f"Row {row_number}: 'code' is required.")

    decimal_places_raw = (raw_row.get("decimal_places") or "2").strip()
    try:
        decimal_places = int(decimal_places_raw)
    except ValueError as exc:
        raise BadRequestException(f"Row {row_number}: 'decimal_places' must be an integer.") from exc
    if decimal_places < 0 or decimal_places > 6:
        raise BadRequestException(f"Row {row_number}: 'decimal_places' must be between 0 and 6.")

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
        "symbol": (raw_row.get("symbol") or "").strip() or None,
        "decimal_places": decimal_places,
        "status": status,
    }
