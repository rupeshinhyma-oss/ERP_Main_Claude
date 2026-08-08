"""
Buyer Validators.

Phone-number digit-count validation (the document's "maximum 10 digit
restriction" rule). Mirrors :mod:`app.suppliers.validators` exactly, with
buyer-specific digit bounds (see :mod:`app.buyers.constants`).
"""

from __future__ import annotations

import re

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
