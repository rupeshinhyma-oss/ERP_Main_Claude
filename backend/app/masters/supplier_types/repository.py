"""SupplierType Repository."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.supplier_types.models import SupplierType


class SupplierTypeRepository(BaseRepository[SupplierType]):
    """Repository for supplier_type rows."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session."""
        super().__init__(session, SupplierType)

    async def get_by_code(self, code: str) -> SupplierType | None:
        """Fetch a supplier type by its code."""
        stmt = self._base_select().where(SupplierType.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Check if code exists."""
        stmt = self._base_select().with_only_columns(SupplierType.id).where(SupplierType.code == code)
        if exclude_id is not None:
            stmt = stmt.where(SupplierType.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def get_by_name(self, name: str, *, exclude_id: uuid.UUID | None = None) -> SupplierType | None:
        """Fetch by name."""
        stmt = self._base_select().where(SupplierType.name == name)
        if exclude_id is not None:
            stmt = stmt.where(SupplierType.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_all(self) -> list[SupplierType]:
        """Return all non-deleted supplier types ordered by name."""
        stmt = self._base_select().order_by(SupplierType.name)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, supplier_type_id: uuid.UUID) -> bool:
        """Check if referenced."""
        return False
