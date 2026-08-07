"""Brand Service. Business logic for brand CRUD, cache invalidation, and import/export."""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import ConflictException, NotFoundException
from app.masters.brands.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.brands.models import Brand
from app.masters.brands.repository import BrandRepository
from app.masters.brands.validators import validate_brand_row
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)


class BrandService:
    """Orchestrates brand management on top of :class:`BrandRepository`."""

    not_found_message = "Brand not found."

    def __init__(self, repository: BrandRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, brand_id: uuid.UUID) -> Brand:
        """Fetch a brand by ID or raise :class:`NotFoundException`."""
        brand = await self.repository.get_by_id(brand_id)
        if brand is None:
            raise NotFoundException(self.not_found_message)
        return brand

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Brand], int]:
        """Return a page of brands matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[Brand]:
        """Return every active brand, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        brands = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, brands)
        return brands

    async def _invalidate_cache(self) -> None:
        """Invalidate the brands dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> Brand:
        """Create a new brand, validating name/code uniqueness."""
        name = field_values.get("name")
        code = field_values.get("code")

        if not code and name:
            clean_name = "".join(c.upper() for c in name if c.isalnum())[:10]
            code = f"BR-{clean_name}" if clean_name else "BR-GEN"
            counter = 1
            base_code = code
            while await self.repository.get_by_code(code) is not None:
                code = f"{base_code}{counter}"
                counter += 1
            field_values["code"] = code

        if name:
            existing = await self.repository.get_by_name(name)
            if existing is not None:
                raise ConflictException(
                    f"Brand name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"Brand code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        brand = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return brand

    async def update(self, brand_id: uuid.UUID, **field_values: Any) -> Brand:
        """Update an existing brand, validating name/code uniqueness."""
        brand = await self.get_by_id_or_raise(brand_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name, exclude_id=brand_id)
            if existing is not None:
                raise ConflictException(
                    f"Brand name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None and existing.id != brand_id:
                raise ConflictException(
                    f"Brand code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(brand, **changes)
        await self._invalidate_cache()
        return brand

    async def activate(self, brand_id: uuid.UUID) -> Brand:
        """Set a brand's status to ACTIVE."""
        return await self.update(brand_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, brand_id: uuid.UUID) -> Brand:
        """Set a brand's status to INACTIVE."""
        return await self.update(brand_id, status=RecordStatus.INACTIVE)

    async def delete(self, brand_id: uuid.UUID) -> None:
        """Soft-delete a brand, refusing if it is referenced by any product."""
        brand = await self.get_by_id_or_raise(brand_id)
        if await self.repository.is_referenced(brand_id):
            raise ConflictException("This brand cannot be deleted because it is used by one or more products.")
        await self.repository.delete(brand)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import brands from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> Brand:
            name = field_values["name"]
            code = field_values["code"]
            existing_by_name = await self.repository.get_by_name(name)
            if existing_by_name is not None:
                raise ConflictException(
                    f"Brand name {name!r} already exists.", details={"existing": model_to_dict(existing_by_name)}
                )
            existing_by_code = await self.repository.get_by_code(code)
            if existing_by_code is not None:
                raise ConflictException(
                    f"Brand code {code!r} already exists.", details={"existing": model_to_dict(existing_by_code)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_brand_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every brand to CSV or XLSX bytes."""
        brands = await self.repository.list_all()
        rows = [
            {
                "id": str(b.id),
                "name": b.name,
                "code": b.code,
                "description": b.description,
                "logo_url": b.logo_url,
                "status": b.status.value,
                "created_at": b.created_at.isoformat(),
                "updated_at": b.updated_at.isoformat(),
            }
            for b in brands
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Brands")
