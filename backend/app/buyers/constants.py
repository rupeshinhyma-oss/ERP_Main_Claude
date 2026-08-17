"""Buyer Constants."""

from __future__ import annotations

MODULE_NAME = "buyer"

# Document: "Calling Number (with country code) maximum 10 digit
# restriction to give" -- applied to both Calling and WhatsApp numbers
# ("Whatsapp Number ... same as above"). The document gives only the
# upper bound; a lower bound of 6 is assumed here to reject obviously
# invalid entries (e.g. a lone "0") without being stricter than specified.
PHONE_MIN_DIGITS = 6
PHONE_MAX_DIGITS = 15

DEFAULT_SALUTATIONS = ("Mr.", "Mrs.", "Ms.", "Dr.")

EXPORT_HEADERS = [
    "Company Name",
    "Buyer Type",
    "Product Categories",
    "Product Sub Categories",
    "Country",
    "City",
    "Address",
    "Contact Salutation",
    "Contact Person Name",
    "Designation",
    "Calling Number",
    "WhatsApp Number",
    "Emails",
    "Tax ID / GST Number",
    "Website",
    "Current Status",
    "Buyer Grade",
    "Potential",
    "Potential Reason",
    "Product Range",
    "Currently Buying From",
    "Overall Remarks",
    "Status",
]

IMPORT_HEADERS = EXPORT_HEADERS
