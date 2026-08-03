"""
Product Service.

Business logic for product CRUD: cross-master foreign-key validation
(category, sub-category consistency, brand, HSN, UOM, secondary UOM),
code uniqueness, cache invalidation, and CSV/Excel import/export
orchestration. The richest service in Master Data, since Product is the
master every other module will ultimately consume.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.constants import RecordStatus
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.masters.brands.repository import BrandRepository
from app.masters.hsn.repository import HsnRepository
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    parse_rows_from_file,
    run_import,
)
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository
from app.masters.products.constants import DROPDOWN_CACHE_NAME, EXPORT_HEADERS
from app.masters.products.models import Product
from app.masters.products.repository import ProductRepository
from app.masters.products.validators import validate_product_row
from app.masters.uom.repository import UomRepository


class ProductService:
    """Orchestrates product management on top of :class:`ProductRepository`."""

    not_found_message = "Product not found."

    def __init__(
        self,
        repository: ProductRepository,
        category_repository: ProductCategoryRepository,
        sub_category_repository: ProductSubCategoryRepository,
        brand_repository: BrandRepository,
        hsn_repository: HsnRepository,
        uom_repository: UomRepository,
        cache_manager: CacheManager,
    ) -> None:
        """Bind this service to its own repository, every referenced master's repository, and the cache manager."""
        self.repository = repository
        self.category_repository = category_repository
        self.sub_category_repository = sub_category_repository
        self.brand_repository = brand_repository
        self.hsn_repository = hsn_repository
        self.uom_repository = uom_repository
        self.cache_manager = cache_manager

    async def get_by_id_or_raise(self, product_id: uuid.UUID) -> Product:
        """Fetch a product by ID or raise :class:`NotFoundException`."""
        product = await self.repository.get_by_id(product_id)
        if product is None:
            raise NotFoundException(self.not_found_message)
        return product

    async def list_paginated(self, query: ListQueryParams) -> tuple[list[Product], int]:
        """Return a page of products matching the given search/sort/filter parameters."""
        return await self.repository.paginated_list(query)

    async def list_all_cached(self) -> list[Product]:
        """Return every active product, using the shared dropdown cache."""
        cached = await self.cache_manager.get_dropdown(DROPDOWN_CACHE_NAME)
        if cached is not None:
            return cached
        products = await self.repository.list_all()
        await self.cache_manager.set_dropdown(DROPDOWN_CACHE_NAME, products)
        return products

    async def _invalidate_cache(self) -> None:
        """Invalidate the products dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    async def _validate_references(self, field_values: dict[str, Any]) -> None:
        """Validate every foreign key present in ``field_values`` against its owning master."""
        category_id = field_values.get("category_id")
        if category_id is not None:
            if await self.category_repository.get_by_id(category_id) is None:
                raise BadRequestException("The specified product category does not exist.")

        sub_category_id = field_values.get("sub_category_id")
        if sub_category_id is not None:
            sub_category = await self.sub_category_repository.get_by_id(sub_category_id)
            if sub_category is None:
                raise BadRequestException("The specified product sub-category does not exist.")
            if category_id is not None and sub_category.category_id != category_id:
                raise BadRequestException("The specified sub-category does not belong to the specified category.")

        brand_id = field_values.get("brand_id")
        if brand_id is not None and await self.brand_repository.get_by_id(brand_id) is None:
            raise BadRequestException("The specified brand does not exist.")

        hsn_id = field_values.get("hsn_id")
        if hsn_id is not None and await self.hsn_repository.get_by_id(hsn_id) is None:
            raise BadRequestException("The specified HSN code does not exist.")

        uom_id = field_values.get("uom_id")
        if uom_id is not None and await self.uom_repository.get_by_id(uom_id) is None:
            raise BadRequestException("The specified unit of measurement does not exist.")

        secondary_uom_id = field_values.get("secondary_uom_id")
        if secondary_uom_id is not None:
            if await self.uom_repository.get_by_id(secondary_uom_id) is None:
                raise BadRequestException("The specified secondary unit of measurement does not exist.")
            if uom_id is not None and secondary_uom_id == uom_id:
                raise BadRequestException("The secondary unit of measurement must differ from the primary unit.")

    async def create(self, **field_values: Any) -> Product:
        """Create a new product, validating code uniqueness and every foreign-key reference."""
        product_code = field_values.get("product_code")
        if product_code and await self.repository.code_exists(product_code):
            raise ConflictException(f"Product code {product_code!r} is already in use.")
        await self._validate_references(field_values)

        product = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return product

    async def update(self, product_id: uuid.UUID, **field_values: Any) -> Product:
        """Update an existing product, validating code uniqueness and every foreign-key reference."""
        product = await self.get_by_id_or_raise(product_id)
        product_code = field_values.get("product_code")
        if product_code and await self.repository.code_exists(product_code, exclude_id=product_id):
            raise ConflictException(f"Product code {product_code!r} is already in use.")

        # Merge with existing values so cross-field checks (e.g. sub-category
        # belongs to category) are validated against the resulting full state,
        # not just the fields present in this particular PATCH.
        merged = {
            "category_id": field_values.get("category_id", product.category_id),
            "sub_category_id": field_values.get("sub_category_id", product.sub_category_id),
            "brand_id": field_values.get("brand_id", product.brand_id),
            "hsn_id": field_values.get("hsn_id", product.hsn_id),
            "uom_id": field_values.get("uom_id", product.uom_id),
            "secondary_uom_id": field_values.get("secondary_uom_id", product.secondary_uom_id),
        }
        await self._validate_references(merged)

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(product, **changes)
        await self._invalidate_cache()
        return product

    async def activate(self, product_id: uuid.UUID) -> Product:
        """Set a product's status to ACTIVE."""
        return await self.update(product_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, product_id: uuid.UUID) -> Product:
        """Set a product's status to INACTIVE."""
        return await self.update(product_id, status=RecordStatus.INACTIVE)

    async def delete(self, product_id: uuid.UUID) -> None:
        """Soft-delete a product, refusing if it is referenced elsewhere."""
        product = await self.get_by_id_or_raise(product_id)
        if await self.repository.is_referenced(product_id):
            raise ConflictException("This product cannot be deleted because it is referenced elsewhere.")
        await self.repository.delete(product)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import products from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> Product:
            category_code = field_values.pop("category_code")
            sub_category_code = field_values.pop("sub_category_code", None)
            brand_code = field_values.pop("brand_code", None)
            hsn_code = field_values.pop("hsn_code", None)
            uom_code = field_values.pop("uom_code")
            secondary_uom_code = field_values.pop("secondary_uom_code", None)

            category = await self.category_repository.get_by_code(category_code)
            if category is None:
                raise ValueError(f"Category code {category_code!r} does not exist.")
            field_values["category_id"] = category.id

            if sub_category_code:
                sub_category = await self.sub_category_repository.get_by_code(sub_category_code)
                if sub_category is None:
                    raise ValueError(f"Sub-category code {sub_category_code!r} does not exist.")
                if sub_category.category_id != category.id:
                    raise ValueError(
                        f"Sub-category {sub_category_code!r} does not belong to category {category_code!r}."
                    )
                field_values["sub_category_id"] = sub_category.id

            if brand_code:
                brand = await self.brand_repository.get_by_code(brand_code)
                if brand is None:
                    raise ValueError(f"Brand code {brand_code!r} does not exist.")
                field_values["brand_id"] = brand.id

            if hsn_code:
                hsn = await self.hsn_repository.get_by_code(hsn_code)
                if hsn is None:
                    raise ValueError(f"HSN code {hsn_code!r} does not exist.")
                field_values["hsn_id"] = hsn.id

            uom = await self.uom_repository.get_by_code(uom_code)
            if uom is None:
                raise ValueError(f"UOM code {uom_code!r} does not exist.")
            field_values["uom_id"] = uom.id

            if secondary_uom_code:
                secondary_uom = await self.uom_repository.get_by_code(secondary_uom_code)
                if secondary_uom is None:
                    raise ValueError(f"Secondary UOM code {secondary_uom_code!r} does not exist.")
                field_values["secondary_uom_id"] = secondary_uom.id

            product_code = field_values["product_code"]
            if await self.repository.code_exists(product_code):
                raise ValueError(f"Product code {product_code!r} already exists.")
            return await self.repository.create(**field_values)

        summary = await run_import(rows, row_validator=validate_product_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every product to CSV or XLSX bytes."""
        products = await self.repository.list_all()
        rows = [
            {
                "id": str(p.id),
                "product_code": p.product_code,
                "product_name": p.product_name,
                "barcode": p.barcode,
                "category_id": str(p.category_id),
                "sub_category_id": str(p.sub_category_id) if p.sub_category_id else None,
                "brand_id": str(p.brand_id) if p.brand_id else None,
                "hsn_id": str(p.hsn_id) if p.hsn_id else None,
                "uom_id": str(p.uom_id),
                "secondary_uom_id": str(p.secondary_uom_id) if p.secondary_uom_id else None,
                "specification": p.specification,
                "description": p.description,
                "images": ",".join(p.images) if p.images else None,
                "weight": float(p.weight) if p.weight is not None else None,
                "length": float(p.length) if p.length is not None else None,
                "width": float(p.width) if p.width is not None else None,
                "height": float(p.height) if p.height is not None else None,
                "color": p.color,
                "material": p.material,
                "conversion_factor": float(p.conversion_factor) if p.conversion_factor is not None else None,
                "minimum_order_quantity": float(p.minimum_order_quantity) if p.minimum_order_quantity is not None else None,
                "reorder_level": float(p.reorder_level) if p.reorder_level is not None else None,
                "standard_cost": float(p.standard_cost) if p.standard_cost is not None else None,
                "standard_price": float(p.standard_price) if p.standard_price is not None else None,
                "is_purchasable": p.is_purchasable,
                "is_sellable": p.is_sellable,
                "is_active_for_inventory": p.is_active_for_inventory,
                "status": p.status.value,
                "created_at": p.created_at.isoformat(),
                "updated_at": p.updated_at.isoformat(),
            }
            for p in products
        ]
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Products")
