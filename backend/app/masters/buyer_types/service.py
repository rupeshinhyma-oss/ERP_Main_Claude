"""BuyerType Service."""

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
from app.masters.buyer_types.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.buyer_types.models import BuyerType
from app.masters.buyer_types.repository import BuyerTypeRepository
from app.masters.buyer_types.validators import validate_buyer_type_row


class BuyerTypeService:
    """Service for BuyerType."""

    not_found_message = "Buyer type not found."

    def __init__(self, repository: BuyerTypeRepository, cache_manager: CacheManager) -> None:
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, buyer_type_id: uuid.UUID) -> BuyerType:
        item = await self.repository.get_by_id(buyer_type_id)
        if item is None:
            raise NotFoundException(self.not_found_message)
        return item

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[BuyerType], int]:
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[BuyerType]:
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        items = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, items)
        return items

    async def _invalidate_cache(self) -> None:
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> BuyerType:
        name = field_values.get("name")
        code = field_values.get("code")

        if not code and name:
            clean_name = "".join(c.upper() for c in name if c.isalnum())[:10]
            code = f"BT-{clean_name}" if clean_name else "BT-GEN"
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
                    f"Buyer type name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        item = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return item

    async def update(self, buyer_type_id: uuid.UUID, **field_values: Any) -> BuyerType:
        item = await self.get_by_id_or_raise(buyer_type_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name, exclude_id=buyer_type_id)
            if existing is not None:
                raise ConflictException(
                    f"Buyer type name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(item, **changes)
        await self._invalidate_cache()
        return item

    async def activate(self, buyer_type_id: uuid.UUID) -> BuyerType:
        return await self.update(buyer_type_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, buyer_type_id: uuid.UUID) -> BuyerType:
        return await self.update(buyer_type_id, status=RecordStatus.INACTIVE)

    async def delete(self, buyer_type_id: uuid.UUID) -> None:
        item = await self.get_by_id_or_raise(buyer_type_id)
        await self.repository.delete(item)
        await self._invalidate_cache()

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> BuyerType:
            name = field_values["name"]
            existing = await self.repository.get_by_name(name)
            if existing is not None:
                raise ConflictException(
                    f"Buyer type name {name!r} already exists.", details={"existing": model_to_dict(existing)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(
            rows, row_validator=validate_buyer_type_row, row_creator=_create, dedupe_keys=("name",)
        )
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
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Buyer Types")
