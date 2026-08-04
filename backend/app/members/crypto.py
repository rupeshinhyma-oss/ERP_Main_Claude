"""
Reversible Password Encryption.

Used ONLY by the Teams "Add Member" feature (app.members), which -- per an
explicit product requirement -- lets an admin set a member's password
directly and view it in plain text later, not just once at creation. This
is a deliberate departure from how every other credential in this system
works (app.auth/app.users store only a one-way Argon2 hash, which can
never be recovered); it necessarily requires a REVERSIBLE encryption
scheme instead of a one-way hash, so it is confined to this one feature
and its own dedicated storage (app.members.models.MemberPasswordVault),
not the core User.password_hash column.

Security notes:
  - Anyone with database access, or admin-panel access to this feature,
    can recover a plaintext password. This is an inherent, unavoidable
    consequence of "the admin can view it later" -- there is no way to
    satisfy that requirement without SOME form of reversibility.
  - Fernet (from the `cryptography` package) is used rather than a
    hand-rolled scheme: it's authenticated encryption (AES-128-CBC +
    HMAC), so a tampered ciphertext fails to decrypt rather than silently
    returning garbage.
  - The encryption key is a separate secret from JWT_SECRET_KEY
    (app.core.config.settings.MEMBER_PASSWORD_ENCRYPTION_KEY) so that
    rotating one secret doesn't silently break the other feature.
"""

from __future__ import annotations

import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings
from app.core.exceptions import BadRequestException


def _derive_fernet_key(raw_secret: str) -> bytes:
    """
    Derive a valid 32-byte urlsafe-base64 Fernet key from an arbitrary secret string.

    Lets settings.MEMBER_PASSWORD_ENCRYPTION_KEY be any sufficiently long
    random string (matching the existing JWT_SECRET_KEY convention)
    rather than requiring the operator to generate a Fernet-formatted key
    specifically.
    """
    digest = hashlib.sha256(raw_secret.encode("utf-8")).digest()  # exactly 32 bytes
    return base64.urlsafe_b64encode(digest)


def _get_fernet() -> Fernet:
    """Build the Fernet cipher from the configured encryption key."""
    key = _derive_fernet_key(settings.MEMBER_PASSWORD_ENCRYPTION_KEY)
    return Fernet(key)


def encrypt_password(plain_password: str) -> str:
    """Encrypt a plaintext password for admin-recoverable storage. Returns a urlsafe base64 token string."""
    token = _get_fernet().encrypt(plain_password.encode("utf-8"))
    return token.decode("utf-8")


def decrypt_password(encrypted_password: str) -> str:
    """
    Decrypt a password previously encrypted with :func:`encrypt_password`.

    Raises :class:`BadRequestException` if the ciphertext is invalid or
    was encrypted with a different key (e.g. after a key rotation) --
    surfaced as a clear error rather than a raw crypto exception.
    """
    try:
        plain_bytes = _get_fernet().decrypt(encrypted_password.encode("utf-8"))
    except InvalidToken as exc:
        raise BadRequestException(
            "Could not decrypt the stored password. It may have been encrypted with a "
            "different MEMBER_PASSWORD_ENCRYPTION_KEY (e.g. after a key rotation)."
        ) from exc
    return plain_bytes.decode("utf-8")
