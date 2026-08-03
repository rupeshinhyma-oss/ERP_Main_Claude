"""
Auth Repositories.

Query-specific extensions for the three tables :mod:`app.auth.models`
owns: ``sessions``, ``token_blacklist``, and ``password_history``. These
back the session-tracking, token-revocation, and password-reuse-prevention
flows implemented in :mod:`app.auth.service`.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.models import PasswordHistory, Session, TokenBlacklist
from app.common.base_repository import BaseRepository


class SessionRepository(BaseRepository[Session]):
    """Repository for login-session rows."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``Session`` model."""
        super().__init__(session, Session)

    async def get_by_refresh_jti(self, jti: str) -> Session | None:
        """Fetch a session by the ``jti`` of the refresh token that anchors it."""
        stmt = select(Session).where(Session.refresh_token_jti == jti)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none()

    async def list_active_for_user(self, user_id: uuid.UUID) -> list[Session]:
        """List every currently active (not revoked, not expired) session for a user."""
        now = datetime.now(timezone.utc)
        stmt = (
            select(Session)
            .where(Session.user_id == user_id, Session.is_revoked.is_(False), Session.expires_at > now)
            .order_by(Session.last_used_at.desc())
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def revoke(self, instance: Session, *, reason: str) -> Session:
        """Mark a single session as revoked."""
        instance.is_revoked = True
        instance.revoked_at = datetime.now(timezone.utc)
        instance.revoked_reason = reason
        await self.session.flush()
        return instance

    async def revoke_all_for_user(self, user_id: uuid.UUID, *, reason: str) -> int:
        """Revoke every active session for a user (force-logout). Returns the number revoked."""
        now = datetime.now(timezone.utc)
        stmt = (
            update(Session)
            .where(Session.user_id == user_id, Session.is_revoked.is_(False))
            .values(is_revoked=True, revoked_at=now, revoked_reason=reason)
        )
        result = await self.session.execute(stmt)
        await self.session.flush()
        return int(result.rowcount or 0)


class TokenBlacklistRepository(BaseRepository[TokenBlacklist]):
    """Repository for explicitly revoked token IDs."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``TokenBlacklist`` model."""
        super().__init__(session, TokenBlacklist)

    async def is_blacklisted(self, jti: str) -> bool:
        """Return True if a token with this ``jti`` has been explicitly revoked."""
        stmt = select(TokenBlacklist.id).where(TokenBlacklist.jti == jti)
        result = await self.session.execute(stmt)
        return result.scalar_one_or_none() is not None

    async def blacklist(
        self,
        *,
        jti: str,
        token_type: str,
        user_id: uuid.UUID | None,
        expires_at: datetime,
        reason: str,
    ) -> TokenBlacklist:
        """Record a token ``jti`` as revoked, if not already present."""
        if await self.is_blacklisted(jti):
            stmt = select(TokenBlacklist).where(TokenBlacklist.jti == jti)
            result = await self.session.execute(stmt)
            return result.scalar_one()
        return await self.create(
            jti=jti, token_type=token_type, user_id=user_id, expires_at=expires_at, reason=reason
        )


class PasswordHistoryRepository(BaseRepository[PasswordHistory]):
    """Repository for previously-used password hashes."""

    def __init__(self, session: AsyncSession) -> None:
        """Bind to a DB session, operating on the ``PasswordHistory`` model."""
        super().__init__(session, PasswordHistory)

    async def list_recent_for_user(self, user_id: uuid.UUID, *, limit: int) -> list[PasswordHistory]:
        """Return a user's most recent password-history rows, newest first."""
        stmt = (
            select(PasswordHistory)
            .where(PasswordHistory.user_id == user_id)
            .order_by(PasswordHistory.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def record(self, user_id: uuid.UUID, password_hash: str) -> PasswordHistory:
        """Record a (now superseded) password hash for a user."""
        return await self.create(user_id=user_id, password_hash=password_hash)
