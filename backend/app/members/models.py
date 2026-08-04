"""
Member Password Vault Model.

Stores a reversible-encrypted copy of a team member's current password,
purely so an admin can view/reset it later from the Teams page (an
explicit product requirement for this feature). This is intentionally
separate from app.users.models.User.password_hash, which remains the
one-way Argon2 hash that actually authenticates logins -- this vault
entry is never used for login itself, only for the admin "eye icon"
reveal/reset UI.

One row per User (1:1), replaced in place whenever the admin resets a
member's password through this feature.
"""

from __future__ import annotations

import uuid

from sqlalchemy import ForeignKey, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import GUID, Base, TimestampMixin, UUIDPrimaryKeyMixin


class MemberPasswordVault(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """Reversible-encrypted password storage for one User, admin-viewable via the Teams page."""

    __tablename__ = "member_password_vault"

    user_id: Mapped[uuid.UUID] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, unique=True, index=True
    )
    encrypted_password: Mapped[str] = mapped_column(Text, nullable=False)

    def __repr__(self) -> str:
        """Return a debug-friendly representation (never includes the password itself)."""
        return f"<MemberPasswordVault user_id={self.user_id}>"
