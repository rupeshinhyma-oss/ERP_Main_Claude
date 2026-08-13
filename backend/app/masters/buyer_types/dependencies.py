"""BuyerType Dependencies."""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager
from app.database.session import get_db_session
from app.masters.buyer_types.repository import BuyerTypeRepository
from app.masters.buyer_types.service import BuyerTypeService


def get_buyer_type_service(
    db: AsyncSession = Depends(get_db_session),
    cache_manager: CacheManager = Depends(get_cache_manager),
) -> BuyerTypeService:
    return BuyerTypeService(BuyerTypeRepository(db), cache_manager)
