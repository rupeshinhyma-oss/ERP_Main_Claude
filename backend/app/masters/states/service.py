"""
State Service.

Business logic for state CRUD: country existence, name-uniqueness-within-
country, reference-blocked deletion, cache invalidation, and CSV/Excel
import/export orchestration.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.masters.countries.repository import CountryRepository
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)
from app.masters.states.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.states.models import State
from app.masters.states.repository import StateRepository
from app.masters.states.validators import validate_state_row


class StateService:
    """Orchestrates state management on top of :class:`StateRepository`."""

    not_found_message = "State not found."

    def __init__(
        self,
        repository: StateRepository,
        country_repository: CountryRepository,
        cache_manager: CacheManager,
    ) -> None:
        """Bind this service to its repository, the country repository, and the cache manager."""
        self.repository = repository
        self.country_repository = country_repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, state_id: uuid.UUID) -> State:
        """Fetch a state by ID or raise :class:`NotFoundException`."""
        state = await self.repository.get_by_id(state_id)
        if state is None:
            raise NotFoundException(self.not_found_message)
        return state

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[State], int]:
        """Return a page of states matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[State]:
        """Return every active state, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        states = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, states)
        return states

    async def _invalidate_cache(self) -> None:
        """Invalidate the states dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def _validate_country(self, country_id: uuid.UUID) -> None:
        """Ensure the given country exists."""
        country = await self.country_repository.get_by_id(country_id)
        if country is None:
            raise BadRequestException("The specified country does not exist.")

    async def create(self, **field_values: Any) -> State:
        """Create a new state, validating country existence and name uniqueness within it."""
        country_id = field_values["country_id"]
        name = field_values.get("name")
        await self._validate_country(country_id)
        if name:
            existing = await self.repository.get_by_name_in_country(country_id, name)
            if existing is not None:
                raise ConflictException(
                    f"State name {name!r} already exists in this country.",
                    details={"existing": model_to_dict(existing)},
                )

        state = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return state

    async def update(self, state_id: uuid.UUID, **field_values: Any) -> State:
        """Update an existing state, validating country existence and name uniqueness."""
        state = await self.get_by_id_or_raise(state_id)
        country_id = field_values.get("country_id") or state.country_id
        name = field_values.get("name")
        if field_values.get("country_id") is not None:
            await self._validate_country(country_id)
        if name:
            existing = await self.repository.get_by_name_in_country(country_id, name, exclude_id=state_id)
            if existing is not None:
                raise ConflictException(
                    f"State name {name!r} already exists in this country.",
                    details={"existing": model_to_dict(existing)},
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(state, **changes)
        await self._invalidate_cache()
        return state

    async def activate(self, state_id: uuid.UUID) -> State:
        """Set a state's status to ACTIVE."""
        return await self.update(state_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, state_id: uuid.UUID) -> State:
        """Set a state's status to INACTIVE."""
        return await self.update(state_id, status=RecordStatus.INACTIVE)

    async def delete(self, state_id: uuid.UUID) -> None:
        """Soft-delete a state, refusing if it is referenced by any city."""
        state = await self.get_by_id_or_raise(state_id)
        if await self.repository.is_referenced(state_id):
            raise ConflictException("This state cannot be deleted because it is referenced by one or more cities.")
        await self.repository.delete(state)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import states from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> State:
            country_code = field_values.pop("country_code")
            country = await self.country_repository.get_by_code(country_code)
            if country is None:
                raise ValueError(f"Country code {country_code!r} does not exist.")
            field_values["country_id"] = country.id
            name = field_values["name"]
            existing = await self.repository.get_by_name_in_country(country.id, name)
            if existing is not None:
                raise ConflictException(
                    f"State {name!r} already exists in country {country_code!r}.",
                    details={"existing": model_to_dict(existing)},
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_state_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every state to CSV or XLSX bytes."""
        states = await self.repository.list_all()
        rows = [
            {
                "id": str(s.id),
                "country_id": str(s.country_id),
                "name": s.name,
                "code": s.code,
                "status": s.status.value,
                "created_at": s.created_at.isoformat(),
                "updated_at": s.updated_at.isoformat(),
            }
            for s in states
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="States")
