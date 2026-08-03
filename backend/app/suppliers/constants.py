"""Supplier Constants."""

from __future__ import annotations

MODULE_NAME = "suppliers"

# Document: "Calling Number (with Country Code & number of Digits based on
# country selected) - Also, maximum 11 digit restriction to give. (7 to 11
# digit allowed)". Applied to calling/WhatsApp/WeChat numbers alike ("same
# as above" for each, per the document). Deliberately separate from the
# generic app.core.constants.Regex.PHONE (7-15 digits, used elsewhere in
# the app) since this module's rule is specifically 7-11 digits.
PHONE_MIN_DIGITS = 7
PHONE_MAX_DIGITS = 11

DEFAULT_SALUTATIONS = ("Mr.", "Mrs.", "Ms.")

IMPORT_HEADERS = [
    "company_name",
    "supplier_type",
    "brand_description",
    "country_code",
    "state_name",
    "city_name",
    "contact_salutation",
    "contact_full_name",
    "contact_designation",
    "contact_calling_number",
    "contact_whatsapp_number",
    "contact_wechat_number",
    "email",
    "tax_id_number",
    "address",
    "town",
    "primary_website",
    "secondary_website",
    "supplier_grade",
    "current_status",
    "potential",
    "potential_reason",
    "secondary_products_description",
    "visited_factory_office",
    "visit_remarks",
    "overall_remarks",
    "is_active",
]

EXPORT_HEADERS = [
    "id",
    "company_name",
    "supplier_type",
    "brand_description",
    "country_id",
    "state_id",
    "city_id",
    "contact_full_name",
    "contact_designation",
    "contact_calling_number",
    "contact_whatsapp_number",
    "contact_wechat_number",
    "emails",
    "tax_id_number",
    "address",
    "town",
    "primary_website",
    "secondary_website",
    "supplier_grade",
    "current_status",
    "potential",
    "potential_reason",
    "secondary_products_description",
    "visited_factory_office",
    "visit_remarks",
    "overall_remarks",
    "is_active",
    "created_at",
    "updated_at",
]
