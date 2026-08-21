"""Product Sub-Category Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def validate_product_sub_category_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """
    Validate one raw import row and return clean field kwargs, or raise on bad data.

    ``category_code`` is resolved to a ``category_id`` by the service layer,
    which has DB access.
    """
    name = (raw_row.get("name") or raw_row.get("sub_category_name") or "").strip()
    code = (raw_row.get("code") or raw_row.get("sub_category_code") or "").strip()
    category_code = (
        raw_row.get("category_code") or raw_row.get("category_name") or raw_row.get("category") or ""
    ).strip()

    if not name:
        raise BadRequestException(f"Row {row_number}: 'name' (Sub-Category Name) is required.")
    if not category_code:
        raise BadRequestException(f"Row {row_number}: 'category' (Category Name) is required.")

    status_raw = (raw_row.get("status") or "active").strip().lower()
    try:
        status = RecordStatus(status_raw)
    except ValueError as exc:
        raise BadRequestException(
            f"Row {row_number}: invalid status {status_raw!r}. Must be 'active' or 'inactive'."
        ) from exc

    return {
        "code": code or None,
        "name": name,
        "category_code": category_code,
        "description": (raw_row.get("description") or "").strip() or None,
        "status": status,
    }
