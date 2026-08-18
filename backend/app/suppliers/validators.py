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


def _get_field(row: dict[str, Any], *aliases: str, default: str = "") -> str:
    """Retrieve a value by trying exact keys, lowercase keys, and normalized keys."""
    for a in aliases:
        if a in row and row[a] is not None:
            v = str(row[a]).strip()
            if v:
                return v
        norm_a = a.lower().replace(" ", "_").replace("-", "_").replace("/", "_").replace("?", "")
        for k, v in row.items():
            if v is not None and str(k).strip().lower().replace(" ", "_").replace("-", "_").replace("/", "_").replace("?", "") == norm_a:
                if str(v).strip():
                    return str(v).strip()
    return default


def validate_supplier_row(raw_row: dict[str, Any], row_number: int) -> dict[str, Any]:
    """
    Validate one raw import row and return clean field kwargs, or raise on bad data.

    Supports both human-readable UI table column names and backend model keys.
    """
    company_name = _get_field(raw_row, "Company Name", "company_name", "Supplier Name", "supplier_name")
    country_code = _get_field(raw_row, "Country", "country_code", "country_name", "Country Code")
    state_name = _get_field(raw_row, "State / Province", "State", "Province", "state_name", "province")
    city_name = _get_field(raw_row, "City", "city_name")

    if not company_name:
        raise BadRequestException(f"Row {row_number}: 'Company Name' is required.")
    if not country_code:
        raise BadRequestException(f"Row {row_number}: 'Country' is required.")
    if not state_name:
        raise BadRequestException(f"Row {row_number}: 'State / Province' is required.")
    if not city_name:
        raise BadRequestException(f"Row {row_number}: 'City' is required.")

    supplier_type_raw = _get_field(raw_row, "Supplier Type", "supplier_type")
    supplier_type = supplier_type_raw or None

    grade_raw = _get_field(raw_row, "Supplier Grade", "Grade", "supplier_grade").upper()
    if grade_raw.startswith("GRADE "):
        grade_raw = grade_raw.replace("GRADE ", "").strip()
    grade = None
    if grade_raw:
        try:
            grade = SupplierGrade(grade_raw)
        except ValueError:
            pass

    status_raw = _get_field(raw_row, "Current Status", "current_status").lower()
    current_status = None
    if status_raw:
        try:
            current_status = SupplierCurrentStatus(status_raw)
        except ValueError:
            pass

    potential_raw = _get_field(raw_row, "Potential", "potential").lower()
    potential = None
    if potential_raw:
        try:
            potential = SupplierPotential(potential_raw)
        except ValueError:
            pass

    visited_raw = _get_field(raw_row, "Visited Factory/Office", "Visited Factory/Office?", "visited_factory_office").lower()
    visited_factory_office = visited_raw in ("true", "yes", "1", "y")

    status_str = _get_field(raw_row, "Status", "is_active", default="active").lower()
    is_active = status_str in ("active", "true", "yes", "1", "y")

    calling_number_raw = _get_field(raw_row, "Calling Number", "Contact Calling Number", "contact_calling_number", "Phone")
    whatsapp_number_raw = _get_field(raw_row, "WhatsApp Number", "Contact WhatsApp Number", "contact_whatsapp_number", "WhatsApp")
    wechat_number_raw = _get_field(raw_row, "WeChat Number", "Contact WeChat Number", "contact_wechat_number", "WeChat")

    calling_number = validate_phone_number(
        calling_number_raw, field_label=f"Row {row_number}: Calling Number"
    ) if calling_number_raw else None

    whatsapp_number = validate_phone_number(
        whatsapp_number_raw, field_label=f"Row {row_number}: WhatsApp Number"
    ) if whatsapp_number_raw else None

    wechat_number = validate_phone_number(
        wechat_number_raw, field_label=f"Row {row_number}: WeChat Number"
    ) if wechat_number_raw else None

    email_raw = _get_field(raw_row, "Emails", "Email", "email", "emails")
    email = validate_email_format(email_raw) if email_raw else None

    brand_desc = _get_field(raw_row, "Brand Description", "Brand", "brand_description")
    contact_name = _get_field(raw_row, "Contact Person", "Contact Person Name", "contact_full_name", "contact_person")
    designation = _get_field(raw_row, "Designation", "contact_designation")
    tax_id = _get_field(raw_row, "Tax ID / GST Number", "Tax ID Number", "tax_id_number", "GST")
    address = _get_field(raw_row, "Address", "address")
    town = _get_field(raw_row, "Town", "town")
    primary_website = _get_field(raw_row, "Primary Website", "Website", "primary_website")
    secondary_website = _get_field(raw_row, "Secondary Website", "secondary_website")
    potential_reason = _get_field(raw_row, "Potential Reason", "potential_reason")
    secondary_products = _get_field(raw_row, "Secondary Products", "secondary_products_description")
    visit_remarks = _get_field(raw_row, "Visit Remarks", "visit_remarks")
    overall_remarks = _get_field(raw_row, "Overall Remarks", "overall_remarks")

    category_names_raw = _get_field(raw_row, "Product Categories", "Category", "Categories", "category_names")
    sub_category_names_raw = _get_field(raw_row, "Key Strength Sub-Categories", "Sub-Category", "Sub Categories", "sub_category_names")
    product_names_raw = _get_field(raw_row, "Products Supplied", "Products", "product_names")

    return {
        "company_name": company_name,
        "supplier_type": supplier_type,
        "brand_description": brand_desc or None,
        "country_code": country_code,
        "state_name": state_name,
        "city_name": city_name,
        "contact_salutation": None,
        "contact_full_name": contact_name or None,
        "contact_designation": designation or None,
        "contact_calling_number": calling_number,
        "contact_whatsapp_number": whatsapp_number,
        "contact_wechat_number": wechat_number,
        "email": email,
        "tax_id_number": tax_id or None,
        "address": address or None,
        "town": town or None,
        "primary_website": primary_website or None,
        "secondary_website": secondary_website or None,
        "supplier_grade": grade,
        "current_status": current_status,
        "potential": potential,
        "potential_reason": potential_reason or None,
        "secondary_products_description": secondary_products or None,
        "visited_factory_office": visited_factory_office,
        "visit_remarks": visit_remarks or None,
        "overall_remarks": overall_remarks or None,
        "is_active": is_active,
        "category_names_raw": category_names_raw or None,
        "sub_category_names_raw": sub_category_names_raw or None,
        "product_names_raw": product_names_raw or None,
    }
