"""Product Repository. Query-specific extensions for ``products``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.products.models import Product


class ProductRepository(BaseRepository[Product]):
    """Repository for product rows."""

    searchable_fields = ("product_code", "product_name", "product_name_tally", "product_name_invoice", "barcode")
    sortable_fields = ("product_code", "product_name", "created_at", "updated_at", "standard_price")
    filterable_fields = ("status", "category_id", "sub_category_id", "brand_id", "hsn_id", "uom_id", "organization_id")

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Product`` model."""
        super().__init__(session, Product)

    async def get_by_id(self, id_: uuid.UUID) -> Product | None:
        """Fetch a single product by primary key, with its primary supplier's name/city attached."""
        product = await super().get_by_id(id_)
        if product is not None:
            await self.attach_planning_supplier_info([product])
        return product

    async def get_by_ids(self, ids: list[uuid.UUID]) -> dict[uuid.UUID, Product]:
        """Fetch many products by primary key, with each one's primary supplier's name/city attached."""
        records_by_id = await super().get_by_ids(ids)
        if records_by_id:
            await self.attach_planning_supplier_info(list(records_by_id.values()))
        return records_by_id

    async def attach_planning_supplier_info(self, products: list[Product]) -> None:
        """
        Attach each product's supplier's name/city as transient attributes.

        Resolved via ``Product.supplier_id`` -- the direct FK that's
        actually shown as "Supplier" on the Product Master form itself
        (see ``ProductRead.supplier_company_name``, populated the exact
        same way in ``app.masters.products.routes.list_products``) -- NOT
        via ``SupplierProductLink``, which is a SEPARATE many-to-many
        table for a different purpose (a product can be linked to several
        candidate/alternate suppliers there). An earlier version of this
        method queried SupplierProductLink instead, which silently left
        Supplier Name/City blank on Shipment Planning for every product
        that only had its supplier set through the normal "Supplier"
        field on the Product Master form (i.e. nearly every product),
        even though Product Master's own list view showed that supplier
        correctly the whole time.

        Sets ``_planning_supplier_name`` / ``_planning_supplier_city`` on
        each product in place (``None`` when the product has no supplier
        set, or that supplier has no city set); read back via
        ``app.planning.source_registry``'s product value_getter.

        One query total regardless of how many products are passed in,
        so this is safe to call for a whole sheet's worth of rows without
        turning "load the grid" into N+1 queries.
        """
        if not products:
            return
        from sqlalchemy import select

        from app.masters.cities.models import City
        from app.suppliers.models import Supplier

        supplier_ids = list({p.supplier_id for p in products if p.supplier_id})
        name_and_city_by_supplier_id: dict[uuid.UUID, tuple[str, str | None]] = {}
        if supplier_ids:
            stmt = (
                select(Supplier.id, Supplier.company_name, City.name)
                .outerjoin(City, City.id == Supplier.city_id)
                .where(Supplier.id.in_(supplier_ids))
            )
            result = await self.session.execute(stmt)
            name_and_city_by_supplier_id = {row[0]: (row[1], row[2]) for row in result.all()}

        for product in products:
            name, city = (
                name_and_city_by_supplier_id.get(product.supplier_id) if product.supplier_id else None
            ) or (None, None)
            product._planning_supplier_name = name
            product._planning_supplier_city = city

    def _apply_search(self, stmt, term: str | None):
        """Apply a flexible, space-normalized case-insensitive search across searchable_fields."""
        if not term:
            return stmt

        from sqlalchemy import func, or_

        clean_term = term.replace(" ", "").replace("-", "").lower()
        pattern = f"%{term}%"
        clean_pattern = f"%{clean_term}%"

        conditions = []
        for field in ("product_code", "product_name", "product_name_tally", "product_name_invoice", "barcode"):
            if hasattr(self.model, field):
                col = getattr(self.model, field)
                conditions.append(col.ilike(pattern))
                normalized_col = func.lower(func.replace(func.replace(col, " ", ""), "-", ""))
                conditions.append(normalized_col.like(clean_pattern))

        return stmt.where(or_(*conditions))

    async def get_by_code(self, product_code: str) -> Product | None:
        """Fetch a product by its unique code."""
        stmt = self._base_select().where(Product.product_code == product_code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, product_code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another product already uses this code."""
        from sqlalchemy import select
        stmt = select(Product.id).where(Product.product_code == product_code)
        if exclude_id is not None:
            stmt = stmt.where(Product.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[Product]:
        """Return every non-deleted product, ordered by name."""
        stmt = self._base_select().order_by(Product.product_name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, product_id: uuid.UUID) -> bool:
        """
        Return True if any other module references this product.

        Products is the central item master every other module keys off
        of rather than duplicating (see this module's docstring), so this
        check grows as new modules link to Product by foreign key.
        Currently checks: Suppliers (``supplier_product_links``). Future
        modules (Inventory, Sales, Purchase) should extend this same
        method rather than adding their own separate "can I delete this
        product" check.
        """
        from sqlalchemy import exists, select

        from app.suppliers.models import SupplierProductLink

        stmt = select(exists().where(SupplierProductLink.product_id == product_id))
        result = await self.session.execute(stmt)
        return bool(result.scalar())