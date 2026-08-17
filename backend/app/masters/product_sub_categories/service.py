"""
Product Sub-Category Service.

Business logic for sub-category CRUD: category existence,
code-uniqueness (global) plus name-uniqueness-within-category,
reference-blocked deletion, cache invalidation, and CSV/Excel
import/export orchestration.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.product_sub_categories.models import ProductSubCategory
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository
from app.masters.product_sub_categories.validators import validate_product_sub_category_row


class ProductSubCategoryService:
    """Orchestrates sub-category management on top of :class:`ProductSubCategoryRepository`."""

    not_found_message = "Product sub-category not found."

    def __init__(
        self,
        repository: ProductSubCategoryRepository,
        category_repository: ProductCategoryRepository,
        cache_manager: CacheManager,
    ) -> None:
        """Bind this service to its repository, the category repository, and the cache manager."""
        self.repository = repository
        self.category_repository = category_repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, sub_category_id: uuid.UUID) -> ProductSubCategory:
        """Fetch a sub-category by ID or raise :class:`NotFoundException`."""
        sub_category = await self.repository.get_by_id(sub_category_id)
        if sub_category is None:
            raise NotFoundException(self.not_found_message)
        return sub_category

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[ProductSubCategory], int]:
        """Return a page of sub-categories matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[ProductSubCategory]:
        """Return every active sub-category, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        sub_categories = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, sub_categories)
        return sub_categories

    async def _invalidate_cache(self) -> None:
        """Invalidate the sub-categories dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def _validate_category(self, category_id: uuid.UUID) -> None:
        """Ensure the given category exists."""
        category = await self.category_repository.get_by_id(category_id)
        if category is None:
            raise BadRequestException("The specified product category does not exist.")

    async def create(self, **field_values: Any) -> ProductSubCategory:
        """Create a new sub-category, validating category existence, code, and name uniqueness."""
        category_id = field_values["category_id"]
        code = field_values.get("code")
        name = field_values.get("name")
        await self._validate_category(category_id)
        if not code and name:
            clean_name = "".join(c if c.isalnum() else "-" for c in name.upper())
            base_code = "-".join(filter(None, clean_name.split("-")))[:45] or "SUB-CAT"
            code = base_code
            counter = 1
            while await self.repository.get_by_code(code):
                code = f"{base_code}-{counter}"
                counter += 1
            field_values["code"] = code

        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None:
                raise ConflictException(
                    f"Sub-category code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if name:
            existing = await self.repository.get_by_name_in_category(category_id, name)
            if existing is not None:
                raise ConflictException(
                    f"Sub-category name {name!r} already exists in this category.",
                    details={"existing": model_to_dict(existing)},
                )

        sub_category = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return sub_category

    async def update(self, sub_category_id: uuid.UUID, **field_values: Any) -> ProductSubCategory:
        """Update an existing sub-category, validating category existence, code, and name uniqueness."""
        sub_category = await self.get_by_id_or_raise(sub_category_id)
        category_id = field_values.get("category_id") or sub_category.category_id
        code = field_values.get("code")
        name = field_values.get("name")
        if field_values.get("category_id") is not None:
            await self._validate_category(category_id)
        if code:
            existing = await self.repository.get_by_code(code)
            if existing is not None and existing.id != sub_category_id:
                raise ConflictException(
                    f"Sub-category code {code!r} is already in use.", details={"existing": model_to_dict(existing)}
                )
        if name:
            existing = await self.repository.get_by_name_in_category(category_id, name, exclude_id=sub_category_id)
            if existing is not None:
                raise ConflictException(
                    f"Sub-category name {name!r} already exists in this category.",
                    details={"existing": model_to_dict(existing)},
                )

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(sub_category, **changes)
        await self._invalidate_cache()
        return sub_category

    async def activate(self, sub_category_id: uuid.UUID) -> ProductSubCategory:
        """Set a sub-category's status to ACTIVE."""
        return await self.update(sub_category_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, sub_category_id: uuid.UUID) -> ProductSubCategory:
        """Set a sub-category's status to INACTIVE."""
        return await self.update(sub_category_id, status=RecordStatus.INACTIVE)

    async def delete(self, sub_category_id: uuid.UUID) -> None:
        """Soft-delete a sub-category, refusing if it is referenced by any product."""
        sub_category = await self.get_by_id_or_raise(sub_category_id)
        if await self.repository.is_referenced(sub_category_id):
            raise ConflictException(
                "This sub-category cannot be deleted because it is used by one or more products."
            )
        await self.repository.delete(sub_category)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import sub-categories from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> ProductSubCategory:
            category_code = field_values.pop("category_code")
            category = await self.category_repository.get_by_code(category_code)
            if category is None:
                raise ValueError(f"Category code {category_code!r} does not exist.")
            field_values["category_id"] = category.id
            code = field_values["code"]
            name = field_values["name"]
            existing_by_code = await self.repository.get_by_code(code)
            if existing_by_code is not None:
                raise ConflictException(
                    f"Sub-category code {code!r} already exists.",
                    details={"existing": model_to_dict(existing_by_code)},
                )
            existing_by_name = await self.repository.get_by_name_in_category(category.id, name)
            if existing_by_name is not None:
                raise ConflictException(
                    f"Sub-category {name!r} already exists in category {category_code!r}.",
                    details={"existing": model_to_dict(existing_by_name)},
                )
            return await self.repository.create(**field_values)

        summary = await run_import(
            rows,
            row_validator=validate_product_sub_category_row,
            row_creator=_create,
            dedupe_keys=("code", "category_code"),
        )
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every sub-category to CSV or XLSX bytes."""
        sub_categories = await self.repository.list_all()
        rows = [
            {
                "id": str(s.id),
                "category_id": str(s.category_id),
                "code": s.code,
                "name": s.name,
                "description": s.description,
                "status": s.status.value,
                "created_at": s.created_at.isoformat(),
                "updated_at": s.updated_at.isoformat(),
            }
            for s in sub_categories
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Product Sub-Categories")
