"""HSN Service. Business logic for HSN CRUD, cache invalidation, and import/export."""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import ConflictException, NotFoundException
from app.masters.hsn.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.hsn.models import HsnCode
from app.masters.hsn.repository import HsnRepository
from app.masters.hsn.validators import validate_hsn_row
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)


class HsnService:
    """Orchestrates HSN code management on top of :class:`HsnRepository`."""

    not_found_message = "HSN code not found."

    def __init__(self, repository: HsnRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, hsn_id: uuid.UUID) -> HsnCode:
        """Fetch an HSN code by ID or raise :class:`NotFoundException`."""
        hsn = await self.repository.get_by_id(hsn_id)
        if hsn is None:
            raise NotFoundException(self.not_found_message)
        return hsn

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[HsnCode], int]:
        """Return a page of HSN codes matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[HsnCode]:
        """Return every active HSN code, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        hsn_codes = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, hsn_codes)
        return hsn_codes

    async def _invalidate_cache(self) -> None:
        """Invalidate the HSN dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> HsnCode:
        """Create a new HSN code, validating code uniqueness."""
        code = field_values.get("code")
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"HSN code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        hsn = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return hsn

    async def update(self, hsn_id: uuid.UUID, **field_values: Any) -> HsnCode:
        """Update an existing HSN code, validating code uniqueness."""
        hsn = await self.get_by_id_or_raise(hsn_id)
        code = field_values.get("code")
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None and existing.id != hsn_id:
                raise ConflictException(
                    f"HSN code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(hsn, **changes)
        await self._invalidate_cache()
        return hsn

    async def activate(self, hsn_id: uuid.UUID) -> HsnCode:
        """Set an HSN code's status to ACTIVE."""
        return await self.update(hsn_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, hsn_id: uuid.UUID) -> HsnCode:
        """Set an HSN code's status to INACTIVE."""
        return await self.update(hsn_id, status=RecordStatus.INACTIVE)

    async def delete(self, hsn_id: uuid.UUID) -> None:
        """Soft-delete an HSN code, refusing if it is referenced by any product."""
        hsn = await self.get_by_id_or_raise(hsn_id)
        if await self.repository.is_referenced(hsn_id):
            raise ConflictException("This HSN code cannot be deleted because it is used by one or more products.")
        await self.repository.delete(hsn)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import HSN codes from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> HsnCode:
            code = field_values["code"]
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"HSN code {code!r} already exists.", details={"existing": model_to_dict(existing)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_hsn_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every HSN code to CSV or XLSX bytes."""
        hsn_codes = await self.repository.list_all()
        rows = [
            {
                "id": str(h.id),
                "code": h.code,
                "description": h.description,
                "gst_percent": float(h.gst_percent),
                "status": h.status.value,
                "created_at": h.created_at.isoformat(),
                "updated_at": h.updated_at.isoformat(),
            }
            for h in hsn_codes
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="HSN")
