"""SupplierType Dependencies."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.supplier_types.repository import SupplierTypeRepository
from app.masters.supplier_types.service import SupplierTypeService


def get_supplier_type_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> SupplierTypeService:
    return SupplierTypeService(SupplierTypeRepository(db), cache_manager)
