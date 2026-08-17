"""Product Validators. Row-level validation for CSV/Excel import."""

from __future__ import annotations

from typing import Any

from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException


def _get_val(raw_row: dict[str, str], *keys: str) -> str:
    """Get the first non-empty value from a list of possible key aliases."""
    for k in keys:
        val = raw_row.get(k)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def _parse_optional_float_aliases(raw_row: dict[str, str], *keys: str, row_number: int) -> float | None:
    """Parse an optional numeric field using multiple key aliases."""
    raw_value = _get_val(raw_row, *keys)
    if not raw_value:
        return None
    # Strip commas or percent signs
    clean_val = raw_value.replace(",", "").replace("%", "").strip()
    try:
        return float(clean_val)
    except ValueError as exc:
        raise BadRequestException(f"Row {row_number}: {keys[0]!r} must be numeric, got {raw_value!r}.") from exc


def validate_product_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """
    Validate one raw import row and return clean field kwargs, or raise on bad data.
    Supports both human-readable Excel headers and raw API keys.
    """
    product_name = _get_val(raw_row, "Product Name (As Per Tally)", "product_name", "product_name_tally", "Product Name", "Product Name (As per Tally)")
    product_code = _get_val(raw_row, "Product Code", "product_code", "Code")
    category_code = _get_val(raw_row, "Category", "category_code", "Category Code", "category_name", "Category / Sub-Cat.")
    sub_category_code = _get_val(raw_row, "Sub Category", "Sub-Category", "Sub Cate.", "sub_category_code", "Sub-Category Code")
    brand_code = _get_val(raw_row, "Brand", "brand_code", "Brand Code", "brand_name")
    supplier_name = _get_val(raw_row, "Supplier Company Name", "supplier_name", "Supplier", "supplier_id")
    hsn_code = _get_val(raw_row, "HSN Code", "HSN", "hsn_code")
    uom_code = _get_val(raw_row, "UOM", "uom_code", "Unit of Measure", "uom_name")

    if not product_name:
        raise BadRequestException(f"Row {row_number}: Product Name is required.")
    if not category_code:
        raise BadRequestException(f"Row {row_number}: Category is required.")
    if not uom_code:
        uom_code = "PCS"  # Default fallback if blank

    # Auto-generate product code if omitted
    if not product_code:
        import random
        product_code = f"AUTO-{random.randint(10000, 99999)}"

    status_raw = _get_val(raw_row, "Status", "status") or "active"
    status_lower = status_raw.lower()
    if status_lower in ("active", "true", "1", "yes", "a"):
        status = RecordStatus.ACTIVE
    elif status_lower in ("inactive", "false", "0", "no", "i"):
        status = RecordStatus.INACTIVE
    else:
        status = RecordStatus.ACTIVE

    pack_qty = _parse_optional_float_aliases(raw_row, "Pack. Qty", "Packaging Quantity", "packaging_quantity", "pack_qty", row_number=row_number)
    net_wt = _parse_optional_float_aliases(raw_row, "Pack. Net Weight", "Packaging Net Weight (kg)", "packaging_net_weight", "Pack.Net.Weight", row_number=row_number)
    gross_wt = _parse_optional_float_aliases(raw_row, "Pack. Gross Weight", "Packaging Gross Weight (kg)", "packaging_gross_weight", "Pack. Gross Weight", "weight", row_number=row_number)
    length = _parse_optional_float_aliases(raw_row, "Length (cm)", "Length (CM)", "length_cm", "length", row_number=row_number)
    width = _parse_optional_float_aliases(raw_row, "Width (cm)", "Width (CM)", "width_cm", "width", row_number=row_number)
    height = _parse_optional_float_aliases(raw_row, "Height (cm)", "Height (CM)", "height_cm", "height", row_number=row_number)
    cbm = _parse_optional_float_aliases(raw_row, "Pack. Unit CBM", "Packaging Unit CBM", "packaging_unit_cbm", "cbm", row_number=row_number)
    refund_vat = _parse_optional_float_aliases(raw_row, "Refund VAT %", "refund_vat_percent", "Refund VAT", row_number=row_number)

    spec = _get_val(raw_row, "Specification", "specification", "Compliance & License Requirements", "Product Specification")
    desc = _get_val(raw_row, "Description", "description")
    license_req = _get_val(raw_row, "Compliance & License Requirements", "license_certificate_required")

    return {
        "product_code": product_code,
        "product_name": product_name,
        "product_name_tally": product_name,
        "supplier_name": supplier_name or None,
        "category_code": category_code,
        "sub_category_code": sub_category_code or None,
        "brand_code": brand_code or None,
        "hsn_code": hsn_code or None,
        "uom_code": uom_code,
        "specification": spec or None,
        "description": desc or None,
        "license_certificate_required": license_req or None,
        "packaging_quantity": pack_qty,
        "packaging_net_weight": net_wt,
        "packaging_gross_weight": gross_wt,
        "weight": gross_wt,
        "length_cm": length,
        "width_cm": width,
        "height_cm": height,
        "packaging_unit_cbm": cbm,
        "refund_vat_percent": refund_vat,
        "is_purchasable": True,
        "is_sellable": True,
        "status": status,
    }
