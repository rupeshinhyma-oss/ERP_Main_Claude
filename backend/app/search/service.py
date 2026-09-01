"""
Universal Search Service.

Executes asynchronous database searches across all major ERP tables and entity models.

RESTORED (2026-08-14): this whole module (routes.py, service.py, schemas.py,
__init__.py) was accidentally deleted in the "Migration to React Vite
TypeScript frontend architecture" commit -- the frontend's
UniversalSearch.tsx component survived that rewrite and still calls
`GET /search?q=`, but with the backend route gone, every search just 404'd,
which the frontend showed generically as "Error executing search."

Restored from git history (the commit immediately before deletion) with
three real fixes applied while restoring, not just a verbatim copy:

1. Soft-delete filtering was previously applied to ``Supplier`` only. Since
   then, EVERY model this module searches (Product, Brand, Category,
   SubCategory, Country, State, City, Currency, UnitOfMeasurement, HsnCode)
   has gained ``SoftDeleteMixin`` (see app.database.base.SoftDeleteMixin
   and the company-wide soft-delete policy). Without excluding
   ``deleted_at IS NOT NULL`` rows everywhere, universal search would
   surface records sitting in Trash as if they were still live -- clicking
   one would land on a 404/not-found page. Every query below now excludes
   soft-deleted rows via ``_not_deleted()``.

2. Field names that no longer match the current models:
   - ``Product.name`` / ``Product.code`` -> ``Product.product_name`` /
     ``Product.product_code`` (the model was renamed at some point; the
     legacy field names never existed on the current schema).
   - ``Country.iso3`` -- this column was dropped in migration
     ``z0a1b2c3d4e5_drop_iso2_iso3_from_countries.py``; referencing it here
     would raise ``AttributeError`` and take down the whole Countries
     search block (each block is independently try/excepted, so this
     wouldn't crash the whole endpoint, but would silently omit Countries
     results and log a warning every single search).

3. The Tasks section (#4 in the original) is removed entirely: the
   ``app.tasks`` module itself was removed from the codebase (see
   migration ``u5v6w7x8y9z0_remove_tasks_module.py``), so importing
   ``app.tasks.models.Task`` here would fail at import time and take down
   search completely, not just one category.

4. (2026-08-17) The Departments & Designations section is also removed
   entirely: both modules (``app.departments``, ``app.designations``) were
   subsequently removed from the app -- along with their
   ``department_permissions``/``designation_permissions`` tables and the
   ``users.department_id``/``designation_id`` columns (see migration
   ``e7b8c9d0e1f2_remove_teams_departments_designations.py``). The app now
   only supports Role -> Permission plus an individual per-user permission
   override (``UserPermission``); there is no department/designation-level
   permission concept to search for anymore. Importing
   ``app.departments.models``/``app.designations.models`` here would fail
   at import time (the modules no longer exist) and take down search
   completely, the same failure mode as the Tasks import in #3.
"""

from __future__ import annotations

import logging
from typing import List, Type

from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.base import SoftDeleteMixin
from app.masters.brands.models import Brand
from app.masters.cities.models import City
from app.masters.countries.models import Country
from app.masters.currencies.models import Currency
from app.masters.hsn.models import HsnCode
from app.masters.product_categories.models import ProductCategory
from app.masters.product_sub_categories.models import ProductSubCategory
from app.masters.products.models import Product
from app.masters.states.models import State
from app.masters.uom.models import UnitOfMeasurement
from app.organizations.models import Organization
from app.inquiries.models import ConsignmentCode, Inquiry, InquiryItem
from app.search.schemas import SearchResultItem, UniversalSearchResponse
from app.buyers.models import Buyer
from app.suppliers.models import Supplier
from app.trash.service import MODEL_MAP
from app.users.models import User

logger = logging.getLogger(__name__)

LIMIT_PER_ENTITY = 5


def _not_deleted(model: Type) -> ColumnElement[bool] | bool:
    """
    Return the ``deleted_at IS NULL`` filter for a soft-deletable model, or
    ``True`` (a harmless always-true SQL condition) for a model that has no
    soft-delete support at all (e.g. ``User``, ``Organization``).

    Centralized here so every search block below is automatically correct
    if a model gains or loses ``SoftDeleteMixin`` in the future -- callers
    never need to remember which models currently support it.
    """
    if issubclass(model, SoftDeleteMixin):
        return model.deleted_at.is_(None)
    return True


