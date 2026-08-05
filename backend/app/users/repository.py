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

    async def get_by_employee_code(self, employee_code: str) -> User | None:
        """Fetch a user by their exact employee_code."""
        stmt = select(User).where(User.employee_code == employee_code)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def username_or_email_exists(self, *, username: str, email: str) -> bool:
        """Return True if a user with this username or email already exists."""
        stmt = select(User.id).where(or_(User.username == username, User.email == email))
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def username_exists(self, username: str, *, exclude_user_id: uuid.UUID | None = None) -> bool:
        """Return True if username is taken by any user other than exclude_user_id."""
        stmt = select(User.id).where(User.username == username)
        if exclude_user_id is not None:
            stmt = stmt.where(User.id != exclude_user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def email_exists(self, email: str, *, exclude_user_id: uuid.UUID | None = None) -> bool:
        """Return True if email is taken by any user other than exclude_user_id."""
        stmt = select(User.id).where(User.email == email)
        if exclude_user_id is not None:
            stmt = stmt.where(User.id != exclude_user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def employee_code_exists(self, employee_code: str, *, exclude_user_id: uuid.UUID | None = None) -> bool:
        """Return True if employee_code is linked to any user other than exclude_user_id."""
        stmt = select(User.id).where(User.employee_code == employee_code)
        if exclude_user_id is not None:
            stmt = stmt.where(User.id != exclude_user_id)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def search(
        self,
        *,
        query: str | None = None,
        status: str | None = None,
        department_id: uuid.UUID | None = None,
        designation_id: uuid.UUID | None = None,
        offset: int = 0,
        limit: int = 50,
    ) -> tuple[list[User], int]:
        """Search users with optional keyword, status, department, and designation filters."""
        from sqlalchemy import func
        from app.users.models import UserStatus

        stmt = select(User)
        count_stmt = select(func.count(User.id))

        filters = []
        if query and query.strip():
            pattern = f"%{query.strip()}%"
            filters.append(
                or_(
                    User.username.ilike(pattern),
                    User.email.ilike(pattern),
                    User.first_name.ilike(pattern),
                    User.last_name.ilike(pattern),
                    User.display_name.ilike(pattern),
                    User.employee_code.ilike(pattern),
                    User.phone.ilike(pattern),
                )
            )
        if status and status.strip():
            try:
                st_enum = UserStatus(status.strip())
                filters.append(User.status == st_enum)
            except ValueError:
                pass

        if department_id is not None:
            filters.append(User.department_id == department_id)
        if designation_id is not None:
            filters.append(User.designation_id == designation_id)

        if filters:
            stmt = stmt.where(*filters)
            count_stmt = count_stmt.where(*filters)

        stmt = stmt.order_by(User.created_at.desc()).offset(offset).limit(limit)

        users_res = await self.session.execute(stmt)
        count_res = await self.session.execute(count_stmt)

        users = list(users_res.scalars().all())
        total = count_res.scalar_one() or 0
        return users, total

