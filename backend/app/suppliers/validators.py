"""
Supplier Validators.

Phone-number digit-count validation (the document's "7 to 11 digit
allowed" rule) and row-level validation for CSV/Excel import.
"""

from __future__ import annotations

import re
from typing import Any

from app.core.exceptions import BadRequestException
from app.suppliers.constants import PHONE_MAX_DIGITS, PHONE_MIN_DIGITS
from app.suppliers.models import SupplierCurrentStatus, SupplierGrade, SupplierPotential, SupplierType

_DIGITS_ONLY = re.compile(r"\D+")


def validate_phone_number(value: str | None, *, field_label: str) -> str | None:
    """
    Validate a phone/WhatsApp/WeChat number against the document's digit-count rule.

    Accepts an optional leading "+" and country code; only the digit count
    (ignoring separators like spaces, dashes, or parentheses) is checked,
    per the document: "maximum 11 digit restriction... (7 to 11 digit
    allowed)". Returns the value unchanged (not reformatted) so the
    country-code prefix the user entered is preserved.
    """
    if value is None or not value.strip():
        return None
    digit_count = len(_DIGITS_ONLY.sub("", value))
    if digit_count < PHONE_MIN_DIGITS or digit_count > PHONE_MAX_DIGITS:
        raise BadRequestException(
            f"{field_label} must have between {PHONE_MIN_DIGITS} and {PHONE_MAX_DIGITS} digits "
            f"(including country code); got {digit_count}."
        )
    return value.strip()


def validate_email_format(value: str) -> str:
    """Minimal, dependency-free email shape check (full RFC validation is out of scope)."""
    value = value.strip()
    if "@" not in value or value.startswith("@") or value.endswith("@"):
        raise BadRequestException(f"{value!r} is not a valid email address.")
    return value


def validate_supplier_row(raw_row: dict[str, str], row_number: int) -> dict[str, Any]:
    """
    Validate one raw import row and return clean field kwargs, or raise on bad data.

    Country/state/city are resolved from codes/names to IDs by the service
    layer (which has DB access); this function only validates shape.
    """
    company_name = (raw_row.get("company_name") or "").strip()
    country_code = (raw_row.get("country_code") or "").strip().upper()
    state_name = (raw_row.get("state_name") or "").strip()
    city_name = (raw_row.get("city_name") or "").strip()

    if not company_name:
        raise BadRequestException(f"Row {row_number}: 'company_name' is required.")
    if not country_code:
        raise BadRequestException(f"Row {row_number}: 'country_code' is required.")
    if not state_name:
        raise BadRequestException(f"Row {row_number}: 'state_name' is required.")
    if not city_name:
        raise BadRequestException(f"Row {row_number}: 'city_name' is required.")

    supplier_type_raw = (raw_row.get("supplier_type") or "").strip().lower()
    supplier_type = None
    if supplier_type_raw:
        try:
            supplier_type = SupplierType(supplier_type_raw)
        except ValueError as exc:
            raise BadRequestException(
                f"Row {row_number}: invalid supplier_type {supplier_type_raw!r}."
            ) from exc

    grade_raw = (raw_row.get("supplier_grade") or "").strip().upper()
    grade = None
    if grade_raw:
        try:
            grade = SupplierGrade(grade_raw)
        except ValueError as exc:
            raise BadRequestException(f"Row {row_number}: invalid supplier_grade {grade_raw!r}.") from exc

    status_raw = (raw_row.get("current_status") or "").strip().lower()
    current_status = None
    if status_raw:
        try:
            current_status = SupplierCurrentStatus(status_raw)
        except ValueError as exc:
            raise BadRequestException(f"Row {row_number}: invalid current_status {status_raw!r}.") from exc

    potential_raw = (raw_row.get("potential") or "").strip().lower()
    potential = None
    if potential_raw:
        try:
            potential = SupplierPotential(potential_raw)
        except ValueError as exc:
            raise BadRequestException(f"Row {row_number}: invalid potential {potential_raw!r}.") from exc

    visited_raw = (raw_row.get("visited_factory_office") or "").strip().lower()
    visited_factory_office = visited_raw in ("true", "yes", "1", "y")

    is_active_raw = (raw_row.get("is_active") or "true").strip().lower()
    is_active = is_active_raw in ("true", "yes", "1", "y")

    calling_number = validate_phone_number(
        raw_row.get("contact_calling_number"), field_label=f"Row {row_number}: contact_calling_number"
    )
    whatsapp_number = validate_phone_number(
        raw_row.get("contact_whatsapp_number"), field_label=f"Row {row_number}: contact_whatsapp_number"
    )
    wechat_number = validate_phone_number(
        raw_row.get("contact_wechat_number"), field_label=f"Row {row_number}: contact_wechat_number"
    )

    email_raw = (raw_row.get("email") or "").strip()
    email = validate_email_format(email_raw) if email_raw else None

    return {
        "company_name": company_name,
        "supplier_type": supplier_type,
        "brand_description": (raw_row.get("brand_description") or "").strip() or None,
        "country_code": country_code,
        "state_name": state_name,
        "city_name": city_name,
        "contact_salutation": (raw_row.get("contact_salutation") or "").strip() or None,
        "contact_full_name": (raw_row.get("contact_full_name") or "").strip() or None,
        "contact_designation": (raw_row.get("contact_designation") or "").strip() or None,
        "contact_calling_number": calling_number,
        "contact_whatsapp_number": whatsapp_number,
        "contact_wechat_number": wechat_number,
        "email": email,
        "tax_id_number": (raw_row.get("tax_id_number") or "").strip() or None,
        "address": (raw_row.get("address") or "").strip() or None,
        "town": (raw_row.get("town") or "").strip() or None,
        "primary_website": (raw_row.get("primary_website") or "").strip() or None,
        "secondary_website": (raw_row.get("secondary_website") or "").strip() or None,
        "supplier_grade": grade,
        "current_status": current_status,
        "potential": potential,
        "potential_reason": (raw_row.get("potential_reason") or "").strip() or None,
        "secondary_products_description": (raw_row.get("secondary_products_description") or "").strip() or None,
        "visited_factory_office": visited_factory_office,
        "visit_remarks": (raw_row.get("visit_remarks") or "").strip() or None,
        "overall_remarks": (raw_row.get("overall_remarks") or "").strip() or None,
        "is_active": is_active,
    }
