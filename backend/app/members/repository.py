"""Member Password Vault Repository."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.members.models import MemberPasswordVault


class MemberPasswordVaultRepository:
    """Repository for the reversible-encrypted password vault (see models.py for why this exists)."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session."""
        self.session = session

    async def get_by_user_id(self, user_id: uuid.UUID) -> MemberPasswordVault | None:
        """Fetch the vault entry for a user, if one exists."""
        stmt = select(MemberPasswordVault).where(MemberPasswordVault.user_id == user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def upsert(self, user_id: uuid.UUID, encrypted_password: str) -> MemberPasswordVault:
        """Create or replace the vault entry for a user with a new encrypted password."""
        existing = await self.get_by_user_id(user_id)
        if existing is not None:
            existing.encrypted_password = encrypted_password
            await self.session.flush()
            return existing
        vault = MemberPasswordVault(user_id=user_id, encrypted_password=encrypted_password)
        self.session.add(vault)
        await self.session.flush()
        return vault

    async def delete_by_user_id(self, user_id: uuid.UUID) -> None:
        """Remove the vault entry for a user, if any (e.g. if the user is deleted)."""
        existing = await self.get_by_user_id(user_id)
        if existing is not None:
            await self.session.delete(existing)
            await self.session.flush()
