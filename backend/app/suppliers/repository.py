"""
Supplier Repository.

Query-specific extensions for ``suppliers`` plus its child tables
(``supplier_emails``, ``supplier_contacts``, and the category/sub-category
link tables). All many-to-many and one-to-many child rows are managed here
so the service layer never touches SQLAlchemy constructs directly, per the
existing architecture's repository/service split.
"""

from __future__ import annotations

import uuid

from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.suppliers.models import (
    Supplier,
    SupplierCategoryLink,
    SupplierContact,
    SupplierEmail,
    SupplierProductLink,
    SupplierSubCategoryLink,
)


class SupplierRepository(BaseRepository[Supplier]):
    """Repository for supplier profile rows."""

    searchable_fields = ("company_name",)
    sortable_fields = (
        "company_name",
        "created_at",
        "updated_at",
        "supplier_grade",
        "current_status",
    )
    filterable_fields = (
        "status",  # not a real column on Supplier -- present for BaseRepository symmetry; unused here
        "country_id",
        "state_id",
        "city_id",
        "supplier_type",
        "supplier_grade",
        "current_status",
        "potential",
        "is_active",
        "visited_factory_office",
    )

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Supplier`` model."""
        super().__init__(session, Supplier)

    def _base_select(self) -> Select:
        """Exclude soft-deleted suppliers, same as the generic BaseRepository behavior."""
        return super()._base_select()

    async def name_city_exists(
        self, company_name: str, city_id: uuid.UUID, *, exclude_id: uuid.UUID | None = None
    ) -> bool:
        """
        Return True if a non-deleted supplier with this Company Name + City already exists.

        Implements the document's duplicate-detection rule: "if matches
        with 'Name of Company' & 'City', then to consider as duplicate".
        Matching is case-insensitive on the name, since the document
        itself flags "Co or company, ltd or limited" as a real-world
        near-duplicate risk it does not resolve -- exact case-insensitive
        string match is the documented rule; fuzzy/normalized matching is
        explicitly left as a future enhancement, not invented here.
        """
        stmt = (
            self._base_select()
            .with_only_columns(Supplier.id)
            .where(Supplier.city_id == city_id, Supplier.company_name.ilike(company_name))
        )
        if exclude_id is not None:
            stmt = stmt.where(Supplier.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name_city(
        self, company_name: str, city_id: uuid.UUID, *, exclude_id: uuid.UUID | None = None
    ) -> Supplier | None:
        """Fetch the supplier matching this Company Name + City, if one exists (for duplicate-compare)."""
        stmt = self._base_select().where(Supplier.city_id == city_id, Supplier.company_name.ilike(company_name))
        if exclude_id is not None:
            stmt = stmt.where(Supplier.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_with_relations(self, supplier_id: uuid.UUID) -> Supplier | None:
        """Fetch a supplier by ID with its emails/contacts/category links eagerly loaded."""
        # emails/contacts/category_links/sub_category_links are all
        # lazy="selectin" on the model, so a plain get_by_id already loads
        # them; this method exists as an explicit, self-documenting entry
        # point for "give me the fully-populated supplier".
        return await self.get_by_id(supplier_id)

    async def list_all(self) -> list[Supplier]:
        """Return every non-deleted supplier, ordered by company name (used for export)."""
        stmt = self._base_select().order_by(Supplier.company_name)
        result = await self.session.execute(stmt)
        return list(result.scalars().unique().all())

    async def list_all_category_ids(self, supplier_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every product-category ID linked to a supplier."""
        stmt = select(SupplierCategoryLink.category_id).where(SupplierCategoryLink.supplier_id == supplier_id)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_all_sub_category_ids(self, supplier_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every product-sub-category ID linked to a supplier."""
        stmt = select(SupplierSubCategoryLink.sub_category_id).where(
            SupplierSubCategoryLink.supplier_id == supplier_id
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def replace_category_links(self, supplier_id: uuid.UUID, category_ids: list[uuid.UUID]) -> None:
        """Replace a supplier's product-category links with exactly the given set."""
        existing = await self.session.execute(
            select(SupplierCategoryLink).where(SupplierCategoryLink.supplier_id == supplier_id)
        )
        for link in existing.scalars().all():
            await self.session.delete(link)
        await self.session.flush()
        for category_id in category_ids:
            self.session.add(SupplierCategoryLink(supplier_id=supplier_id, category_id=category_id))
        await self.session.flush()

    async def replace_sub_category_links(self, supplier_id: uuid.UUID, sub_category_ids: list[uuid.UUID]) -> None:
        """Replace a supplier's product-sub-category links with exactly the given set."""
        existing = await self.session.execute(
            select(SupplierSubCategoryLink).where(SupplierSubCategoryLink.supplier_id == supplier_id)
        )
        for link in existing.scalars().all():
            await self.session.delete(link)
        await self.session.flush()
        for sub_category_id in sub_category_ids:
            self.session.add(
                SupplierSubCategoryLink(supplier_id=supplier_id, sub_category_id=sub_category_id)
            )
        await self.session.flush()

    async def list_all_product_ids(self, supplier_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every Product ID linked to a supplier (the specific SKUs this supplier supplies)."""
        stmt = select(SupplierProductLink.product_id).where(SupplierProductLink.supplier_id == supplier_id)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def replace_product_links(self, supplier_id: uuid.UUID, product_ids: list[uuid.UUID]) -> None:
        """Replace a supplier's linked-product set with exactly the given set."""
        existing = await self.session.execute(
            select(SupplierProductLink).where(SupplierProductLink.supplier_id == supplier_id)
        )
        for link in existing.scalars().all():
            await self.session.delete(link)
        await self.session.flush()
        seen: set[uuid.UUID] = set()
        for product_id in product_ids:
            if product_id in seen:
                continue
            seen.add(product_id)
            self.session.add(SupplierProductLink(supplier_id=supplier_id, product_id=product_id))
        await self.session.flush()

    def apply_product_filter(self, stmt: Select, product_id: uuid.UUID) -> Select:
        """Restrict a supplier SELECT to suppliers linked to the given product."""
        return stmt.where(
            exists().where(
                and_(
                    SupplierProductLink.supplier_id == Supplier.id,
                    SupplierProductLink.product_id == product_id,
                )
            )
        )

    async def replace_emails(self, supplier_id: uuid.UUID, emails: list[str]) -> None:
        """Replace a supplier's email addresses with exactly the given list."""
        existing = await self.session.execute(select(SupplierEmail).where(SupplierEmail.supplier_id == supplier_id))
        for email_row in existing.scalars().all():
            await self.session.delete(email_row)
        await self.session.flush()
        seen: set[str] = set()
        for email in emails:
            normalized = email.strip().lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            self.session.add(SupplierEmail(supplier_id=supplier_id, email=email.strip()))
        await self.session.flush()

    def apply_category_filter(self, stmt: Select, category_id: uuid.UUID) -> Select:
        """Restrict a supplier SELECT to suppliers linked to the given product category."""
        return stmt.where(
            exists().where(
                and_(
                    SupplierCategoryLink.supplier_id == Supplier.id,
                    SupplierCategoryLink.category_id == category_id,
                )
            )
        )

    def apply_sub_category_filter(self, stmt: Select, sub_category_id: uuid.UUID) -> Select:
        """Restrict a supplier SELECT to suppliers linked to the given product sub-category."""
        return stmt.where(
            exists().where(
                and_(
                    SupplierSubCategoryLink.supplier_id == Supplier.id,
                    SupplierSubCategoryLink.sub_category_id == sub_category_id,
                )
            )
        )


class SupplierContactRepository(BaseRepository[SupplierContact]):
    """Repository for supplier contact-person rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``SupplierContact`` model."""
        super().__init__(session, SupplierContact)

    async def list_for_supplier(self, supplier_id: uuid.UUID) -> list[SupplierContact]:
        """Return every non-deleted contact for a supplier, primary contact first."""
        stmt = (
            self._base_select()
            .where(SupplierContact.supplier_id == supplier_id)
            .order_by(SupplierContact.is_primary.desc(), SupplierContact.created_at.asc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_primary_contact(self, supplier_id: uuid.UUID) -> SupplierContact | None:
        """Return the auto-created primary contact for a supplier, if any."""
        stmt = self._base_select().where(
            SupplierContact.supplier_id == supplier_id, SupplierContact.is_primary.is_(True)
        )
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()
