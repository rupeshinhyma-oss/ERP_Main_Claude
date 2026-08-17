"""
Buyer Validators.

Phone-number digit-count validation (the document's "maximum 10 digit
restriction" rule). Mirrors :mod:`app.suppliers.validators` exactly, with
buyer-specific digit bounds (see :mod:`app.buyers.constants`).
"""

from __future__ import annotations

import re
from typing import Any

from app.buyers.constants import PHONE_MAX_DIGITS, PHONE_MIN_DIGITS
from app.core.exceptions import BadRequestException

_DIGITS_ONLY = re.compile(r"\D+")


def validate_phone_number(value: str | None, *, field_label: str) -> str | None:
    """
    Validate a calling/WhatsApp number against the document's digit-count rule.

    Accepts an optional leading "+" and country code; only the digit count
    (ignoring separators like spaces, dashes, or parentheses) is checked.
    Returns the value unchanged (not reformatted) so the country-code
    prefix the user entered is preserved.
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


def validate_buyer_row(raw_row: dict[str, Any], row_number: int) -> dict[str, Any]:
    """Validate one raw import row and return clean field kwargs, or raise on bad data."""
    from typing import Any
    from app.buyers.models import BuyerCurrentStatus, BuyerGrade, BuyerPotential

    company_name = _get_field(raw_row, "Company Name", "company_name", "Buyer Name", "buyer_name", "Client Name")
    country_raw = _get_field(raw_row, "Country", "country_code", "country_name", "Country Code")

    if not company_name:
        raise BadRequestException(f"Row {row_number}: 'Company Name' is required.")
    if not country_raw:
        raise BadRequestException(f"Row {row_number}: 'Country' is required.")

    buyer_type_raw = _get_field(raw_row, "Buyer Type", "buyer_type")

    city = _get_field(raw_row, "City", "city_name")
    address = _get_field(raw_row, "Address", "address")
    salutation = _get_field(raw_row, "Contact Salutation", "Salutation", "contact_salutation")
    contact_name = _get_field(raw_row, "Contact Person Name", "Contact Person", "contact_full_name", "contact_person")
    designation = _get_field(raw_row, "Designation", "contact_designation")
    tax_id = _get_field(raw_row, "Tax ID / GST Number", "Tax ID Number", "tax_id_number", "GST")
    website = _get_field(raw_row, "Website", "primary_website", "website")
    product_range = _get_field(raw_row, "Product Range", "product_range")
    currently_buying_from = _get_field(raw_row, "Currently Buying From", "currently_buying_from")
    overall_remarks = _get_field(raw_row, "Overall Remarks", "overall_remarks")

    grade_raw = _get_field(raw_row, "Buyer Grade", "Grade", "buyer_grade").upper()
    if grade_raw.startswith("GRADE "):
        grade_raw = grade_raw.replace("GRADE ", "").strip()
    grade = None
    if grade_raw:
        try:
            grade = BuyerGrade(grade_raw)
        except ValueError:
            pass

    status_raw = _get_field(raw_row, "Current Status", "current_status").lower()
    current_status = None
    if status_raw:
        try:
            current_status = BuyerCurrentStatus(status_raw)
        except ValueError:
            pass

    potential_raw = _get_field(raw_row, "Potential", "potential").lower()
    potential = None
    if potential_raw:
        try:
            potential = BuyerPotential(potential_raw)
        except ValueError:
            pass

    potential_reason = _get_field(raw_row, "Potential Reason", "potential_reason")

    status_str = _get_field(raw_row, "Status", "is_active", default="active").lower()
    is_active = status_str in ("active", "true", "yes", "1", "y")

    calling_number_raw = _get_field(raw_row, "Calling Number", "Contact Calling Number", "contact_calling_number", "Phone")
    whatsapp_number_raw = _get_field(raw_row, "WhatsApp Number", "Contact WhatsApp Number", "contact_whatsapp_number", "WhatsApp")

    calling_number = validate_phone_number(
        calling_number_raw, field_label=f"Row {row_number}: Calling Number"
    ) if calling_number_raw else None

    whatsapp_number = validate_phone_number(
        whatsapp_number_raw, field_label=f"Row {row_number}: WhatsApp Number"
    ) if whatsapp_number_raw else None

    emails_raw = _get_field(raw_row, "Emails", "Email", "email", "emails")
    emails = []
    if emails_raw:
        for em in emails_raw.split(","):
            em_clean = em.strip()
            if em_clean:
                emails.append(validate_email_format(em_clean))

    category_names_raw = _get_field(raw_row, "Product Categories", "Category", "Categories", "category_names")
    sub_category_names_raw = _get_field(raw_row, "Product Sub Categories", "Key Strength Sub-Categories", "Sub-Category", "Sub Categories", "sub_category_names")

    return {
        "company_name": company_name,
        "buyer_type": buyer_type_raw or None,
        "country_raw": country_raw,
        "city": city or None,
        "address": address or None,
        "contact_salutation": salutation or None,
        "contact_full_name": contact_name or None,
        "contact_designation": designation or None,
        "contact_calling_number": calling_number,
        "contact_whatsapp_number": whatsapp_number,
        "emails": emails,
        "tax_id_number": tax_id or None,
        "website": website or None,
        "current_status": current_status,
        "buyer_grade": grade,
        "potential": potential,
        "potential_reason": potential_reason or None,
        "product_range": product_range or None,
        "currently_buying_from": currently_buying_from or None,
        "overall_remarks": overall_remarks or None,
        "is_active": is_active,
        "category_names_raw": category_names_raw or None,
        "sub_category_names_raw": sub_category_names_raw or None,
    }
