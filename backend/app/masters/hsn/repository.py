"""HSN Repository. Query-specific extensions for ``hsn_codes``."""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.hsn.models import HsnCode


class HsnRepository(BaseRepository[HsnCode]):
    """Repository for HSN code rows."""

    searchable_fields = ("code", "description")
    sortable_fields = ("code", "gst_percent", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``HsnCode`` model."""
        super().__init__(session, HsnCode)

    async def get_by_code(self, code: str) -> HsnCode | None:
        """Fetch an HSN code by its unique code."""
        stmt = self._base_select().where(HsnCode.code == code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def code_exists(self, code: str, *, exclude_id: uuid.UUID | None = None) -> bool:
        """Return True if another (non-deleted) HSN code row already uses this code."""
        stmt = self._base_select().with_only_columns(HsnCode.id).where(HsnCode.code == code)
        if exclude_id is not None:
            stmt = stmt.where(HsnCode.id != exclude_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def list_all(self) -> list[HsnCode]:
        """Return every non-deleted HSN code, ordered by code."""
        stmt = self._base_select().order_by(HsnCode.code)
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def is_referenced(self, hsn_id: uuid.UUID) -> bool:
        """Return True if any product references this HSN code (blocks delete)."""
        from sqlalchemy import select

        from app.masters.products.models import Product

        stmt = select(Product.id).where(Product.hsn_id == hsn_id, Product.deleted_at.is_(None)).limit(1)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None
