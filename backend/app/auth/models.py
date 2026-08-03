"""
Auth ORM Models.

Owns everything about *how* a user is currently (or was previously) logged
in, as opposed to :mod:`app.users.models` which owns *who* the user is.

Tables:
    - ``sessions``         : one row per issued refresh token / login session,
                              carrying device + IP metadata and revocation state.
    - ``token_blacklist``  : explicitly revoked token IDs (``jti``), checked on
                              every authenticated request so a logged-out or
                              force-logged-out token stops working immediately
                              instead of merely expiring naturally.
    - ``password_history`` : previous password hashes, used to enforce
                              "cannot reuse your last N passwords".
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, TimestampMixin, UUIDPrimaryKeyMixin

if TYPE_CHECKING:
    from app.users.models import User


def _utcnow() -> datetime:
    """Return the current time as a timezone-aware UTC datetime."""
    return datetime.now(timezone.utc)


def _as_aware_utc(value: datetime) -> datetime:
    """
    Ensure a datetime is timezone-aware (assuming UTC if naive).

    PostgreSQL's ``TIMESTAMP WITH TIME ZONE`` always round-trips as
    timezone-aware, but non-Postgres backends used in local testing (e.g.
    SQLite) silently drop tzinfo on read. Normalizing here keeps
    comparisons against ``datetime.now(timezone.utc)`` correct regardless
    of backend.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


class Session(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """
    A single login session, anchored to one issued refresh token.

    A new row is created on every successful login (and on every refresh,
    the previous row is rotated -- see ``app.auth.service`` for the
    rotate-on-refresh policy that prevents refresh-token replay). Listing a
    user's active sessions and force-logging-out a device both operate on
    this table.
    """

    __tablename__ = "sessions"

    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    refresh_token_jti: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)

    device_info: Mapped[str | None] = mapped_column(String(255), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String(500), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(String(64), nullable=True)

    is_revoked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(100), nullable=True)

    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    user: Mapped["User"] = relationship(foreign_keys=[user_id])

    def __repr__(self) -> str:
        """Return a debug-friendly representation (never includes the raw token)."""
        return f"<Session user_id={self.user_id} revoked={self.is_revoked}>"

    @property
    def is_active(self) -> bool:
        """Return True if this session is neither revoked nor expired."""
        return not self.is_revoked and _as_aware_utc(self.expires_at) > datetime.now(timezone.utc)


class TokenBlacklist(Base, UUIDPrimaryKeyMixin):
    """
    Explicitly revoked token IDs.

    Access tokens are short-lived (15 minutes) but stateless JWTs cannot be
    "un-issued" -- without a blacklist, a token captured at logout time
    would remain valid until it naturally expired. Every authenticated
    request checks this table for the token's ``jti`` (see
    ``app.auth.dependencies.get_current_user``), and expired rows are safe
    to prune periodically since the token would be rejected on expiry
    grounds anyway.
    """

    __tablename__ = "token_blacklist"

    jti: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    token_type: Mapped[str] = mapped_column(String(20), nullable=False)  # "access" | "refresh"
    user_id: Mapped[uuid.UUID | None] = mapped_column(GUID(), ForeignKey("users.id", ondelete="CASCADE"))
    reason: Mapped[str | None] = mapped_column(String(100), nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    blacklisted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    def __repr__(self) -> str:
        """Return a debug-friendly representation."""
        return f"<TokenBlacklist jti={self.jti!r} type={self.token_type!r}>"


class PasswordHistory(Base, UUIDPrimaryKeyMixin):
    """
    A previously-used password hash for one user.

    Only the hash is stored (never the plaintext). ``app.auth.security``
    checks new passwords against the most recent
    ``settings.PASSWORD_HISTORY_SIZE`` rows for a user before allowing a
    password change, and old rows beyond that window are pruned.
    """

    __tablename__ = "password_history"

    user_id: Mapped[uuid.UUID] = mapped_column(GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, nullable=False)

    def __repr__(self) -> str:
        """Return a debug-friendly representation (never includes the hash)."""
        return f"<PasswordHistory user_id={self.user_id}>"
