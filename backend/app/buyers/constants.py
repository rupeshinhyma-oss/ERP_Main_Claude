"""Buyer Constants."""

from __future__ import annotations

MODULE_NAME = "buyer"

# Document: "Calling Number (with country code) maximum 10 digit
# restriction to give" -- applied to both Calling and WhatsApp numbers
# ("Whatsapp Number ... same as above"). The document gives only the
# upper bound; a lower bound of 6 is assumed here to reject obviously
# invalid entries (e.g. a lone "0") without being stricter than specified.
PHONE_MIN_DIGITS = 6
PHONE_MAX_DIGITS = 10

DEFAULT_SALUTATIONS = ("Mr.", "Mrs.", "Ms.")
