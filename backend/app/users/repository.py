"""
User Repository.

Query-specific extensions for the ``users`` table: lookups by username,
email, or either (used at login, where the client submits a single
"identifier" field), plus the uniqueness check used at account creation.
"""

from __future__ import annotations

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.users.models import User


class UserRepository(BaseRepository[User]):
    """Repository for user rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``User`` model."""
        super().__init__(session, User)

    async def get_by_username(self, username: str) -> User | None:
        """Fetch a user by their exact username."""
        stmt = select(User).where(User.username == username)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_email(self, email: str) -> User | None:
        """Fetch a user by their exact email address."""
        stmt = select(User).where(User.email == email)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_username_or_email(self, identifier: str) -> User | None:
        """
        Fetch a user whose username OR email matches ``identifier``.

        Used at login time, where the client submits a single field that
        may be either -- this lets users authenticate with whichever they
        remember.
        """
        stmt = select(User).where(or_(User.username == identifier, User.email == identifier))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def username_or_email_exists(self, *, username: str, email: str) -> bool:
        """Return True if a user with this username or email already exists."""
        stmt = select(User.id).where(or_(User.username == username, User.email == email))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None
