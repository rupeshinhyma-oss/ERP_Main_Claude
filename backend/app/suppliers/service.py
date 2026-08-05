"""
Supplier Service.

Business logic for supplier CRUD, encoding every rule from the "Supplier
Profile" specification document's Notes section:

- Duplicate detection: Company Name + City match is rejected as a duplicate.
- Current Status may only move NEW -> EXISTING, never back.
- Delete is only permitted when Current Status is New/unset AND Potential
  is No/unset; otherwise the record can only be deactivated (is_active=False).
- The First Data Form's contact fields are mirrored into a primary
  SupplierContact row automatically, so "First Form contact details should
  appear in the Contact list also."
- Visit Remarks only makes sense when Visited Factory/Office is True.
"""

from __future__ import annotations

import uuid
from typing import Any

from app.cache.manager import CacheManager
from app.common.list_query import ListQueryParams
from app.core.exceptions import BadRequestException, ConflictException, NotFoundException
from app.masters.cities.repository import CityRepository
from app.masters.countries.repository import CountryRepository
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository
from app.masters.products.repository import ProductRepository
from app.masters.states.repository import StateRepository
from app.suppliers.constants import EXPORT_HEADERS
from app.suppliers.models import Supplier, SupplierContact, SupplierCurrentStatus
from app.suppliers.repository import SupplierContactRepository, SupplierRepository
from app.suppliers.validators import validate_supplier_row
from app.masters.import_export import (
    ImportSummary,
    build_csv_export,
    build_excel_export,
    model_to_dict,
    parse_rows_from_file,
    run_import,
)

DROPDOWN_CACHE_NAME = "suppliers"


