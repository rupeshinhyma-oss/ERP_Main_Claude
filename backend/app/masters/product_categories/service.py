"""Product Category Service. Business logic for category CRUD, cache invalidation, and import/export."""

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
from app.masters.product_categories.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.product_categories.models import ProductCategory
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_categories.validators import validate_product_category_row


class ProductCategoryService:
    """Orchestrates product category management on top of :class:`ProductCategoryRepository`."""

    not_found_message = "Product category not found."

    def __init__(self, repository: ProductCategoryRepository, cache_manager: CacheManager) -> None:
        """Bind this service to its repository and the cache manager."""
        self.repository = repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, category_id: uuid.UUID) -> ProductCategory:
        """Fetch a category by ID or raise :class:`NotFoundException`."""
        category = await self.repository.get_by_id(category_id)
        if category is None:
            raise NotFoundException(self.not_found_message)
        return category

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[ProductCategory], int]:
        """Return a page of categories matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[ProductCategory]:
        """Return every active category, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        categories = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, categories)
        return categories

    async def _invalidate_cache(self) -> None:
        """Invalidate the product-categories dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def create(self, **field_values: Any) -> ProductCategory:
        """Create a new category, validating name/code uniqueness."""
        name = field_values.get("name")
        code = field_values.get("code")

        if not code and name:
            clean_name = "".join(c.upper() for c in name if c.isalnum())[:10]
            code = f"CAT-{clean_name}" if clean_name else "CAT-GEN"
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
                    f"Category name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"Category code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        category = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return category

    async def update(self, category_id: uuid.UUID, **field_values: Any) -> ProductCategory:
        """Update an existing category, validating name/code uniqueness."""
        category = await self.get_by_id_or_raise(category_id)
        name = field_values.get("name")
        code = field_values.get("code")
        if name:
            existing = await self.repository.get_by_name(name, exclude_id=category_id)
            if existing is not None:
                raise ConflictException(
                    f"Category name {name!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None and existing.id != category_id:
                raise ConflictException(
                    f"Category code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(category, **changes)
        await self._invalidate_cache()
        return category

    async def activate(self, category_id: uuid.UUID) -> ProductCategory:
        """Set a category's status to ACTIVE."""
        return await self.update(category_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, category_id: uuid.UUID) -> ProductCategory:
        """Set a category's status to INACTIVE."""
        return await self.update(category_id, status=RecordStatus.INACTIVE)

    async def delete(self, category_id: uuid.UUID) -> None:
        """Soft-delete a category, refusing if it is referenced by a sub-category or product."""
        category = await self.get_by_id_or_raise(category_id)
        if await self.repository.is_referenced(category_id):
            raise ConflictException(
                "This category cannot be deleted because it is used by one or more sub-categories or products."
            )
        await self.repository.delete(category)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import categories from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> ProductCategory:
            name = field_values["name"]
            code = field_values["code"]
            existing_by_name = await self.repository.get_by_name(name)
            if existing_by_name is not None:
                raise ConflictException(
                    f"Category name {name!r} already exists.", details={"existing": model_to_dict(existing_by_name)}
                )
            existing_by_code = await self.repository.get_by_code(code)
            if existing_by_code is not None:
                raise ConflictException(
                    f"Category code {code!r} already exists.", details={"existing": model_to_dict(existing_by_code)}
                )
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_product_category_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every category to CSV or XLSX bytes."""
        categories = await self.repository.list_all()
        rows = [
            {
                "id": str(c.id),
                "code": c.code,
                "name": c.name,
                "description": c.description,
                "status": c.status.value,
                "created_at": c.created_at.isoformat(),
                "updated_at": c.updated_at.isoformat(),
            }
            for c in categories
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Product Categories")
