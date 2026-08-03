"""
Country Service.

Business logic for country CRUD: name/code uniqueness, reference-blocked
deletion (a country referenced by a state cannot be removed), cache
invalidation, and CSV/Excel import/export orchestration.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import ConflictException, NotFoundException
from app.masters.countries.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS, IMPORT_HEADERS
from app.masters.countries.models import Country
from app.masters.countries.repository import CountryRepository
from app.masters.countries.validators import validate_country_row
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    parse_rows_from_file,
    run_import,
)


class CountryService:
    """Orchestrates country management on top of :class:`CountryRepository`."""

    not_found_message = "Country not found."

    def __init__(self, repository: CountryRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, country_id: uuid.UUID) -> Country:
        """Fetch a country by ID or raise :class:`NotFoundException`."""
        country = await self.repository.get_by_id(country_id)
        if country is None:
            raise NotFoundException(self.not_found_message)
        return country

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Country], int]:
        """Return a page of countries matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[Country]:
        """Return every active country, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        countries = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, countries)
        return countries

    async def _invalidate_cache(self) -> None:
        """Invalidate the countries dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> Country:
        """Create a new country, validating name/code uniqueness."""
        name = field_values.get("name")
        code = field_values.get("code")
        if name and await self.repository.name_exists(name):
            raise ConflictException(f"Country name {name!r} is already in use.")
        if code and await self.repository.code_exists(code):
            raise ConflictException(f"Country code {code!r} is already in use.")

        country = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return country

    async def update(self, country_id: uuid.UUID, **field_values: Any) -> Country:
        """Update an existing country, validating name/code uniqueness."""
        country = await self.get_by_id_or_raise(country_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name and await self.repository.name_exists(name, exclude_id=country_id):
            raise ConflictException(f"Country name {name!r} is already in use.")
        if code and await self.repository.code_exists(code, exclude_id=country_id):
            raise ConflictException(f"Country code {code!r} is already in use.")

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(country, **changes)
        await self._invalidate_cache()
        return country

    async def activate(self, country_id: uuid.UUID) -> Country:
        """Set a country's status to ACTIVE."""
        from app.core.constants import RecordStatus

        return await self.update(country_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, country_id: uuid.UUID) -> Country:
        """Set a country's status to INACTIVE."""
        from app.core.constants import RecordStatus

        return await self.update(country_id, status=RecordStatus.INACTIVE)

    async def delete(self, country_id: uuid.UUID) -> None:
        """Soft-delete a country, refusing if it is referenced by any state."""
        country = await self.get_by_id_or_raise(country_id)
        if await self.repository.is_referenced(country_id):
            raise ConflictException(
                "This country cannot be deleted because it is referenced by one or more states."
            )
        await self.repository.delete(country)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import countries from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> Country:
            name = field_values["name"]
            code = field_values["code"]
            if await self.repository.name_exists(name):
                raise ValueError(f"Country name {name!r} already exists.")
            if await self.repository.code_exists(code):
                raise ValueError(f"Country code {code!r} already exists.")
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_country_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every country to CSV or XLSX bytes."""
        countries = await self.repository.list_all()
        rows = [
            {
                "id": str(c.id),
                "name": c.name,
                "code": c.code,
                "iso2": c.iso2,
                "iso3": c.iso3,
                "phone_code": c.phone_code,
                "nationality": c.nationality,
                "currency": c.currency,
                "status": c.status.value,
                "created_at": c.created_at.isoformat(),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in countries
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Countries")
