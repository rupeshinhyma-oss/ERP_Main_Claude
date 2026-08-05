"""Unit of Measurement Service. Business logic for UOM CRUD, cache invalidation, and import/export."""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import ConflictException, NotFoundException
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)
from app.masters.uom.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.uom.models import UnitOfMeasurement
from app.masters.uom.repository import UomRepository
from app.masters.uom.validators import validate_uom_row


class UomService:
    """Orchestrates unit-of-measurement management on top of :class:`UomRepository`."""

    not_found_message = "Unit of measurement not found."

    def __init__(self, repository: UomRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, uom_id: uuid.UUID) -> UnitOfMeasurement:
        """Fetch a UOM by ID or raise :class:`NotFoundException`."""
        uom = await self.repository.get_by_id(uom_id)
        if uom is None:
            raise NotFoundException(self.not_found_message)
        return uom

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[UnitOfMeasurement], int]:
        """Return a page of UOMs matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[UnitOfMeasurement]:
        """Return every active UOM, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        uoms = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, uoms)
        return uoms

    async def _invalidate_cache(self) -> None:
        """Invalidate the UOM dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> UnitOfMeasurement:
        """Create a new UOM, validating name/code uniqueness."""
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name)
            if existing is not None:
                raise ConflictException(
                    f"UOM name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"UOM code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        uom = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return uom

    async def update(self, uom_id: uuid.UUID, **field_values: Any) -> UnitOfMeasurement:
        """Update an existing UOM, validating name/code uniqueness."""
        uom = await self.get_by_id_or_raise(uom_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name, exclude_id=uom_id)
            if existing is not None:
                raise ConflictException(
                    f"UOM name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None and existing.id != uom_id:
                raise ConflictException(
                    f"UOM code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(uom, **changes)
        await self._invalidate_cache()
        return uom

    async def activate(self, uom_id: uuid.UUID) -> UnitOfMeasurement:
        """Set a UOM's status to ACTIVE."""
        return await self.update(uom_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, uom_id: uuid.UUID) -> UnitOfMeasurement:
        """Set a UOM's status to INACTIVE."""
        return await self.update(uom_id, status=RecordStatus.INACTIVE)

    async def delete(self, uom_id: uuid.UUID) -> None:
        """Soft-delete a UOM, refusing if it is referenced by any product."""
        uom = await self.get_by_id_or_raise(uom_id)
        if await self.repository.is_referenced(uom_id):
            raise ConflictException("This unit of measurement cannot be deleted because it is used by one or more products.")
        await self.repository.delete(uom)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import UOMs from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> UnitOfMeasurement:
            name = field_values["name"]
            code = field_values["code"]
            existing_by_name = await self.repository.get_by_name(name)
            if existing_by_name is not None:
                raise ConflictException(
                    f"UOM name {name!r} already exists.", details={"existing": model_to_dict(existing_by_name)}
                )
            existing_by_code = await self.repository.get_by_code(code)
            if existing_by_code is not None:
                raise ConflictException(
                    f"UOM code {code!r} already exists.", details={"existing": model_to_dict(existing_by_code)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_uom_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every UOM to CSV or XLSX bytes."""
        uoms = await self.repository.list_all()
        rows = [
            {
                "id": str(u.id),
                "code": u.code,
                "name": u.name,
                "short_name": u.short_name,
                "description": u.description,
                "status": u.status.value,
                "created_at": u.created_at.isoformat(),
                "updated_at": u.updated_at.isoformat(),
            }
            for u in uoms
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="UOM")
