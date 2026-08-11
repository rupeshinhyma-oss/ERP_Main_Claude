"""SupplierType Service."""

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
from app.masters.supplier_types.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.supplier_types.models import SupplierType
from app.masters.supplier_types.repository import SupplierTypeRepository
from app.masters.supplier_types.validators import validate_supplier_type_row


class SupplierTypeService:
    """Service for SupplierType."""

    not_found_message = "Supplier type not found."

    def __init__(self, repository: SupplierTypeRepository, cache_manager: CacheManager) -> None:
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, supplier_type_id: uuid.UUID) -> SupplierType:
        item = await self.repository.get_by_id(supplier_type_id)
        if item is None:
            raise NotFoundException(self.not_found_message)
        return item

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[SupplierType], int]:
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[SupplierType]:
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        items = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, items)
        return items

    async def _invalidate_cache(self) -> None:
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> SupplierType:
        name = field_values.get("name")
        code = field_values.get("code")

        if not code and name:
            clean_name = "".join(c.upper() for c in name if c.isalnum())[:10]
            code = f"ST-{clean_name}" if clean_name else "ST-GEN"
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
                    f"Supplier type name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        item = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return item

    async def update(self, supplier_type_id: uuid.UUID, **field_values: Any) -> SupplierType:
        item = await self.get_by_id_or_raise(supplier_type_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name, exclude_id=supplier_type_id)
            if existing is not None:
                raise ConflictException(
                    f"Supplier type name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(item, **changes)
        await self._invalidate_cache()
        return item

    async def activate(self, supplier_type_id: uuid.UUID) -> SupplierType:
        return await self.update(supplier_type_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, supplier_type_id: uuid.UUID) -> SupplierType:
        return await self.update(supplier_type_id, status=RecordStatus.INACTIVE)

    async def delete(self, supplier_type_id: uuid.UUID) -> None:
        item = await self.get_by_id_or_raise(supplier_type_id)
        await self.repository.delete(item)
        await self._invalidate_cache()

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> SupplierType:
            name = field_values["name"]
            existing = await self.repository.get_by_name(name)
            if existing is not None:
                raise ConflictException(
                    f"Supplier type name {name!r} already exists.", details={"existing": model_to_dict(existing)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_supplier_type_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        items = await self.repository.list_all()
        rows = [
            {
                "id": str(b.id),
                "name": b.name,
                "code": b.code,
                "description": b.description,
                "status": b.status.value,
                "created_at": b.created_at.isoformat(),
                "updated_at": b.updated_at.isoformat(),
            }
            for b in items
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Supplier Types")
