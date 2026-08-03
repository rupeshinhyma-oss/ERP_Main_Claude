"""Country Constants."""

from __future__ import annotations

MODULE_NAME = "countries"
DROPDOWN_CACHE_NAME = "countries"  # key used with CacheManager.get_dropdown/set_dropdown/invalidate_dropdown

IMPORT_HEADERS = ["name", "code", "iso2", "iso3", "phone_code", "nationality", "currency", "status"]
EXPORT_HEADERS = ["id", "name", "code", "iso2", "iso3", "phone_code", "nationality", "currency", "status", "created_at", "updated_at"]
