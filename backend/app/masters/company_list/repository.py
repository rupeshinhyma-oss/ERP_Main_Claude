"""Company List Repository. Query-specific extensions for ``master_companies``."""

from __future__ import annotations

from typing import Sequence
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.masters.company_list.models import MasterCompany


class CompanyRepository(BaseRepository[MasterCompany]):
    """Repository for managing ``master_companies`` persistence."""

    searchable_fields = ("name", "code")
    sortable_fields = ("name", "code", "created_at", "updated_at")
    filterable_fields = ("status",)

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, MasterCompany)

    async def get_by_code(self, code: str) -> MasterCompany | None:
        """Fetch a company by unique code."""
        stmt = select(MasterCompany).where(MasterCompany.code == code)
        res = await self.session.execute(stmt)
        return res.scalar_one_or_none()

    async def get_by_name(self, name: str) -> MasterCompany | None:
        """Fetch a company by name."""
        stmt = select(MasterCompany).where(MasterCompany.name == name)
        res = await self.session.execute(stmt)
        return res.scalar_one_or_none()

    async def list_all(self) -> Sequence[MasterCompany]:
        """Fetch all companies ordered by name."""
        stmt = select(MasterCompany).order_by(MasterCompany.name)
        res = await self.session.execute(stmt)
        return res.scalars().all()
