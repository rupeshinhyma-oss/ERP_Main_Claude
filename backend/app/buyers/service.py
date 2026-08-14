"""
Buyer Service.

Business logic for buyer (client) CRUD, encoding every rule from the "Add
Buyer (Client) Data Form" specification document's Notes section:

- Duplicate detection: Company Name + Calling Number + WhatsApp Number
  match is rejected as a duplicate (matching on either phone field counts,
  given the company name also matches).
- Current Status may only move NEW -> EXISTING, never back.
- Delete is only permitted when Current Status is New/unset AND Potential
  is No/unset; otherwise the record can only be deactivated (is_active=False).
- The main form's contact fields are mirrored into a primary BuyerContact
  row automatically, so "Main Form contact details should appear in the
  Contact list also."

Mirrors :mod:`app.suppliers.service` structurally; differs where the two
documents' rules genuinely differ (duplicate criteria, no State/City FK
for buyers -- just Country + a free-text City field).
"""

from __future__ import annotations

import uuid
from typing import Any

from app.buyers.models import Buyer, BuyerContact, BuyerCurrentStatus
from app.buyers.repository import BuyerContactRepository, BuyerRepository
from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.masters.countries.repository import CountryRepository
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository

DROPDOWN_CACHE_NAME = "buyers"


class BuyerService:
    """Orchestrates buyer (client) profile management on top of :class:`BuyerRepository`."""

    not_found_message = "Buyer not found."

    def __init__(
        self,
        repository: BuyerRepository,
        contact_repository: BuyerContactRepository,
        country_repository: CountryRepository,
        category_repository: ProductCategoryRepository,
        sub_category_repository: ProductSubCategoryRepository,
        cache_manager: CacheManager,
    ) -> None:
        self.repository = repository
        self.contact_repository = contact_repository
        self.country_repository = country_repository
        self.category_repository = category_repository
        self.sub_category_repository = sub_category_repository
        self.cache_manager = cache_manager

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    async def get_by_id_or_raise(self, buyer_id: uuid.UUID) -> Buyer:
        buyer = await self.repository.get_with_relations(buyer_id)
        if buyer is None:
            raise NotFoundException(self.not_found_message)
        return buyer

    async def list_paginated(
        self,
        query: ListQueryParams,
        *,
        category_id: uuid.UUID | None = None,
        sub_category_id: uuid.UUID | None = None,
    ) -> tuple[list[Buyer], int]:
        """
        Return a page of buyers matching search/sort/filter, plus the
        document's Top Filter Fields for Product Category and Product Sub
        Category -- both many-to-many, so handled outside the generic
        single-value filter framework, mirroring
        ``SupplierService.list_paginated``.
        """
        if category_id is None and sub_category_id is None:
            return await self.repository.paginated_list(query)

        base_stmt = self.repository._base_select()
        base_stmt = self.repository._apply_search(base_stmt, query.search.normalized)
        base_stmt = self.repository._apply_dynamic_filters(base_stmt, query.filters)
        if category_id is not None:
            base_stmt = self.repository.apply_category_filter(base_stmt, category_id)
        if sub_category_id is not None:
            base_stmt = self.repository.apply_sub_category_filter(base_stmt, sub_category_id)

        from sqlalchemy import func, select

        count_stmt = select(func.count()).select_from(base_stmt.subquery())
        total = int((await self.repository.session.execute(count_stmt)).scalar_one())

        list_stmt = self.repository._apply_sort(base_stmt, query.sort)
        list_stmt = list_stmt.offset(query.page.offset).limit(query.page.limit)
        result = await self.repository.session.execute(list_stmt)
        items = list(result.scalars().unique().all())
        return items, total

    async def get_category_ids(self, buyer_id: uuid.UUID) -> list[uuid.UUID]:
        return await self.repository.list_all_category_ids(buyer_id)

    async def get_sub_category_ids(self, buyer_id: uuid.UUID) -> list[uuid.UUID]:
        return await self.repository.list_all_sub_category_ids(buyer_id)

    async def list_contacts(self, buyer_id: uuid.UUID) -> list[BuyerContact]:
        return await self.contact_repository.list_for_buyer(buyer_id)

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------

    async def _validate_country(self, country_id: uuid.UUID) -> None:
        if await self.country_repository.get_by_id(country_id) is None:
            raise BadRequestException("The specified country does not exist.")

    async def _validate_categories(self, category_ids: list[uuid.UUID]) -> None:
        """
        Validate every category ID exists in ONE query, not one query per ID.

        Phase 3 N+1 fix: this used to call ``get_by_id`` in a loop --
        for a buyer with, say, 5 categories selected, that was 5
        sequential round trips on every single create/update, purely for
        validation. ``BaseRepository.get_by_ids`` (already used
        elsewhere for exactly this reason -- see Shipment Planning's
        linked-record resolution) fetches every row in a single
        ``WHERE id IN (...)`` query instead.
        """
        if not category_ids:
            return
        found = await self.category_repository.get_by_ids(category_ids)
        missing = [str(cid) for cid in category_ids if cid not in found]
        if missing:
            raise BadRequestException(f"Product category {missing[0]} does not exist.")

    async def _validate_sub_categories(self, sub_category_ids: list[uuid.UUID]) -> None:
        """Validate every sub-category ID exists in ONE query -- see ``_validate_categories``'s docstring."""
        if not sub_category_ids:
            return
        found = await self.sub_category_repository.get_by_ids(sub_category_ids)
        missing = [str(sid) for sid in sub_category_ids if sid not in found]
        if missing:
            raise BadRequestException(f"Product sub-category {missing[0]} does not exist.")

    def _validate_potential_reason(self, potential: Any, potential_reason: str | None) -> None:
        """Document: "If Potential is No, then reason" -- reason is only meaningful when Potential is No."""
        if potential_reason and potential is not None and getattr(potential, "value", potential) != "no":
            raise BadRequestException("Potential Reason can only be set when Potential is 'No'.")

    def _validate_status_transition(self, existing_status: BuyerCurrentStatus | None, new_status: Any) -> None:
        """Document Notes: "once changed to Existing, then it cannot change back to new, means 1 way only"."""
        if new_status is None:
            return
        if existing_status == BuyerCurrentStatus.EXISTING and new_status == BuyerCurrentStatus.NEW:
            raise ConflictException("Current Status cannot be changed from 'Existing' back to 'New'.")

    def _can_delete(self, buyer: Buyer) -> bool:
        """
        Document Notes: "If Current Status is 'New or Select' and
        Potential is 'No or Select', then only to allow Delete. If Current
        Status is 'Existing' or Potential is 'Yes' (any one), cannot
        DELETE that data. However, can make it 'Inactive'".
        """
        status_blocks_delete = buyer.current_status == BuyerCurrentStatus.EXISTING
        potential_blocks_delete = buyer.potential is not None and buyer.potential.value == "yes"
        return not (status_blocks_delete or potential_blocks_delete)

    async def _invalidate_cache(self) -> None:
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    # ------------------------------------------------------------------
    # Create / Update
    # ------------------------------------------------------------------

    async def create(self, **field_values: Any) -> Buyer:
        """
        Create a new buyer profile.

        Validates country existence and category/sub-category existence;
        enforces the Company-Name+Calling-Number+WhatsApp duplicate rule
        and the potential-reason rule; mirrors the main form's contact
        into a primary BuyerContact row; and persists emails/category/
        sub-category links.
        """
        company_name = field_values["company_name"]
        country_id = field_values["country_id"]
        category_ids = field_values.pop("category_ids", []) or []
        sub_category_ids = field_values.pop("sub_category_ids", []) or []
        emails = field_values.pop("emails", []) or []

        await self._validate_country(country_id)
        await self._validate_categories(category_ids)
        await self._validate_sub_categories(sub_category_ids)
        self._validate_potential_reason(field_values.get("potential"), field_values.get("potential_reason"))

        duplicate = await self.repository.find_duplicate(
            company_name=company_name,
            calling_number=field_values.get("contact_calling_number"),
            whatsapp_number=field_values.get("contact_whatsapp_number"),
        )
        if duplicate is not None:
            raise ConflictException(
                f"A buyer named {company_name!r} already exists with a matching calling or WhatsApp number "
                "(duplicate check: Company Name + Calling Number + WhatsApp Number)."
            )

        buyer = await self.repository.create(**field_values)

        await self.repository.replace_category_links(buyer.id, category_ids)
        await self.repository.replace_sub_category_links(buyer.id, sub_category_ids)
        await self.repository.replace_emails(buyer.id, emails)

        # Mirror the main form's contact into the contacts list, per the
        # document's Note. Only created if a contact name was provided.
        if field_values.get("contact_full_name"):
            await self.contact_repository.create(
                buyer_id=buyer.id,
                salutation=field_values.get("contact_salutation"),
                person_name=field_values["contact_full_name"],
                designation=field_values.get("contact_designation"),
                country_id=country_id,
                calling_number=field_values.get("contact_calling_number"),
                whatsapp_number=field_values.get("contact_whatsapp_number"),
                email=emails[0] if emails else None,
                is_primary=True,
            )

        await self._invalidate_cache()
        return await self.get_by_id_or_raise(buyer.id)

    async def update(self, buyer_id: uuid.UUID, **field_values: Any) -> Buyer:
        """Update an existing buyer profile, enforcing every document business rule."""
        buyer = await self.get_by_id_or_raise(buyer_id)

        category_ids = field_values.pop("category_ids", None)
        sub_category_ids = field_values.pop("sub_category_ids", None)
        emails = field_values.pop("emails", None)

        if field_values.get("country_id"):
            await self._validate_country(field_values["country_id"])
        if category_ids is not None:
            await self._validate_categories(category_ids)
        if sub_category_ids is not None:
            await self._validate_sub_categories(sub_category_ids)

        new_company_name = field_values.get("company_name") or buyer.company_name
        new_calling = field_values.get("contact_calling_number", buyer.contact_calling_number)
        new_whatsapp = field_values.get("contact_whatsapp_number", buyer.contact_whatsapp_number)
        if any(k in field_values for k in ("company_name", "contact_calling_number", "contact_whatsapp_number")):
            duplicate = await self.repository.find_duplicate(
                company_name=new_company_name,
                calling_number=new_calling,
                whatsapp_number=new_whatsapp,
                exclude_id=buyer_id,
            )
            if duplicate is not None:
                raise ConflictException(
                    f"A buyer named {new_company_name!r} already exists with a matching calling or WhatsApp "
                    "number (duplicate check: Company Name + Calling Number + WhatsApp Number)."
                )

        potential = field_values.get("potential", buyer.potential)
        potential_reason = field_values.get("potential_reason", buyer.potential_reason)
        self._validate_potential_reason(potential, potential_reason)

        if "current_status" in field_values:
            self._validate_status_transition(buyer.current_status, field_values["current_status"])

        # Note: `changes` includes `version` (as a plain key, alongside
        # any other field) whenever the client sends it, since it's a
        # normal non-None value at this point -- there is no special
        # extraction here. BaseRepository.update() is what recognizes a
        # `version` kwarg and treats it as `expected_version` for the
        # OCC check (see its docstring), the exact same mechanism
        # app.users.service.UserService.update_user already relies on.
        # A version-only payload (no other field actually changed) still
        # correctly reaches repository.update() and is still checked,
        # since `version` alone makes `changes` non-empty.
        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(buyer, **changes)

        if category_ids is not None:
            await self.repository.replace_category_links(buyer_id, category_ids)
        if sub_category_ids is not None:
            await self.repository.replace_sub_category_links(buyer_id, sub_category_ids)
        if emails is not None:
            await self.repository.replace_emails(buyer_id, emails)

        # Keep the mirrored primary contact in sync if main-form contact
        # fields were edited.
        primary_contact_fields = {
            "contact_salutation",
            "contact_full_name",
            "contact_designation",
            "contact_calling_number",
            "contact_whatsapp_number",
        }
        if primary_contact_fields.intersection(field_values.keys()):
            primary = await self.contact_repository.get_primary_contact(buyer_id)
            if primary is not None:
                await self.contact_repository.update(
                    primary,
                    salutation=field_values.get("contact_salutation", primary.salutation),
                    person_name=field_values.get("contact_full_name", primary.person_name) or primary.person_name,
                    designation=field_values.get("contact_designation", primary.designation),
                    calling_number=field_values.get("contact_calling_number", primary.calling_number),
                    whatsapp_number=field_values.get("contact_whatsapp_number", primary.whatsapp_number),
                )
            elif field_values.get("contact_full_name"):
                await self.contact_repository.create(
                    buyer_id=buyer_id,
                    salutation=field_values.get("contact_salutation"),
                    person_name=field_values["contact_full_name"],
                    designation=field_values.get("contact_designation"),
                    country_id=field_values.get("country_id", buyer.country_id),
                    calling_number=field_values.get("contact_calling_number"),
                    whatsapp_number=field_values.get("contact_whatsapp_number"),
                    email=None,
                    is_primary=True,
                )

        await self._invalidate_cache()
        return await self.get_by_id_or_raise(buyer_id)

    async def update_grade(self, buyer_id: uuid.UUID, buyer_grade: Any) -> Buyer:
        """List-view inline "editable dropdown" for Client Grade."""
        buyer = await self.get_by_id_or_raise(buyer_id)
        await self.repository.update(buyer, buyer_grade=buyer_grade)
        await self._invalidate_cache()
        return buyer

    async def update_potential(self, buyer_id: uuid.UUID, potential: Any) -> Buyer:
        """List-view inline "editable dropdown" for Potential."""
        buyer = await self.get_by_id_or_raise(buyer_id)
        self._validate_potential_reason(potential, buyer.potential_reason)
        await self.repository.update(buyer, potential=potential)
        await self._invalidate_cache()
        return buyer

    async def deactivate(self, buyer_id: uuid.UUID) -> Buyer:
        """Set a buyer's is_active flag to False (always permitted, per the document's Notes)."""
        buyer = await self.get_by_id_or_raise(buyer_id)
        await self.repository.update(buyer, is_active=False)
        await self._invalidate_cache()
        return buyer

    async def activate(self, buyer_id: uuid.UUID) -> Buyer:
        """Set a buyer's is_active flag back to True."""
        buyer = await self.get_by_id_or_raise(buyer_id)
        await self.repository.update(buyer, is_active=True)
        await self._invalidate_cache()
        return buyer

    async def delete(self, buyer_id: uuid.UUID) -> None:
        """
        Soft-delete a buyer, enforcing the document's delete-eligibility rule.

        Only permitted when Current Status is New/unset AND Potential is
        No/unset. Otherwise raises; the caller should deactivate instead.
        """
        buyer = await self.get_by_id_or_raise(buyer_id)
        if not self._can_delete(buyer):
            raise ConflictException(
                "This buyer cannot be deleted because its Current Status is 'Existing' or "
                "Potential is 'Yes'. Set it to Inactive instead."
            )
        await self.repository.delete(buyer)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Contacts
    # ------------------------------------------------------------------

    async def add_contact(self, buyer_id: uuid.UUID, **field_values: Any) -> BuyerContact:
        """Add a contact person to a buyer (document: "Add Contacts of Buyer (Client)")."""
        await self.get_by_id_or_raise(buyer_id)
        if field_values.get("country_id"):
            await self._validate_country(field_values["country_id"])
        return await self.contact_repository.create(buyer_id=buyer_id, is_primary=False, **field_values)

    async def get_contact_or_raise(self, buyer_id: uuid.UUID, contact_id: uuid.UUID) -> BuyerContact:
        contact = await self.contact_repository.get_by_id(contact_id)
        if contact is None or contact.buyer_id != buyer_id:
            raise NotFoundException("Buyer contact not found.")
        return contact

    async def update_contact(self, buyer_id: uuid.UUID, contact_id: uuid.UUID, **field_values: Any) -> BuyerContact:
        contact = await self.get_contact_or_raise(buyer_id, contact_id)
        if field_values.get("country_id"):
            await self._validate_country(field_values["country_id"])
        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.contact_repository.update(contact, **changes)
        return contact

    async def delete_contact(self, buyer_id: uuid.UUID, contact_id: uuid.UUID) -> None:
        """Remove a contact person from a buyer. Refuses to delete the auto-mirrored primary contact."""
        contact = await self.get_contact_or_raise(buyer_id, contact_id)
        if contact.is_primary:
            raise BadRequestException(
                "This is the buyer's primary contact (mirrored from the main form) and cannot be deleted "
                "directly -- edit it via the buyer's own contact fields instead."
            )
        await self.contact_repository.delete(contact)