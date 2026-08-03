"""HSN Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def validate_hsn_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """Validate one raw import row and return clean field kwargs, or raise on bad data."""
    code = (raw_row.get("code") or "").strip()

    if not code:
        raise BadRequestException(f"Row {row_number}: 'code' is required.")

    gst_raw = (raw_row.get("gst_percent") or "0").strip()
    try:
        gst_percent = float(gst_raw)
    except ValueError as exc:
        raise BadRequestException(f"Row {row_number}: 'gst_percent' must be numeric.") from exc
    if gst_percent < 0 or gst_percent > 100:
        raise BadRequestException(f"Row {row_number}: 'gst_percent' must be between 0 and 100.")

    status_raw = (raw_row.get("status") or "active").strip().lower()
    try:
        status = RecordStatus(status_raw)
    except ValueError as exc:
        raise BadRequestException(
            f"Row {row_number}: invalid status {status_raw!r}. Must be 'active' or 'inactive'."
        ) from exc

    return {
        "code": code,
        "description": (raw_row.get("description") or "").strip() or None,
        "gst_percent": gst_percent,
        "status": status,
    }