class SupplierService:
    """Orchestrates supplier profile management on top of :class:`SupplierRepository`."""

    not_found_message = "Supplier not found."

    def __init__(
        self,
        repository: SupplierRepository,
        contact_repository: SupplierContactRepository,
        country_repository: CountryRepository,
        state_repository: StateRepository,
        city_repository: CityRepository,
        category_repository: ProductCategoryRepository,
        sub_category_repository: ProductSubCategoryRepository,
        cache_manager: CacheManager,
        product_repository: ProductRepository | None = None,
    ) -> None:
        """Bind this service to its repository, every referenced master's repository, and the cache manager."""
        self.repository = repository
        self.contact_repository = contact_repository
        self.country_repository = country_repository
        self.state_repository = state_repository
        self.city_repository = city_repository
        self.category_repository = category_repository
        self.sub_category_repository = sub_category_repository
        self.cache_manager = cache_manager
        self.product_repository = product_repository

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    async def get_by_id_or_raise(self, supplier_id: uuid.UUID) -> Supplier:
        """Fetch a supplier by ID or raise :class:`NotFoundException`."""
        supplier = await self.repository.get_with_relations(supplier_id)
        if supplier is None:
            raise NotFoundException(self.not_found_message)
        return supplier

    async def list_paginated(
        self,
        query: ListQueryParams,
        *,
        category_id: uuid.UUID | None = None,
        sub_category_id: uuid.UUID | None = None,
        product_id: uuid.UUID | None = None,
    ) -> tuple[list[Supplier], int]:
        """
        Return a page of suppliers matching search/sort/filter, plus the
        document's Top Filter Fields for Product Category and Key Strength
        Product Sub Category, plus a Product filter ("which suppliers
        supply this exact SKU") -- all three are many-to-many, so handled
        outside the generic single-value filter framework.
        """
        if category_id is None and sub_category_id is None and product_id is None:
            return await self.repository.paginated_list(query)

        # Category/sub-category/product filters require a custom
        # EXISTS-based WHERE clause the generic BaseRepository.paginated_list
        # doesn't support, so we replicate its search/sort/paginate steps
        # here with the additional predicate(s) applied.
        base_stmt = self.repository._base_select()
        base_stmt = self.repository._apply_search(base_stmt, query.search.normalized)
        base_stmt = self.repository._apply_dynamic_filters(base_stmt, query.filters)
        if category_id is not None:
            base_stmt = self.repository.apply_category_filter(base_stmt, category_id)
        if sub_category_id is not None:
            base_stmt = self.repository.apply_sub_category_filter(base_stmt, sub_category_id)
        if product_id is not None:
            base_stmt = self.repository.apply_product_filter(base_stmt, product_id)

        from sqlalchemy import func, select

        count_stmt = select(func.count()).select_from(base_stmt.subquery())
        total = int((await self.repository.session.execute(count_stmt)).scalar_one())

        list_stmt = self.repository._apply_sort(base_stmt, query.sort)
        list_stmt = list_stmt.offset(query.page.offset).limit(query.page.limit)
        result = await self.repository.session.execute(list_stmt)
        items = list(result.scalars().unique().all())
        return items, total

    async def get_category_ids(self, supplier_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every product-category ID linked to a supplier."""
        return await self.repository.list_all_category_ids(supplier_id)

    async def get_sub_category_ids(self, supplier_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every product-sub-category ID linked to a supplier."""
        return await self.repository.list_all_sub_category_ids(supplier_id)

    async def get_product_ids(self, supplier_id: uuid.UUID) -> list[uuid.UUID]:
        """Return every Product ID linked to a supplier (the specific SKUs this supplier supplies)."""
        return await self.repository.list_all_product_ids(supplier_id)

    async def list_contacts(self, supplier_id: uuid.UUID) -> list[SupplierContact]:
        """Return every contact person for a supplier."""
        return await self.contact_repository.list_for_supplier(supplier_id)

    # ------------------------------------------------------------------
    # Validation helpers
    # ------------------------------------------------------------------

    async def _validate_geography(self, country_id: uuid.UUID, state_id: uuid.UUID, city_id: uuid.UUID) -> None:
        """Ensure country/state/city exist and are mutually consistent."""
        if await self.country_repository.get_by_id(country_id) is None:
            raise BadRequestException("The specified country does not exist.")
        state = await self.state_repository.get_by_id(state_id)
        if state is None:
            raise BadRequestException("The specified state/province does not exist.")
        if state.country_id != country_id:
            raise BadRequestException("The specified state does not belong to the specified country.")
        city = await self.city_repository.get_by_id(city_id)
        if city is None:
            raise BadRequestException("The specified city does not exist.")
        if city.state_id != state_id:
            raise BadRequestException("The specified city does not belong to the specified state.")

    async def _validate_categories(self, category_ids: list[uuid.UUID]) -> None:
        """Ensure every given product category exists."""
        for category_id in category_ids:
            if await self.category_repository.get_by_id(category_id) is None:
                raise BadRequestException(f"Product category {category_id} does not exist.")

    async def _validate_sub_categories(self, sub_category_ids: list[uuid.UUID]) -> None:
        """Ensure every given product sub-category exists."""
        for sub_category_id in sub_category_ids:
            if await self.sub_category_repository.get_by_id(sub_category_id) is None:
                raise BadRequestException(f"Product sub-category {sub_category_id} does not exist.")

    async def _validate_products(self, product_ids: list[uuid.UUID]) -> None:
        """Ensure every given product exists (Products is the central item master; see its module docstring)."""
        if not product_ids:
            return
        if self.product_repository is None:
            raise BadRequestException("Product linking is not available in this context.")
        for product_id in product_ids:
            if await self.product_repository.get_by_id(product_id) is None:
                raise BadRequestException(f"Product {product_id} does not exist.")

    def _validate_visit_remarks(self, visited: bool, visit_remarks: str | None) -> None:
        """
        Document: "Visit Remarks (if in above yes, then only this field opens)".

        Interpreted as: remarks are only meaningful/storable when
        visited_factory_office is True. Rather than silently dropping
        data the user may have typed before toggling the switch back to
        No, we reject the combination explicitly so the user corrects it.
        """
        if visit_remarks and not visited:
            raise BadRequestException(
                "Visit Remarks can only be set when 'Visited Factory/Office' is Yes."
            )

    def _validate_status_transition(self, existing_status: SupplierCurrentStatus | None, new_status: Any) -> None:
        """
        Document Notes: "once changed from 'New' to 'Existing', then cannot
        edit back to 'New' (only 1 way can change -- new to existing)".
        """
        if new_status is None:
            return
        if existing_status == SupplierCurrentStatus.EXISTING and new_status == SupplierCurrentStatus.NEW:
            raise ConflictException(
                "Current Status cannot be changed from 'Existing' back to 'New'."
            )

    def _can_delete(self, supplier: Supplier) -> bool:
        """
        Document Notes: "If Current Status is 'New or Select' and Potential
        is 'No or Select', then only to allow Delete. If Current Status is
        'Existing' or Potential is 'Yes' (any one), cannot DELETE that data.
        However, can make it 'Inactive'".
        """
        status_blocks_delete = supplier.current_status == SupplierCurrentStatus.EXISTING
        potential_blocks_delete = supplier.potential is not None and supplier.potential.value == "yes"
        return not (status_blocks_delete or potential_blocks_delete)

    async def _invalidate_cache(self) -> None:
        """Invalidate the suppliers dropdown cache after any mutation."""
        await self.cache_manager.invalidate_dropdown(DROPDOWN_CACHE_NAME)

    # ------------------------------------------------------------------
    # Create / Update
    # ------------------------------------------------------------------

    async def create(self, **field_values: Any) -> Supplier:
        """
        Create a new supplier profile.

        Validates geography consistency, category/sub-category existence,
        the Company-Name+City duplicate rule, and the visit-remarks rule;
        mirrors the First-Data-Form contact into a primary SupplierContact
        row; and persists emails/category/sub-category links.
        """
        company_name = field_values["company_name"]
        country_id = field_values["country_id"]
        state_id = field_values["state_id"]
        city_id = field_values["city_id"]
        category_ids = field_values.pop("category_ids", []) or []
        sub_category_ids = field_values.pop("sub_category_ids", []) or []
        product_ids = field_values.pop("product_ids", []) or []
        emails = field_values.pop("emails", []) or []

        await self._validate_geography(country_id, state_id, city_id)
        await self._validate_categories(category_ids)
        await self._validate_sub_categories(sub_category_ids)
        await self._validate_products(product_ids)
        self._validate_visit_remarks(
            field_values.get("visited_factory_office", False), field_values.get("visit_remarks")
        )

        if await self.repository.name_city_exists(company_name, city_id):
            existing = await self.repository.get_by_name_city(company_name, city_id)
            raise ConflictException(
                f"A supplier named {company_name!r} already exists in this city (duplicate check: "
                "Company Name + City).",
                details={"existing": model_to_dict(existing) if existing else None},
            )

        supplier = await self.repository.create(**field_values)

        await self.repository.replace_category_links(supplier.id, category_ids)
        await self.repository.replace_sub_category_links(supplier.id, sub_category_ids)
        await self.repository.replace_product_links(supplier.id, product_ids)
        await self.repository.replace_emails(supplier.id, emails)

        # Mirror the First Data Form's contact into the contacts list, per
        # the document's Note. Only created if a contact name was actually
        # provided on the first form.
        if field_values.get("contact_full_name"):
            await self.contact_repository.create(
                supplier_id=supplier.id,
                salutation=field_values.get("contact_salutation"),
                person_name=field_values["contact_full_name"],
                designation=field_values.get("contact_designation"),
                handling_territory=None,
                country_id=country_id,
                calling_number=field_values.get("contact_calling_number"),
                whatsapp_number=field_values.get("contact_whatsapp_number"),
                wechat_number=field_values.get("contact_wechat_number"),
                email=emails[0] if emails else None,
                is_primary=True,
            )

        await self._invalidate_cache()
        return await self.get_by_id_or_raise(supplier.id)

    async def update(self, supplier_id: uuid.UUID, **field_values: Any) -> Supplier:
        """Update an existing supplier profile, enforcing every document business rule."""
        supplier = await self.get_by_id_or_raise(supplier_id)

        category_ids = field_values.pop("category_ids", None)
        sub_category_ids = field_values.pop("sub_category_ids", None)
        product_ids = field_values.pop("product_ids", None)
        emails = field_values.pop("emails", None)

        country_id = field_values.get("country_id") or supplier.country_id
        state_id = field_values.get("state_id") or supplier.state_id
        city_id = field_values.get("city_id") or supplier.city_id
        if any(k in field_values for k in ("country_id", "state_id", "city_id")):
            await self._validate_geography(country_id, state_id, city_id)

        if category_ids is not None:
            await self._validate_categories(category_ids)
        if sub_category_ids is not None:
            await self._validate_sub_categories(sub_category_ids)
        if product_ids is not None:
            await self._validate_products(product_ids)

        new_company_name = field_values.get("company_name") or supplier.company_name
        new_city_id = field_values.get("city_id") or supplier.city_id
        if field_values.get("company_name") is not None or field_values.get("city_id") is not None:
            if await self.repository.name_city_exists(new_company_name, new_city_id, exclude_id=supplier_id):
                existing = await self.repository.get_by_name_city(
                    new_company_name, new_city_id, exclude_id=supplier_id
                )
                raise ConflictException(
                    f"A supplier named {new_company_name!r} already exists in this city "
                    "(duplicate check: Company Name + City).",
                    details={"existing": model_to_dict(existing) if existing else None},
                )

        visited = field_values.get("visited_factory_office")
        visited = supplier.visited_factory_office if visited is None else visited
        visit_remarks = field_values.get("visit_remarks")
        visit_remarks = supplier.visit_remarks if visit_remarks is None else visit_remarks
        self._validate_visit_remarks(visited, visit_remarks)

        if "current_status" in field_values:
            self._validate_status_transition(supplier.current_status, field_values["current_status"])

        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.repository.update(supplier, **changes)

        if category_ids is not None:
            await self.repository.replace_category_links(supplier_id, category_ids)
        if sub_category_ids is not None:
            await self.repository.replace_sub_category_links(supplier_id, sub_category_ids)
        if product_ids is not None:
            await self.repository.replace_product_links(supplier_id, product_ids)
        if emails is not None:
            await self.repository.replace_emails(supplier_id, emails)

        # Keep the mirrored primary contact in sync if First-Data-Form
        # contact fields were edited.
        primary_contact_fields = {
            "contact_salutation",
            "contact_full_name",
            "contact_designation",
            "contact_calling_number",
            "contact_whatsapp_number",
            "contact_wechat_number",
        }
        if primary_contact_fields.intersection(field_values.keys()):
            primary = await self.contact_repository.get_primary_contact(supplier_id)
            if primary is not None:
                await self.contact_repository.update(
                    primary,
                    salutation=field_values.get("contact_salutation", primary.salutation),
                    person_name=field_values.get("contact_full_name", primary.person_name) or primary.person_name,
                    designation=field_values.get("contact_designation", primary.designation),
                    calling_number=field_values.get("contact_calling_number", primary.calling_number),
                    whatsapp_number=field_values.get("contact_whatsapp_number", primary.whatsapp_number),
                    wechat_number=field_values.get("contact_wechat_number", primary.wechat_number),
                )
            elif field_values.get("contact_full_name"):
                await self.contact_repository.create(
                    supplier_id=supplier_id,
                    salutation=field_values.get("contact_salutation"),
                    person_name=field_values["contact_full_name"],
                    designation=field_values.get("contact_designation"),
                    handling_territory=None,
                    country_id=country_id,
                    calling_number=field_values.get("contact_calling_number"),
                    whatsapp_number=field_values.get("contact_whatsapp_number"),
                    wechat_number=field_values.get("contact_wechat_number"),
                    email=None,
                    is_primary=True,
                )

        await self._invalidate_cache()
        return await self.get_by_id_or_raise(supplier_id)

    async def update_grade(self, supplier_id: uuid.UUID, supplier_grade: Any) -> Supplier:
        """List-view inline "editable dropdown" for Supplier's Grade."""
        supplier = await self.get_by_id_or_raise(supplier_id)
        await self.repository.update(supplier, supplier_grade=supplier_grade)
        await self._invalidate_cache()
        return supplier

    async def update_potential(self, supplier_id: uuid.UUID, potential: Any) -> Supplier:
        """List-view inline "editable dropdown" for Potential."""
        supplier = await self.get_by_id_or_raise(supplier_id)
        await self.repository.update(supplier, potential=potential)
        await self._invalidate_cache()
        return supplier

    async def deactivate(self, supplier_id: uuid.UUID) -> Supplier:
        """Set a supplier's is_active flag to False (always permitted, per the document's Notes)."""
        supplier = await self.get_by_id_or_raise(supplier_id)
        await self.repository.update(supplier, is_active=False)
        await self._invalidate_cache()
        return supplier

    async def activate(self, supplier_id: uuid.UUID) -> Supplier:
        """Set a supplier's is_active flag back to True."""
        supplier = await self.get_by_id_or_raise(supplier_id)
        await self.repository.update(supplier, is_active=True)
        await self._invalidate_cache()
        return supplier

    async def delete(self, supplier_id: uuid.UUID) -> None:
        """
        Soft-delete a supplier, enforcing the document's delete-eligibility rule.

        Only permitted when Current Status is New/unset AND Potential is
        No/unset. Otherwise raises; the caller should deactivate instead.
        """
        supplier = await self.get_by_id_or_raise(supplier_id)
        if not self._can_delete(supplier):
            raise ConflictException(
                "This supplier cannot be deleted because its Current Status is 'Existing' or "
                "Potential is 'Yes'. Set it to Inactive instead."
            )
        await self.repository.delete(supplier)
        await self._invalidate_cache()

    # ------------------------------------------------------------------
    # Contacts
    # ------------------------------------------------------------------

    async def add_contact(self, supplier_id: uuid.UUID, **field_values: Any) -> SupplierContact:
        """Add a contact person to a supplier (document: "Add Contacts Form")."""
        await self.get_by_id_or_raise(supplier_id)
        if field_values.get("country_id"):
            if await self.country_repository.get_by_id(field_values["country_id"]) is None:
                raise BadRequestException("The specified country does not exist.")
        contact = await self.contact_repository.create(supplier_id=supplier_id, is_primary=False, **field_values)
        return contact

    async def get_contact_or_raise(self, supplier_id: uuid.UUID, contact_id: uuid.UUID) -> SupplierContact:
        """Fetch a single contact by ID, scoped to its supplier, or raise :class:`NotFoundException`."""
        contact = await self.contact_repository.get_by_id(contact_id)
        if contact is None or contact.supplier_id != supplier_id:
            raise NotFoundException("Supplier contact not found.")
        return contact

    async def update_contact(self, supplier_id: uuid.UUID, contact_id: uuid.UUID, **field_values: Any) -> SupplierContact:
        """Update an existing contact person."""
        contact = await self.get_contact_or_raise(supplier_id, contact_id)
        if field_values.get("country_id"):
            if await self.country_repository.get_by_id(field_values["country_id"]) is None:
                raise BadRequestException("The specified country does not exist.")
        changes = {k: v for k, v in field_values.items() if v is not None}
        if changes:
            await self.contact_repository.update(contact, **changes)
        return contact

    async def delete_contact(self, supplier_id: uuid.UUID, contact_id: uuid.UUID) -> None:
        """
        Remove a contact person from a supplier.

        Refuses to delete the auto-mirrored primary contact directly --
        that one is edited through the supplier's own First-Data-Form
        contact fields (via ``update()``), not deleted independently,
        since deleting it would desynchronize the supplier record itself.
        """
        contact = await self.get_contact_or_raise(supplier_id, contact_id)
        if contact.is_primary:
            raise ConflictException(
                "The primary contact (mirrored from the supplier's main profile) cannot be "
                "deleted directly. Edit the supplier's contact fields instead."
            )
        await self.contact_repository.delete(contact)

    # ------------------------------------------------------------------
    # Import / Export
    # ------------------------------------------------------------------

    async def import_file(self, filename: str, raw_bytes: bytes) -> ImportSummary:
        """
        Validate and import suppliers from an uploaded CSV/XLSX file.

        Applies the document's duplicate rule per row (Company Name + City).
        """
        rows = parse_rows_from_file(filename, raw_bytes)

        async def _create(field_values: dict[str, Any]) -> Supplier:
            country_code = field_values.pop("country_code", "")
            state_name = field_values.pop("state_name", "")
            city_name = field_values.pop("city_name", "")
            email = field_values.pop("email", None)

            all_countries = await self.country_repository.list_all()
            all_states = await self.state_repository.list_all()
            all_cities = await self.city_repository.list_all()

            country = next((c for c in all_countries if c.code.lower() == country_code.lower() or c.name.lower() == country_code.lower()), None)
            if country is None:
                raise ValueError(f"Country '{country_code}' does not exist.")

            state = None
            if state_name:
                state = next((s for s in all_states if s.country_id == country.id and (s.name.lower() == state_name.lower() or (s.code and s.code.lower() == state_name.lower()))), None)
            if state is None and all_states:
                state = next((s for s in all_states if s.country_id == country.id), None)
            if state is None:
                state = all_states[0] if all_states else None

            city = None
            if city_name:
                city = next((c for c in all_cities if c.name.lower() == city_name.lower()), None)
            if city is None and all_cities:
                city = next((c for c in all_cities if c.country_id == country.id), None)
            if city is None:
                city = all_cities[0] if all_cities else None

            field_values["country_id"] = country.id
            field_values["state_id"] = state.id if state else None
            field_values["city_id"] = city.id if city else None

            company_name = field_values["company_name"]
            existing = await self.repository.get_by_name_city(company_name, city.id)
            if existing is not None:
                raise ConflictException(
                    f"Supplier {company_name!r} already exists in {city_name!r} (duplicate: Company Name + City).",
                    details={"existing": model_to_dict(existing)},
                )

            self._validate_visit_remarks(
                field_values.get("visited_factory_office", False), field_values.get("visit_remarks")
            )

            supplier = await self.repository.create(**field_values)
            if email:
                await self.repository.replace_emails(supplier.id, [email])
            if field_values.get("contact_full_name"):
                await self.contact_repository.create(
                    supplier_id=supplier.id,
                    salutation=field_values.get("contact_salutation"),
                    person_name=field_values["contact_full_name"],
                    designation=field_values.get("contact_designation"),
                    handling_territory=None,
                    country_id=country.id,
                    calling_number=field_values.get("contact_calling_number"),
                    whatsapp_number=field_values.get("contact_whatsapp_number"),
                    wechat_number=field_values.get("contact_wechat_number"),
                    email=email,
                    is_primary=True,
                )
            return supplier

        summary = await run_import(rows, row_validator=validate_supplier_row, row_creator=_create)
        await self._invalidate_cache()
        return summary

    async def export_file(self, file_format: str) -> bytes:
        """Export every supplier to CSV or XLSX bytes."""
        suppliers = await self.repository.list_all()
        rows = []
        for s in suppliers:
            emails = [e.email for e in s.emails]
            rows.append(
                {
                    "id": str(s.id),
                    "company_name": s.company_name,
                    "supplier_type": s.supplier_type.value if s.supplier_type else None,
                    "brand_description": s.brand_description,
                    "country_id": str(s.country_id),
                    "state_id": str(s.state_id),
                    "city_id": str(s.city_id),
                    "contact_full_name": s.contact_full_name,
                    "contact_designation": s.contact_designation,
                    "contact_calling_number": s.contact_calling_number,
                    "contact_whatsapp_number": s.contact_whatsapp_number,
                    "contact_wechat_number": s.contact_wechat_number,
                    "emails": ",".join(emails) if emails else None,
                    "tax_id_number": s.tax_id_number,
                    "address": s.address,
                    "town": s.town,
                    "primary_website": s.primary_website,
                    "secondary_website": s.secondary_website,
                    "supplier_grade": s.supplier_grade.value if s.supplier_grade else None,
                    "current_status": s.current_status.value if s.current_status else None,
                    "potential": s.potential.value if s.potential else None,
                    "potential_reason": s.potential_reason,
                    "secondary_products_description": s.secondary_products_description,
                    "visited_factory_office": s.visited_factory_office,
                    "visit_remarks": s.visit_remarks,
                    "overall_remarks": s.overall_remarks,
                    "is_active": s.is_active,
                    "created_at": s.created_at.isoformat(),
                    "updated_at": s.updated_at.isoformat(),
                }
            )
        if file_format == "csv":
            return build_csv_export(EXPORT_HEADERS, rows)
        return build_excel_export(EXPORT_HEADERS, rows, sheet_title="Suppliers")
