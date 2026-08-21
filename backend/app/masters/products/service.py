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
    model_to_dict,
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
from app.planning.ws_manager import notify_source_record_changed, refresh_planning_cells_for_record


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
        if not product_code:
            import random
            field_values["product_code"] = f"PRD-{random.randint(100000, 999999)}"
        else:
            existing = await self.repository.get_by_code(product_code)
            if existing is not None:
                raise ConflictException(
                    f"Product code {product_code!r} is already in use.",
                    details={"existing": model_to_dict(existing)},
                )
        await self._validate_references(field_values)

        # Handle Tally product name aliases
        p_tally = field_values.get("product_name_tally")
        p_name = field_values.get("product_name")
        if p_tally and not p_name:
            field_values["product_name"] = p_tally
        elif p_name and not p_tally:
            field_values["product_name_tally"] = p_name

        # Validate Packaging Gross Weight (kg) is mandatory and > 0
        gross_wt = field_values.get("packaging_gross_weight")
        if gross_wt is None or float(gross_wt) <= 0:
            raise BadRequestException("Packaging Gross Weight (kg) is required and must be greater than 0.")

        if field_values.get("weight") is None:
            field_values["weight"] = gross_wt

        # Auto-compute CBM if dimensions present, or validate explicit CBM
        l = field_values.get("length_cm") or field_values.get("length")
        w = field_values.get("width_cm") or field_values.get("width")
        h = field_values.get("height_cm") or field_values.get("height")
        if (field_values.get("packaging_unit_cbm") is None or float(field_values.get("packaging_unit_cbm", 0) or 0) <= 0) and (
            l is not None and w is not None and h is not None and float(l) > 0 and float(w) > 0 and float(h) > 0
        ):
            field_values["packaging_unit_cbm"] = round((float(l) * float(w) * float(h)) / 1000000.0, 6)

        cbm = field_values.get("packaging_unit_cbm")
        if cbm is None or float(cbm) <= 0:
            raise BadRequestException("Packaging Unit CBM is required (provide Length, Width, Height to calculate automatically or provide Packaging Unit CBM directly).")

        # Auto-inherit refund_vat_percent from HSN if not explicitly set
        hsn_id = field_values.get("hsn_id")
        if hsn_id and field_values.get("refund_vat_percent") is None:
            hsn_obj = await self.hsn_repository.get_by_id(hsn_id)
            if hsn_obj and getattr(hsn_obj, "refund_vat_percent", None) is not None:
                field_values["refund_vat_percent"] = hsn_obj.refund_vat_percent

        if field_values.get("refund_vat_percent") is None:
            field_values["refund_vat_percent"] = 0.0

        if "organization_ids" in field_values and field_values["organization_ids"] is not None:
            field_values["organization_ids"] = [str(x) for x in field_values["organization_ids"]]

        product = await self.repository.create(**field_values)
        await self._invalidate_cache()
        return product

    async def update(self, product_id: uuid.UUID, **field_values: Any) -> Product:
        """Update an existing product, validating code uniqueness and every foreign-key reference."""
        product = await self.get_by_id_or_raise(product_id)
        product_code = field_values.get("product_code")
        if product_code:
            existing = await self.repository.get_by_code(product_code)
            if existing is not None and existing.id != product_id:
                raise ConflictException(
                    f"Product code {product_code!r} is already in use.",
                    details={"existing": model_to_dict(existing)},
                )

        merged = {
            "category_id": field_values.get("category_id", product.category_id),
            "sub_category_id": field_values.get("sub_category_id", product.sub_category_id),
            "brand_id": field_values.get("brand_id", product.brand_id),
            "hsn_id": field_values.get("hsn_id", product.hsn_id),
            "uom_id": field_values.get("uom_id", product.uom_id),
            "secondary_uom_id": field_values.get("secondary_uom_id", product.secondary_uom_id),
        }
        await self._validate_references(merged)

        # Auto-compute CBM if dimensions updated
        l = field_values.get("length_cm") if "length_cm" in field_values else (field_values.get("length") or product.length_cm or product.length)
        w = field_values.get("width_cm") if "width_cm" in field_values else (field_values.get("width") or product.width_cm or product.width)
        h = field_values.get("height_cm") if "height_cm" in field_values else (field_values.get("height") or product.height_cm or product.height)
        if l is not None and w is not None and h is not None:
            field_values["packaging_unit_cbm"] = round((float(l) * float(w) * float(h)) / 1000000.0, 6)

        if "organization_ids" in field_values and field_values["organization_ids"] is not None:
            field_values["organization_ids"] = [str(x) for x in field_values["organization_ids"]]

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(product, **changes)
        await self._invalidate_cache()
        # Best-effort, never raises: tells any already-open Shipment
        # Planning tab whose ITEM column (or any other LINKED_LOOKUP/
        # AGGREGATE column) is linked to this exact product to refresh it
        # live, instead of only picking up the change on next reload.
        await notify_source_record_changed("product", product.id)
        # Persist the actual recomputed values into every affected
        # Planning cell's stored value (not just notify already-open
        # tabs) -- this is what lets a grid load stay a plain read with
        # zero computation, per the store-on-write architecture (see
        # PlanningService.recompute_and_store_cells_referencing_record).
        # Uses THIS request's own session so the cell refresh commits
        # together with the product edit itself.
        await refresh_planning_cells_for_record(self.repository.session, "product", product.id)
        return product

    async def activate(self, product_id: uuid.UUID) -> Product:
        """Set a product's status to ACTIVE."""
        return await self.update(product_id, status=RecordStatus.ACTIVE)

    async def deactivate(self, product_id: uuid.UUID) -> Product:
        """Set a product's status to INACTIVE only if stock is zero."""
        product = await self.get_by_id_or_raise(product_id)
        if getattr(product, "current_stock", 0) != 0:
            raise BadRequestException("Product cannot be set to Inactive when current stock is non-zero.")
        return await self.update(product_id, status=RecordStatus.INACTIVE)

    async def delete(self, product_id: uuid.UUID) -> None:
        """Soft-delete a product, requiring status to be Inactive and stock = 0."""
        product = await self.get_by_id_or_raise(product_id)
        if product.status != RecordStatus.INACTIVE:
            raise BadRequestException("Product deletion is allowed only if status is Inactive.")
        if getattr(product, "current_stock", 0) != 0:
            raise BadRequestException("Product deletion is allowed only if stock is Zero.")
        if await self.repository.is_referenced(product_id):
            raise ConflictException("This product cannot be deleted because it is referenced elsewhere.")
        await self.repository.delete(product)
        await self._invalidate_cache()
        # A deleted product can still affect Planning: any AGGREGATE
        # column filtering on status (e.g. "count of active products in
        # category X") may need its stored count/sum to drop, and any
        # cell still explicitly linked to this now-deleted product should
        # reflect that it's gone rather than keep showing stale data.
        await notify_source_record_changed("product", product_id)
        await refresh_planning_cells_for_record(self.repository.session, "product", product_id)

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """Validate and import products from an uploaded CSV/XLSX file."""
        rows = parse_rows_from_file(filename, raw_bytes)

        # Lookup maps for clean human-readable duplicate comparison (resolved names, zero UUIDs)
        categories_map = {str(c.id): c.name for c in await self.category_repository.list(limit=2000)}
        sub_categories_map = {str(sc.id): sc.name for sc in await self.sub_category_repository.list(limit=3000)}
        brands_map = {str(b.id): b.name for b in await self.brand_repository.list(limit=2000)}
        hsns_map = {str(h.id): h.code for h in await self.hsn_repository.list(limit=2000)}
        uoms_map = {str(u.id): (u.short_name or u.name or u.code) for u in await self.uom_repository.list(limit=2000)}

        def _serialize_for_compare(p: Product) -> dict[str, Any]:
            return {
                "Product Name (As Per Tally)": p.product_name_tally or p.product_name or "—",
                "Product Code": p.product_code or "—",
                "Brand": brands_map.get(str(p.brand_id), "—") if p.brand_id else "—",
                "Category": categories_map.get(str(p.category_id), "—") if p.category_id else "—",
                "Sub Category": sub_categories_map.get(str(p.sub_category_id), "—") if p.sub_category_id else "—",
                "HSN Code": hsns_map.get(str(p.hsn_id), "—") if p.hsn_id else "—",
                "UOM": uoms_map.get(str(p.uom_id), "—") if p.uom_id else "—",
                "Pack. Qty": p.packaging_quantity if p.packaging_quantity is not None else "—",
                "Pack. Net Weight": p.packaging_net_weight if p.packaging_net_weight is not None else "—",
                "Pack. Gross Weight": p.packaging_gross_weight if p.packaging_gross_weight is not None else "—",
                "Length (cm)": getattr(p, "length_cm", None) or getattr(p, "length", "—") or "—",
                "Width (cm)": getattr(p, "width_cm", None) or getattr(p, "width", "—") or "—",
                "Height (cm)": getattr(p, "height_cm", None) or getattr(p, "height", "—") or "—",
                "Pack. Unit CBM": p.packaging_unit_cbm if p.packaging_unit_cbm is not None else "—",
                "Refund VAT %": p.refund_vat_percent if p.refund_vat_percent is not None else "—",
                "Compliance & License Requirements": p.license_certificate_required or "—",
                "Status": (p.status.value if hasattr(p.status, "value") else str(p.status or "active")).capitalize(),
            }

        async def _create(field_values: dict[str, Any]) -> Product:
            category_code = field_values.pop("category_code")
            sub_category_code = field_values.pop("sub_category_code", None)
            brand_code = field_values.pop("brand_code", None)
            hsn_code = field_values.pop("hsn_code", None)
            uom_code = field_values.pop("uom_code")
            secondary_uom_code = field_values.pop("secondary_uom_code", None)

            category = await self.category_repository.get_by_code(category_code)
            if category is None:
                cat_list = await self.category_repository.list(limit=500)
                category = next((c for c in cat_list if c.code.lower() == category_code.lower() or c.name.lower() == category_code.lower()), None)
            if category is None:
                raise BadRequestException(f"Category '{category_code}' does not exist in Category Master.")
            field_values["category_id"] = category.id

            if sub_category_code:
                sub_category = await self.sub_category_repository.get_by_code(sub_category_code)
                if sub_category is None:
                    sub_cats = await self.sub_category_repository.list(limit=1000)
                    sub_category = next((sc for sc in sub_cats if sc.code.lower() == sub_category_code.lower() or sc.name.lower() == sub_category_code.lower()), None)
                if sub_category is None:
                    raise BadRequestException(f"Sub Category '{sub_category_code}' does not exist in Sub Category Master.")
                if sub_category.category_id != category.id:
                    raise BadRequestException(f"Sub Category '{sub_category.name}' does not belong to Category '{category.name}'.")
                field_values["sub_category_id"] = sub_category.id

            if brand_code:
                brand = await self.brand_repository.get_by_code(brand_code)
                if brand is None:
                    brands = await self.brand_repository.list(limit=500)
                    brand = next((b for b in brands if b.code.lower() == brand_code.lower() or b.name.lower() == brand_code.lower()), None)
                if brand is None:
                    raise BadRequestException(f"Brand '{brand_code}' does not exist in Brand Master.")
                field_values["brand_id"] = brand.id

            if hsn_code:
                hsn = await self.hsn_repository.get_by_code(hsn_code)
                if hsn is None:
                    hsns = await self.hsn_repository.list(limit=1000)
                    hsn = next((h for h in hsns if h.code.lower() == str(hsn_code).lower()), None)
                if hsn is None:
                    raise BadRequestException(f"HSN Code '{hsn_code}' does not exist in HSN Master.")
                field_values["hsn_id"] = hsn.id

            uom = await self.uom_repository.get_by_code(uom_code)
            if uom is None:
                uoms = await self.uom_repository.list(limit=500)
                uom = next((u for u in uoms if u.code.lower() == uom_code.lower() or u.name.lower() == uom_code.lower() or (u.short_name and u.short_name.lower() == uom_code.lower())), None)
            if uom is None:
                raise BadRequestException(f"UOM '{uom_code}' does not exist in UOM Master.")
            field_values["uom_id"] = uom.id

            raw_product_code = field_values.get("product_code")
            product_name = (field_values.get("product_name_tally") or field_values.get("product_name") or "").strip()
            clean_name_key = product_name.lower().replace(" ", "").replace("-", "")
            clean_code_key = (raw_product_code or "").strip().lower()

            if clean_name_key in seen_names:
                raise ConflictException(
                    f"Product '{product_name}' appears multiple times in the import file (in-file duplicate)."
                )
            if clean_code_key and clean_code_key in seen_codes:
                raise ConflictException(
                    f"Product Code '{raw_product_code}' appears multiple times in the import file (in-file duplicate)."
                )

            # Check if Product Name already exists in DB
            if product_name:
                from sqlalchemy import select, or_
                stmt_dup = select(Product).where(
                    or_(
                        Product.product_name_tally.ilike(product_name),
                        Product.product_name.ilike(product_name),
                    )
                )
                res_dup = await self.repository.session.execute(stmt_dup)
                existing_dup = res_dup.scalars().first()
                if existing_dup is not None:
                    raise ConflictException(
                        f"Product '{product_name}' already exists in Product Master (Code: {existing_dup.product_code}) — duplicate skipped.",
                        details={"existing": _serialize_for_compare(existing_dup)},
                    )

            # Check if Product Code already exists in DB
            if raw_product_code:
                existing_code = await self.repository.get_by_code(raw_product_code)
                if existing_code is not None:
                    raise ConflictException(
                        f"Product Code '{raw_product_code}' already exists in Product Master (used by '{existing_code.product_name_tally or existing_code.product_name}') — duplicate skipped.",
                        details={"existing": _serialize_for_compare(existing_code)},
                    )

            created_prod = await self.repository.create(**field_values)
            seen_names.add(clean_name_key)
            if clean_code_key:
                seen_codes.add(clean_code_key)
            return created_prod

        seen_names: set[str] = set()
        seen_codes: set[str] = set()
        summary = await run_import(
            rows, row_validator=validate_product_row, row_creator=_create
        )
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every product to CSV or XLSX bytes with clean, resolved business headers matching UI sequence."""
        from sqlalchemy import select
        from app.masters.company_list.models import MasterCompany

        products = await self.repository.list_all()

        # Batch resolve lookup names
        categories = {str(c.id): c.name for c in await self.category_repository.list(limit=2000)}
        sub_categories = {str(sc.id): sc.name for sc in await self.sub_category_repository.list(limit=3000)}
        brands = {str(b.id): b.name for b in await self.brand_repository.list(limit=2000)}
        hsns = {str(h.id): h.code for h in await self.hsn_repository.list(limit=2000)}
        uoms = {str(u.id): (u.short_name or u.name or u.code) for u in await self.uom_repository.list(limit=2000)}

        # Organizations
        org_res = await self.repository.session.execute(select(MasterCompany.id, MasterCompany.name, MasterCompany.branches))
        orgs: dict[str, str] = {}
        branch_map: dict[str, str] = {}
        for row in org_res:
            orgs[str(row.id)] = row.name
            if row.branches and isinstance(row.branches, list):
                for b in row.branches:
                    if isinstance(b, dict) and "id" in b:
                        branch_map[str(b["id"])] = b.get("name", "")

        rows = []
        for p in products:
            l = getattr(p, "length_cm", None) or getattr(p, "length", None)
            w = getattr(p, "width_cm", None) or getattr(p, "width", None)
            h = getattr(p, "height_cm", None) or getattr(p, "height", None)
            status_str = p.status.value if hasattr(p.status, "value") else str(p.status)

            org_ids = p.organization_ids if (p.organization_ids and isinstance(p.organization_ids, list)) else ([str(p.organization_id)] if p.organization_id else [])
            org_names = [orgs.get(str(oid), "") for oid in org_ids if orgs.get(str(oid))]
            branch_ids = p.branch_ids if (p.branch_ids and isinstance(p.branch_ids, list)) else []
            branch_names = [branch_map.get(str(bid), "") for bid in branch_ids if branch_map.get(str(bid))]

            cbm_val = p.packaging_unit_cbm
            if cbm_val is None and l is not None and w is not None and h is not None:
                cbm_val = round((float(l) * float(w) * float(h)) / 1000000.0, 6)

            gross_wt = p.packaging_gross_weight if p.packaging_gross_weight is not None else p.weight

            rows.append({
                "Product Name (As Per Tally)": p.product_name_tally or p.product_name or "",
                "Product Code": p.product_code or "",
                "Brand": brands.get(str(p.brand_id), "") if p.brand_id else "",
                "Category": categories.get(str(p.category_id), "") if p.category_id else "",
                "Sub Category": sub_categories.get(str(p.sub_category_id), "") if p.sub_category_id else "",
                "HSN Code": hsns.get(str(p.hsn_id), "") if p.hsn_id else "",
                "UOM": uoms.get(str(p.uom_id), "") if p.uom_id else "",
                "Organization": ", ".join(org_names),
                "Branches": ", ".join(branch_names),
                "Pack. Qty": float(p.packaging_quantity) if p.packaging_quantity is not None else "",
                "Pack. Net Weight": float(p.packaging_net_weight) if p.packaging_net_weight is not None else "",
                "Pack. Gross Weight": float(gross_wt) if gross_wt is not None else "",
                "Length (cm)": float(l) if l is not None else "",
                "Width (cm)": float(w) if w is not None else "",
                "Height (cm)": float(h) if h is not None else "",
                "Pack. Unit CBM": float(cbm_val) if cbm_val is not None else "",
                "Refund VAT %": float(p.refund_vat_percent) if p.refund_vat_percent is not None else "",
                "Compliance & License Requirements": p.license_certificate_required or "",
                "Specification": p.specification or p.description or "",
                "Status": status_str,
            })

        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Products")