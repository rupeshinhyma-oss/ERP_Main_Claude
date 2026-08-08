"""
Buyer Repository.

Query-specific extensions for ``buyers`` plus its child tables
(``buyer_emails``, ``buyer_contacts``, and the category/sub-category link
tables). Mirrors :mod:`app.suppliers.repository`'s structure; the
duplicate-detection query differs because the two documents specify
different matching criteria (Buyer: Company Name + Calling Number +
WhatsApp Number; Supplier: Company Name + City).
"""

from __future__ import annotations

import uuid

from sqlalchemy import Select, and_, exists, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.buyers.models import Buyer, BuyerCategoryLink, BuyerContact, BuyerEmail, BuyerSubCategoryLink
from app.common.base_repository import BaseRepository


class BuyerRepository(BaseRepository[Buyer]):
    """Repository for buyer profile rows."""

    searchable_fields = ("company_name",)
    sortable_fields = ("company_name", "created_at", "updated_at", "buyer_grade", "current_status")
    filterable_fields = (
        "country_id",
        "buyer_type",
        "buyer_grade",
        "current_status",
        "potential",
        "is_active",
    )

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Buyer`` model."""
        super().__init__(session, Buyer)

    async def find_duplicate(
        self,
        *,
        company_name: str,
        calling_number: str | None,
        whatsapp_number: str | None,
        exclude_id: uuid.UUID | None = None,
    ) -> Buyer | None:
        """
        Return the first non-deleted buyer matching the document's duplicate rule, if any.

        Document: "For detecting Duplication, Criteria is if matches with
        Company Name, Calling Number and Whatsapp Number." Matching on
        Company Name is case-insensitive and exact (the document does not
        specify fuzzy matching); a match on either phone number field
        alone (given the name also matches) counts as a duplicate, per
        "Currently showing 'it exists' only for calling number, but also
        to do same for whatsapp number."
        """
        phone_conditions = []
        if calling_number:
            phone_conditions.append(Buyer.contact_calling_number == calling_number)
        if whatsapp_number:
            phone_conditions.append(Buyer.contact_whatsapp_number == whatsapp_number)
        if not phone_conditions:
            return None

        stmt = self._base_select().where(Buyer.company_name.ilike(company_name), or_(*phone_conditions))
        if exclude_id is not None:
            stmt = stmt.where(Buyer.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalars().first()

    async def get_with_relations(self, buyer_id: uuid.UUID) -> Buyer | None:
        """Fetch a buyer by ID with its emails/contacts/category links eagerly loaded (all lazy='selectin')."""
        return await self.get_by_id(buyer_id)

    async def list_all(self) -> list[Buyer]:
        """Return every non-deleted buyer, ordered by company name."""
        stmt = self._base_select().order_by(Buyer.company_name)
        result = await self.session.execute(stmt)
        return list(result.scalars().unique().all())

    async def list_all_category_ids(self, buyer_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every product-category ID linked to a buyer."""
        stmt = select(BuyerCategoryLink.category_id).where(BuyerCategoryLink.buyer_id == buyer_id)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def list_all_sub_category_ids(self, buyer_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every product-sub-category ID linked to a buyer."""
        stmt = select(BuyerSubCategoryLink.sub_category_id).where(BuyerSubCategoryLink.buyer_id == buyer_id)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def replace_category_links(self, buyer_id: uuid.UUID, category_ids: list[uuid.UUID]) -> None:
        """Replace a buyer's product-category links with exactly the given set."""
        existing = await self.session.execute(select(BuyerCategoryLink).where(BuyerCategoryLink.buyer_id == buyer_id))
        for link in existing.scalars().all():
            await self.session.delete(link)
        await self.session.flush()
        seen: set[uuid.UUID] = set()
        for category_id in category_ids:
            if category_id in seen:
                continue
            seen.add(category_id)
            self.session.add(BuyerCategoryLink(buyer_id=buyer_id, category_id=category_id))
        await self.session.flush()

    async def replace_sub_category_links(self, buyer_id: uuid.UUID, sub_category_ids: list[uuid.UUID]) -> None:
        """Replace a buyer's product-sub-category links with exactly the given set."""
        existing = await self.session.execute(
            select(BuyerSubCategoryLink).where(BuyerSubCategoryLink.buyer_id == buyer_id)
        )
        for link in existing.scalars().all():
            await self.session.delete(link)
        await self.session.flush()
        seen: set[uuid.UUID] = set()
        for sub_category_id in sub_category_ids:
            if sub_category_id in seen:
                continue
            seen.add(sub_category_id)
            self.session.add(BuyerSubCategoryLink(buyer_id=buyer_id, sub_category_id=sub_category_id))
        await self.session.flush()

    async def replace_emails(self, buyer_id: uuid.UUID, emails: list[str]) -> None:
        """Replace a buyer's email addresses with exactly the given list."""
        existing = await self.session.execute(select(BuyerEmail).where(BuyerEmail.buyer_id == buyer_id))
        for email_row in existing.scalars().all():
            await self.session.delete(email_row)
        await self.session.flush()
        seen: set[str] = set()
        for email in emails:
            normalized = email.strip().lower()
            if normalized in seen:
                continue
            seen.add(normalized)
            self.session.add(BuyerEmail(buyer_id=buyer_id, email=email.strip()))
        await self.session.flush()

    def apply_category_filter(self, stmt: Select, category_id: uuid.UUID) -> Select:
        """Restrict a buyer SELECT to buyers linked to the given product category."""
        return stmt.where(
            exists().where(and_(BuyerCategoryLink.buyer_id == Buyer.id, BuyerCategoryLink.category_id == category_id))
        )

    def apply_sub_category_filter(self, stmt: Select, sub_category_id: uuid.UUID) -> Select:
        """Restrict a buyer SELECT to buyers linked to the given product sub-category."""
        return stmt.where(
            exists().where(
                and_(BuyerSubCategoryLink.buyer_id == Buyer.id, BuyerSubCategoryLink.sub_category_id == sub_category_id)
            )
        )


class BuyerContactRepository(BaseRepository[BuyerContact]):
    """Repository for buyer contact-person rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``BuyerContact`` model."""
        super().__init__(session, BuyerContact)

    async def list_for_buyer(self, buyer_id: uuid.UUID) -> list[BuyerContact]:
        """Return every non-deleted contact for a buyer, primary contact first."""
        stmt = (
            self._base_select()
            .where(BuyerContact.buyer_id == buyer_id)
            .order_by(BuyerContact.is_primary.desc(), BuyerContact.created_at.asc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def get_primary_contact(self, buyer_id: uuid.UUID) -> BuyerContact | None:
        """Return the auto-created primary contact for a buyer, if any."""
        stmt = self._base_select().where(BuyerContact.buyer_id == buyer_id, BuyerContact.is_primary.is_(True))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()
