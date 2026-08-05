"""
City Service.

Business logic for city CRUD: state (and consistent country) existence,
name-uniqueness-within-state, cache invalidation, and CSV/Excel
import/export orchestration.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.masters.cities.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.cities.models import City
from app.masters.cities.repository import CityRepository
from app.masters.cities.validators import validate_city_row
from app.masters.countries.repository import CountryRepository
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    parse_rows_from_file,
    run_import,
)
from app.masters.states.repository import StateRepository


class CityService:
    """Orchestrates city management on top of :class:`CityRepository`."""

    not_found_message = "City not found."

    def __init__(
        self,
        repository: CityRepository,
        state_repository: StateRepository,
        country_repository: CountryRepository,
        cache_manager: CacheManager,
    ) -> None:
        """Bind this service to its repository, the state/country repositories, and the cache manager."""
        self.repository = repository
        self.state_repository = state_repository
        self.country_repository = country_repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, city_id: uuid.UUID) -> City:
        """Fetch a city by ID or raise :class:`NotFoundException`."""
        city = await self.repository.get_by_id(city_id)
        if city is None:
            raise NotFoundException(self.not_found_message)
        return city

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[City], int]:
        """Return a page of cities matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[City]:
        """Return every active city, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        cities = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, cities)
        return cities

    async def _invalidate_cache(self) -> None:
        """Invalidate the cities dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def _validate_state_and_country(self, state_id: uuid.UUID, country_id: uuid.UUID) -> None:
        """Ensure the state exists and genuinely belongs to the given country."""
        state = await self.state_repository.get_by_id(state_id)
        if state is None:
            raise BadRequestException("The specified state does not exist.")
        if state.country_id != country_id:
            raise BadRequestException("The specified state does not belong to the specified country.")

    async def create(self, **field_values: Any) -> City:
        """Create a new city, validating state/country consistency and name uniqueness."""
        state_id = field_values["state_id"]
        country_id = field_values["country_id"]
        name = field_values.get("name")
        await self._validate_state_and_country(state_id, country_id)
        if name and await self.repository.name_exists_in_state(state_id, name):
            raise ConflictException(f"City name {name!r} already exists in this state.")

        city = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return city

    async def update(self, city_id: uuid.UUID, **field_values: Any) -> City:
        """Update an existing city, validating state/country consistency and name uniqueness."""
        city = await self.get_by_id_or_raise(city_id)
        state_id = field_values.get("state_id") or city.state_id
        country_id = field_values.get("country_id") or city.country_id
        name = field_values.get("name")
        if field_values.get("state_id") is not None or field_values.get("country_id") is not None:
            await self._validate_state_and_country(state_id, country_id)
        if name and await self.repository.name_exists_in_state(state_id, name, exclude_id=city_id):
            raise ConflictException(f"City name {name!r} already exists in this state.")

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(city, **changes)
        await self._invalidate_cache()
        return city

    async def activate(self, city_id: uuid.UUID) -> City:
        """Set a city's status to ACTIVE."""
        return await self.update(city_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, city_id: uuid.UUID) -> City:
        """Set a city's status to INACTIVE."""
        return await self.update(city_id, status=RecordStatus.INACTIVE)

    async def delete(self, city_id: uuid.UUID) -> None:
        """Soft-delete a city, refusing if it is referenced elsewhere."""
        city = await self.get_by_id_or_raise(city_id)
        if await self.repository.is_referenced(city_id):
            raise ConflictException("This city cannot be deleted because it is referenced elsewhere.")
        await self.repository.delete(city)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import cities from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> City:
            country_code = field_values.pop("country_code", "")
            state_name = field_values.pop("state_name", "")
            all_states = await self.state_repository.list_all()
            all_countries = await self.country_repository.list_all()

            target_state = None
            if state_name:
                target_state = next((s for s in all_states if s.name.lower() == state_name.lower() or (s.code and s.code.lower() == state_name.lower())), None)
            
            if target_state is None:
                raise ValueError(f"State '{state_name}' does not exist. Please create state '{state_name}' first.")

            field_values["state_id"] = target_state.id
            field_values["country_id"] = target_state.country_id

            name = field_values["name"]
            if await self.repository.city_exists(field_values["country_id"], field_values.get("state_id"), name):
                raise ValueError(f"City '{name}' already exists.")
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_city_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every city to CSV or XLSX bytes."""
        cities = await self.repository.list_all()
        rows = [
            {
                "id": str(c.id),
                "country_id": str(c.country_id),
                "state_id": str(c.state_id),
                "name": c.name,
                "status": c.status.value,
                "created_at": c.created_at.isoformat(),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in cities
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Cities")