async def search_universal(db: AsyncSession, query_str: str) -> UniversalSearchResponse:
    """
    Search across all database entities for matching keywords.

    Returns a unified response accessible by default to all logged-in users.
    """
    clean_q = query_str.strip()
    if not clean_q:
        return UniversalSearchResponse(query="", total_hits=0, results=[])

    pattern = f"%{clean_q}%"
    results: List[SearchResultItem] = []

    # 1. Organization / Company Profile
    try:
        stmt = select(Organization).where(
            or_(
                Organization.company_name.ilike(pattern),
                Organization.legal_name.ilike(pattern),
                Organization.email.ilike(pattern),
                Organization.phone.ilike(pattern),
                Organization.gst_number.ilike(pattern),
            )
        ).limit(LIMIT_PER_ENTITY)
        orgs = (await db.execute(stmt)).scalars().all()
        for org in orgs:
            results.append(
                SearchResultItem(
                    category="Organization",
                    id=str(org.id),
                    title=org.company_name,
                    subtitle=org.legal_name or org.email or org.phone or "Company Profile",
                    target_url="./organization.html",
                    icon="building",
                )
            )
    except Exception as e:
        logger.warning("Error searching Organization: %s", e)

    # 2. Users / Members
    try:
        stmt = select(User).where(
            _not_deleted(User),
            or_(
                User.username.ilike(pattern),
                User.email.ilike(pattern),
                User.first_name.ilike(pattern),
                User.last_name.ilike(pattern),
                User.display_name.ilike(pattern),
                User.employee_code.ilike(pattern),
                User.phone.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        users = (await db.execute(stmt)).scalars().all()
        for u in users:
            name = u.display_name or f"{u.first_name or ''} {u.last_name or ''}".strip() or u.username
            details = f"Code: {u.employee_code} | Email: {u.email}" if u.employee_code else u.email
            results.append(
                SearchResultItem(
                    category="Users & Members",
                    id=str(u.id),
                    title=name,
                    subtitle=details,
                    target_url="./users.html",
                    icon="users",
                )
            )
    except Exception as e:
        logger.warning("Error searching Users: %s", e)

    # 3. Suppliers
    try:
        stmt = select(Supplier).where(
            _not_deleted(Supplier),
            or_(
                Supplier.company_name.ilike(pattern),
                Supplier.brand_description.ilike(pattern),
                Supplier.contact_full_name.ilike(pattern),
                Supplier.town.ilike(pattern),
                Supplier.address.ilike(pattern),
                Supplier.tax_id_number.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        suppliers = (await db.execute(stmt)).scalars().all()
        for s in suppliers:
            results.append(
                SearchResultItem(
                    category="Suppliers",
                    id=str(s.id),
                    title=s.company_name,
                    subtitle=s.brand_description or f"Supplier Grade: {s.supplier_grade or 'N/A'}",
                    target_url="./suppliers.html",
                    icon="truck",
                )
            )
    except Exception as e:
        logger.warning("Error searching Suppliers: %s", e)

    # 3b. Buyers (Clients)
    try:
        stmt = select(Buyer).where(
            _not_deleted(Buyer),
            or_(
                Buyer.company_name.ilike(pattern),
                Buyer.contact_full_name.ilike(pattern),
                Buyer.city.ilike(pattern),
                Buyer.product_range.ilike(pattern),
                Buyer.currently_buying_from.ilike(pattern),
                Buyer.overall_remarks.ilike(pattern),
                Buyer.tax_id_number.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        buyers = (await db.execute(stmt)).scalars().all()
        for b in buyers:
            grade_or_type = (
                f"Grade {b.buyer_grade.value}"
                if b.buyer_grade
                else (b.buyer_type.upper() if b.buyer_type else "Buyer Profile")
            )
            subtitle = b.product_range or (f"City: {b.city} | {grade_or_type}" if b.city else grade_or_type)
            results.append(
                SearchResultItem(
                    category="Buyers",
                    id=str(b.id),
                    title=b.company_name,
                    subtitle=subtitle,
                    target_url="./buyers.html",
                    icon="shoppingBag",
                )
            )
    except Exception as e:
        logger.warning("Error searching Buyers: %s", e)

    # 4. Products
    try:
        stmt = select(Product).where(
            _not_deleted(Product),
            or_(
                Product.product_name.ilike(pattern),
                Product.product_code.ilike(pattern),
                Product.description.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        products = (await db.execute(stmt)).scalars().all()
        for p in products:
            results.append(
                SearchResultItem(
                    category="Products",
                    id=str(p.id),
                    title=p.product_name,
                    subtitle=f"Code: {p.product_code}"
                    + (f" | {p.description[:40]}..." if p.description else ""),
                    target_url="./masters-products.html",
                    icon="box",
                )
            )
    except Exception as e:
        logger.warning("Error searching Products: %s", e)

    # 5. Categories & Sub-Categories
    try:
        stmt = select(ProductCategory).where(
            _not_deleted(ProductCategory),
            or_(
                ProductCategory.name.ilike(pattern),
                ProductCategory.code.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        categories = (await db.execute(stmt)).scalars().all()
        for c in categories:
            results.append(
                SearchResultItem(
                    category="Product Categories",
                    id=str(c.id),
                    title=c.name,
                    subtitle=f"Code: {c.code}",
                    target_url="./masters-categories.html",
                    icon="layers",
                )
            )

        stmt_sub = select(ProductSubCategory).where(
            _not_deleted(ProductSubCategory),
            or_(
                ProductSubCategory.name.ilike(pattern),
                ProductSubCategory.code.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        subcats = (await db.execute(stmt_sub)).scalars().all()
        for sc in subcats:
            results.append(
                SearchResultItem(
                    category="Product Sub-Categories",
                    id=str(sc.id),
                    title=sc.name,
                    subtitle=f"Code: {sc.code}",
                    target_url="./masters-subcategories.html",
                    icon="layersplus",
                )
            )
    except Exception as e:
        logger.warning("Error searching Categories/Subcategories: %s", e)

    # 6. Brands
    try:
        stmt = select(Brand).where(
            _not_deleted(Brand),
            or_(
                Brand.name.ilike(pattern),
                Brand.code.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        brands = (await db.execute(stmt)).scalars().all()
        for b in brands:
            results.append(
                SearchResultItem(
                    category="Brands",
                    id=str(b.id),
                    title=b.name,
                    subtitle=f"Code: {b.code}",
                    target_url="./masters-brands.html",
                    icon="award",
                )
            )
    except Exception as e:
        logger.warning("Error searching Brands: %s", e)

    # 7. HSN Codes
    try:
        stmt = select(HsnCode).where(
            _not_deleted(HsnCode),
            or_(
                HsnCode.code.ilike(pattern),
                HsnCode.description.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        hsns = (await db.execute(stmt)).scalars().all()
        for h in hsns:
            results.append(
                SearchResultItem(
                    category="HSN Codes",
                    id=str(h.id),
                    title=f"HSN: {h.code}",
                    subtitle=h.description or "Tax Code Master",
                    target_url="./masters-hsn.html",
                    icon="tag",
                )
            )
    except Exception as e:
        logger.warning("Error searching HSN Codes: %s", e)

    # 8. Countries, States, Cities
    try:
        stmt_c = select(Country).where(
            _not_deleted(Country),
            or_(
                Country.name.ilike(pattern),
                Country.code.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        countries = (await db.execute(stmt_c)).scalars().all()
        for c in countries:
            results.append(
                SearchResultItem(
                    category="Countries",
                    id=str(c.id),
                    title=c.name,
                    subtitle=f"Code: {c.code}",
                    target_url="./masters-countries.html",
                    icon="globe",
                )
            )

        stmt_s = select(State).where(
            _not_deleted(State),
            or_(
                State.name.ilike(pattern),
                State.code.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        states = (await db.execute(stmt_s)).scalars().all()
        for st in states:
            results.append(
                SearchResultItem(
                    category="States",
                    id=str(st.id),
                    title=st.name,
                    subtitle=f"Code: {st.code}",
                    target_url="./masters-states.html",
                    icon="map",
                )
            )

        stmt_ci = select(City).where(_not_deleted(City), City.name.ilike(pattern)).limit(LIMIT_PER_ENTITY)
        cities = (await db.execute(stmt_ci)).scalars().all()
        for ci in cities:
            results.append(
                SearchResultItem(
                    category="Cities",
                    id=str(ci.id),
                    title=ci.name,
                    subtitle="City Master",
                    target_url="./masters-cities.html",
                    icon="pin",
                )
            )
    except Exception as e:
        logger.warning("Error searching Geography Masters: %s", e)

    # 9. Currencies & UOM
    try:
        stmt_curr = select(Currency).where(
            _not_deleted(Currency),
            or_(
                Currency.name.ilike(pattern),
                Currency.code.ilike(pattern),
                Currency.symbol.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        currencies = (await db.execute(stmt_curr)).scalars().all()
        for curr in currencies:
            results.append(
                SearchResultItem(
                    category="Currencies",
                    id=str(curr.id),
                    title=f"{curr.name} ({curr.code})",
                    subtitle=f"Symbol: {curr.symbol or 'N/A'}",
                    target_url="./masters-currencies.html",
                    icon="coins",
                )
            )

        stmt_uom = select(UnitOfMeasurement).where(
            _not_deleted(UnitOfMeasurement),
            or_(
                UnitOfMeasurement.name.ilike(pattern),
                UnitOfMeasurement.code.ilike(pattern),
            ),
        ).limit(LIMIT_PER_ENTITY)
        uoms = (await db.execute(stmt_uom)).scalars().all()
        for u in uoms:
            results.append(
                SearchResultItem(
                    category="Units of Measurement",
                    id=str(u.id),
                    title=u.name,
                    subtitle=f"Code: {u.code}",
                    target_url="./masters-uom.html",
                    icon="ruler",
                )
            )
    except Exception as e:
        logger.warning("Error searching Currencies/UOM: %s", e)

    # 10. Inquiries & Consignments
    try:
        stmt_cc = (
            select(ConsignmentCode, Buyer)
            .join(Buyer, ConsignmentCode.buyer_id == Buyer.id)
            .where(
                _not_deleted(ConsignmentCode),
                _not_deleted(Buyer),
                or_(
                    ConsignmentCode.code.ilike(pattern),
                    ConsignmentCode.label.ilike(pattern),
                ),
            )
            .limit(LIMIT_PER_ENTITY)
        )
        cc_rows = (await db.execute(stmt_cc)).all()
        for cc, buyer in cc_rows:
            label_suffix = f" - {cc.label}" if cc.label else ""
            results.append(
                SearchResultItem(
                    category="Inquiries",
                    id=str(cc.id),
                    title=f"Consignment: {cc.code}{label_suffix}",
                    subtitle=f"Buyer: {buyer.company_name}",
                    target_url=f"./inquiries.html?buyerId={cc.buyer_id}",
                    icon="fileText",
                )
            )

        stmt_items = (
            select(InquiryItem, Inquiry, Buyer, Product)
            .join(Inquiry, InquiryItem.inquiry_id == Inquiry.id)
            .join(Buyer, Inquiry.buyer_id == Buyer.id)
            .join(Product, InquiryItem.product_id == Product.id)
            .where(
                _not_deleted(InquiryItem),
                _not_deleted(Inquiry),
                _not_deleted(Buyer),
                _not_deleted(Product),
                or_(
                    InquiryItem.brand_preference.ilike(pattern),
                    InquiryItem.product_specs_remarks.ilike(pattern),
                ),
            )
            .limit(LIMIT_PER_ENTITY)
        )
        item_rows = (await db.execute(stmt_items)).all()
        for item, inq, buyer, prod in item_rows:
            status_text = (
                item.status.value.replace("_", " ").title()
                if item.status
                else "Proposed"
            )
            results.append(
                SearchResultItem(
                    category="Inquiries",
                    id=str(item.id),
                    title=f"Inquiry: {prod.product_name}",
                    subtitle=f"Buyer: {buyer.company_name} | Qty: {item.quantity} | {status_text}",
                    target_url=f"./inquiries.html?buyerId={inq.buyer_id}&inquiryId={inq.id}",
                    icon="fileText",
                )
            )
    except Exception as e:
        logger.warning("Error searching Inquiries: %s", e)

    # 11. Trash (Soft-deleted records across all models)
    try:
        trash_limit_remaining = LIMIT_PER_ENTITY
        for entity_name, (model_cls, name_col, code_col) in MODEL_MAP.items():
            if trash_limit_remaining <= 0:
                break
            if not issubclass(model_cls, SoftDeleteMixin):
                continue
            name_attr = getattr(model_cls, name_col, None)
            if name_attr is None:
                continue
            from sqlalchemy import cast, String
            conditions = [cast(name_attr, String).ilike(pattern) if name_col == "id" else name_attr.ilike(pattern)]
            if code_col:
                code_attr = getattr(model_cls, code_col, None)
                if code_attr is not None:
                    conditions.append(cast(code_attr, String).ilike(pattern) if code_col == "id" else code_attr.ilike(pattern))

            stmt = (
                select(model_cls)
                .where(model_cls.deleted_at.is_not(None), or_(*conditions))
                .order_by(model_cls.deleted_at.desc())
                .limit(trash_limit_remaining)
            )

            deleted_rows = (await db.execute(stmt)).scalars().all()
            for row in deleted_rows:
                title = str(getattr(row, name_col, f"{entity_name} {row.id}"))
                code_val = getattr(row, code_col, None) if code_col else None
                code_suffix = f" ({code_val})" if code_val else ""
                del_time = (
                    row.deleted_at.strftime("%b %d, %Y")
                    if getattr(row, "deleted_at", None)
                    else "Deleted"
                )
                results.append(
                    SearchResultItem(
                        category="Trash",
                        id=str(row.id),
                        title=f"{title}{code_suffix} [Deleted]",
                        subtitle=f"Type: {entity_name} | Deleted on {del_time}",
                        target_url=f"./trash.html?q={title}",
                        icon="trash",
                    )
                )
                trash_limit_remaining -= 1
                if trash_limit_remaining <= 0:
                    break
    except Exception as e:
        logger.warning("Error searching Trash: %s", e)

    return UniversalSearchResponse(
        query=clean_q,
        total_hits=len(results),
        results=results,
    )
