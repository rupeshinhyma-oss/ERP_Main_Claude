"""
Universal Search Service.

Executes asynchronous database searches across all major ERP tables and entity models.
"""

from __future__ import annotations

import logging
from typing import List

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.departments.models import Department
from app.designations.models import Designation
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
from app.search.schemas import SearchResultItem, UniversalSearchResponse
from app.suppliers.models import Supplier
from app.tasks.models import Task
from app.users.models import User

logger = logging.getLogger(__name__)

LIMIT_PER_ENTITY = 5


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
            or_(
                User.username.ilike(pattern),
                User.email.ilike(pattern),
                User.first_name.ilike(pattern),
                User.last_name.ilike(pattern),
                User.display_name.ilike(pattern),
                User.employee_code.ilike(pattern),
                User.phone.ilike(pattern),
            )
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
            Supplier.deleted_at.is_(None),
            or_(
                Supplier.company_name.ilike(pattern),
                Supplier.brand_description.ilike(pattern),
            )
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

    # 4. Tasks
    try:
        stmt = select(Task).where(
            or_(
                Task.title.ilike(pattern),
                Task.description.ilike(pattern),
            )
        ).limit(LIMIT_PER_ENTITY)
        tasks = (await db.execute(stmt)).scalars().all()
        for t in tasks:
            results.append(
                SearchResultItem(
                    category="Tasks",
                    id=str(t.id),
                    title=t.title,
                    subtitle=f"Status: {t.status.value} | Priority: {t.priority.value}",
                    target_url="./tasks.html",
                    icon="task",
                )
            )
    except Exception as e:
        logger.warning("Error searching Tasks: %s", e)

    # 5. Products
    try:
        stmt = select(Product).where(
            or_(
                Product.name.ilike(pattern),
                Product.code.ilike(pattern),
                Product.description.ilike(pattern),
            )
        ).limit(LIMIT_PER_ENTITY)
        products = (await db.execute(stmt)).scalars().all()
        for p in products:
            results.append(
                SearchResultItem(
                    category="Products",
                    id=str(p.id),
                    title=p.name,
                    subtitle=f"Code: {p.code}" + (f" | {p.description[:40]}..." if p.description else ""),
                    target_url="./masters-products.html",
                    icon="box",
                )
            )
    except Exception as e:
        logger.warning("Error searching Products: %s", e)

    # 6. Categories & Sub-Categories
    try:
        stmt = select(ProductCategory).where(
            or_(
                ProductCategory.name.ilike(pattern),
                ProductCategory.code.ilike(pattern),
            )
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
            or_(
                ProductSubCategory.name.ilike(pattern),
                ProductSubCategory.code.ilike(pattern),
            )
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

    # 7. Brands
    try:
        stmt = select(Brand).where(
            or_(
                Brand.name.ilike(pattern),
                Brand.code.ilike(pattern),
            )
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

    # 8. Departments & Designations
    try:
        stmt_dept = select(Department).where(
            or_(
                Department.name.ilike(pattern),
                Department.code.ilike(pattern),
            )
        ).limit(LIMIT_PER_ENTITY)
        depts = (await db.execute(stmt_dept)).scalars().all()
        for d in depts:
            results.append(
                SearchResultItem(
                    category="Departments",
                    id=str(d.id),
                    title=d.name,
                    subtitle=f"Code: {d.code}",
                    target_url="./teams.html",
                    icon="building",
                )
            )

        stmt_desg = select(Designation).where(
            or_(
                Designation.name.ilike(pattern),
                Designation.code.ilike(pattern),
            )
        ).limit(LIMIT_PER_ENTITY)
        desgs = (await db.execute(stmt_desg)).scalars().all()
        for desg in desgs:
            results.append(
                SearchResultItem(
                    category="Designations",
                    id=str(desg.id),
                    title=desg.name,
                    subtitle=f"Code: {desg.code}",
                    target_url="./teams.html",
                    icon="briefcase",
                )
            )
    except Exception as e:
        logger.warning("Error searching Departments/Designations: %s", e)

    # 9. HSN Codes
    try:
        stmt = select(HsnCode).where(
            or_(
                HsnCode.code.ilike(pattern),
                HsnCode.description.ilike(pattern),
            )
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

    # 10. Countries, States, Cities
    try:
        stmt_c = select(Country).where(
            or_(
                Country.name.ilike(pattern),
                Country.code.ilike(pattern),
                Country.iso3.ilike(pattern),
            )
        ).limit(LIMIT_PER_ENTITY)
        countries = (await db.execute(stmt_c)).scalars().all()
        for c in countries:
            results.append(
                SearchResultItem(
                    category="Countries",
                    id=str(c.id),
                    title=c.name,
                    subtitle=f"Code: {c.code} / {c.iso3 or ''}",
                    target_url="./masters-countries.html",
                    icon="globe",
                )
            )

        stmt_s = select(State).where(
            or_(
                State.name.ilike(pattern),
                State.code.ilike(pattern),
            )
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

        stmt_ci = select(City).where(City.name.ilike(pattern)).limit(LIMIT_PER_ENTITY)
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

    # 11. Currencies & UOM
    try:
        stmt_curr = select(Currency).where(
            or_(
                Currency.name.ilike(pattern),
                Currency.code.ilike(pattern),
                Currency.symbol.ilike(pattern),
            )
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
            or_(
                UnitOfMeasurement.name.ilike(pattern),
                UnitOfMeasurement.code.ilike(pattern),
            )
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

    return UniversalSearchResponse(
        query=clean_q,
        total_hits=len(results),
        results=results,
    )
