"""Supplier Dependencies. FastAPI DI wiring for the suppliers module."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.cities.repository import CityRepository
from app.masters.countries.repository import CountryRepository
from app.masters.product_categories.repository import ProductCategoryRepository
from app.masters.product_sub_categories.repository import ProductSubCategoryRepository
from app.masters.states.repository import StateRepository
from app.suppliers.repository import SupplierContactRepository, SupplierRepository
from app.suppliers.service import SupplierService


def get_supplier_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> SupplierService:
    """Build a request-scoped :class:`SupplierService`, wired to every master it references."""
    return SupplierService(
        SupplierRepository(db),
        SupplierContactRepository(db),
        CountryRepository(db),
        StateRepository(db),
        CityRepository(db),
        ProductCategoryRepository(db),
        ProductSubCategoryRepository(db),
        cache_manager,
    )
