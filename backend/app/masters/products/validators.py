"""Product Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def _parse_optional_float(raw_row: dict[str, str], key: str, row_number: int) -> float | None:
    """Parse an optional numeric field, returning None if blank, or raising on bad data."""
    raw_value = (raw_row.get(key) or "").strip()
    if not raw_value:
        return None
    try:
        return float(raw_value)
    except ValueError as exc:
        raise BadRequestException(f"Row {row_number}: {key!r} must be numeric.") from exc


def _parse_optional_bool(raw_row: dict[str, str], key: str, default: bool) -> bool:
    """Parse an optional boolean-ish field ('true'/'yes'/'1' etc.), defaulting if blank."""
    raw_value = (raw_row.get(key) or "").strip().lower()
    if not raw_value:
        return default
    return raw_value in ("true", "yes", "1", "y")


def validate_product_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """
    Validate one raw import row and return clean field kwargs, or raise on bad data.

    ``category_code``/``sub_category_code``/``brand_code``/``hsn_code``/
    ``uom_code``/``secondary_uom_code`` are resolved to IDs by the service
    layer, which has DB access.
    """
    product_code = (raw_row.get("product_code") or "").strip()
    product_name = (raw_row.get("product_name") or "").strip()
    category_code = (raw_row.get("category_code") or "").strip()
    uom_code = (raw_row.get("uom_code") or "").strip()

    if not product_code:
        raise BadRequestException(f"Row {row_number}: 'product_code' is required.")
    if not product_name:
        raise BadRequestException(f"Row {row_number}: 'product_name' is required.")
    if not category_code:
        raise BadRequestException(f"Row {row_number}: 'category_code' is required.")
    if not uom_code:
        raise BadRequestException(f"Row {row_number}: 'uom_code' is required.")

    status_raw = (raw_row.get("status") or "active").strip().lower()
    try:
        status = RecordStatus(status_raw)
    except ValueError as exc:
        raise BadRequestException(
            f"Row {row_number}: invalid status {status_raw!r}. Must be 'active' or 'inactive'."
        ) from exc

    return {
        "product_code": product_code,
        "product_name": product_name,
        "barcode": (raw_row.get("barcode") or "").strip() or None,
        "category_code": category_code,
        "sub_category_code": (raw_row.get("sub_category_code") or "").strip() or None,
        "brand_code": (raw_row.get("brand_code") or "").strip() or None,
        "hsn_code": (raw_row.get("hsn_code") or "").strip() or None,
        "uom_code": uom_code,
        "secondary_uom_code": (raw_row.get("secondary_uom_code") or "").strip() or None,
        "specification": (raw_row.get("specification") or "").strip() or None,
        "description": (raw_row.get("description") or "").strip() or None,
        "weight": _parse_optional_float(raw_row, "weight", row_number),
        "length": _parse_optional_float(raw_row, "length", row_number),
        "width": _parse_optional_float(raw_row, "width", row_number),
        "height": _parse_optional_float(raw_row, "height", row_number),
        "color": (raw_row.get("color") or "").strip() or None,
        "material": (raw_row.get("material") or "").strip() or None,
        "conversion_factor": _parse_optional_float(raw_row, "conversion_factor", row_number),
        "minimum_order_quantity": _parse_optional_float(raw_row, "minimum_order_quantity", row_number),
        "reorder_level": _parse_optional_float(raw_row, "reorder_level", row_number),
        "standard_cost": _parse_optional_float(raw_row, "standard_cost", row_number),
        "standard_price": _parse_optional_float(raw_row, "standard_price", row_number),
        "is_purchasable": _parse_optional_bool(raw_row, "is_purchasable", True),
        "is_sellable": _parse_optional_bool(raw_row, "is_sellable", True),
        "status": status,
    }
