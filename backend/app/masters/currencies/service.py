"""Currency Service. Business logic for currency CRUD, cache invalidation, and import/export."""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import ConflictException, NotFoundException
from app.masters.currencies.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.currencies.models import Currency
from app.masters.currencies.repository import CurrencyRepository
from app.masters.currencies.validators import validate_currency_row
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)


class CurrencyService:
    """Orchestrates currency management on top of :class:`CurrencyRepository`."""

    not_found_message = "Currency not found."

    def __init__(self, repository: CurrencyRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, currency_id: uuid.UUID) -> Currency:
        """Fetch a currency by ID or raise :class:`NotFoundException`."""
        currency = await self.repository.get_by_id(currency_id)
        if currency is None:
            raise NotFoundException(self.not_found_message)
        return currency

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Currency], int]:
        """Return a page of currencies matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[Currency]:
        """Return every active currency, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        currencies = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, currencies)
        return currencies

    async def _invalidate_cache(self) -> None:
        """Invalidate the currencies dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> Currency:
        """Create a new currency, validating name/code uniqueness."""
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name)
            if existing is not None:
                raise ConflictException(
                    f"Currency name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"Currency code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        currency = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return currency

    async def update(self, currency_id: uuid.UUID, **field_values: Any) -> Currency:
        """Update an existing currency, validating name/code uniqueness."""
        currency = await self.get_by_id_or_raise(currency_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name, exclude_id=currency_id)
            if existing is not None:
                raise ConflictException(
                    f"Currency name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None and existing.id != currency_id:
                raise ConflictException(
                    f"Currency code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(currency, **changes)
        await self._invalidate_cache()
        return currency

    async def activate(self, currency_id: uuid.UUID) -> Currency:
        """Set a currency's status to ACTIVE."""
        return await self.update(currency_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, currency_id: uuid.UUID) -> Currency:
        """Set a currency's status to INACTIVE."""
        return await self.update(currency_id, status=RecordStatus.INACTIVE)

    async def delete(self, currency_id: uuid.UUID) -> None:
        """Soft-delete a currency, refusing if it is referenced elsewhere."""
        currency = await self.get_by_id_or_raise(currency_id)
        if await self.repository.is_referenced(currency_id):
            raise ConflictException("This currency cannot be deleted because it is referenced elsewhere.")
        await self.repository.delete(currency)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import currencies from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> Currency:
            name = field_values["name"]
            code = field_values["code"]
            existing_by_name = await self.repository.get_by_name(name)
            if existing_by_name is not None:
                raise ConflictException(
                    f"Currency name {name!r} already exists.", details={"existing": model_to_dict(existing_by_name)}
                )
            existing_by_code = await self.repository.get_by_code(code)
            if existing_by_code is not None:
                raise ConflictException(
                    f"Currency code {code!r} already exists.", details={"existing": model_to_dict(existing_by_code)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_currency_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every currency to CSV or XLSX bytes."""
        currencies = await self.repository.list_all()
        rows = [
            {
                "id": str(c.id),
                "name": c.name,
                "code": c.code,
                "symbol": c.symbol,
                "decimal_places": c.decimal_places,
                "status": c.status.value,
                "created_at": c.created_at.isoformat(),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in currencies
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Currencies")
