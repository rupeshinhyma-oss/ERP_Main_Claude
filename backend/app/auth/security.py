"""
Security Primitives.

Pure, framework-agnostic functions for password hashing/verification, JWT
issuance/decoding, and password-strength validation. Nothing in this module
touches the database or FastAPI -- it is deliberately a leaf module so it
can be unit-tested in isolation and imported from anywhere (services,
scripts/seed.py, tests) without pulling in the web layer.
"""

from __future__ import annotations

import re
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.core.config import settings

# -------------------------------------------------------------------------
# Password hashing (Argon2id, via argon2-cffi's high-level PasswordHasher)
# -------------------------------------------------------------------------
# Defaults (time_cost=3, memory_cost=64MB, parallelism=4) are argon2-cffi's
# own OWASP-aligned recommendations; not overridden here so that a future
# argon2-cffi upgrade can safely raise them without a code change.
_password_hasher = PasswordHasher()


def hash_password(plain_password: str) -> str:
    """Hash a plaintext password with Argon2id. Never call this with an already-hashed value."""
    return _password_hasher.hash(plain_password)


def verify_password(plain_password: str, password_hash: str) -> bool:
    """Verify a plaintext password against a stored Argon2 hash, without raising on mismatch."""
    try:
        return _password_hasher.verify(password_hash, plain_password)
    except (VerifyMismatchError, InvalidHashError):
        return False


def needs_rehash(password_hash: str) -> bool:
    """
    Return True if a stored hash was produced with weaker-than-current Argon2 parameters.

    Call this after a successful ``verify_password`` and, if True, re-hash
    the plaintext (which you have at that moment) and persist the new hash
    -- this is how Argon2 parameters are upgraded over time without forcing
    every user through a password reset.
    """
    return _password_hasher.check_needs_rehash(password_hash)


def generate_temporary_password(length: int = 16) -> str:
    """
    Generate a cryptographically random temporary password meeting the strength policy.

    Used by admin-generated password resets (``POST /users/{id}/reset-password``)
    where there is no user-supplied plaintext to hash.
    """
    alphabet_lower = "abcdefghijkmnopqrstuvwxyz"  # no 'l' to avoid visual ambiguity
    alphabet_upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"  # no 'I', 'O'
    digits = "23456789"  # no '0', '1'
    specials = "!@#$%^&*-_=+"

    # Guarantee at least one of each required class, then fill the rest randomly.
    chars = [
        secrets.choice(alphabet_lower),
        secrets.choice(alphabet_upper),
        secrets.choice(digits),
        secrets.choice(specials),
    ]
    pool = alphabet_lower + alphabet_upper + digits + specials
    chars.extend(secrets.choice(pool) for _ in range(max(length - len(chars), 0)))
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)


# -------------------------------------------------------------------------
# Password strength validation
# -------------------------------------------------------------------------
_SPECIAL_CHARS_PATTERN = re.compile(r"[!@#$%^&*()\-_=+\[\]{};:'\",.<>/?\\|`~]")


def validate_password_strength(password: str) -> list[str]:
    """
    Validate a plaintext password against the configured password policy.

    Returns a list of human-readable violation messages (empty list means
    the password is acceptable). Returning a list rather than
    raising/boolean lets callers surface every violation to the user at
    once instead of one round-trip per failed rule.
    """
    violations: list[str] = []

    if len(password) < settings.PASSWORD_MIN_LENGTH:
        violations.append(f"Password must be at least {settings.PASSWORD_MIN_LENGTH} characters long.")
    if settings.PASSWORD_REQUIRE_UPPERCASE and not re.search(r"[A-Z]", password):
        violations.append("Password must contain at least one uppercase letter.")
    if settings.PASSWORD_REQUIRE_LOWERCASE and not re.search(r"[a-z]", password):
        violations.append("Password must contain at least one lowercase letter.")
    if settings.PASSWORD_REQUIRE_DIGIT and not re.search(r"\d", password):
        violations.append("Password must contain at least one digit.")
    if settings.PASSWORD_REQUIRE_SPECIAL and not _SPECIAL_CHARS_PATTERN.search(password):
        violations.append("Password must contain at least one special character.")

    return violations


# -------------------------------------------------------------------------
# JWT issuance / decoding
# -------------------------------------------------------------------------
class TokenType(str, Enum):
    """Discriminates access vs. refresh tokens inside the JWT's ``type`` claim."""

    ACCESS = "access"
    REFRESH = "refresh"


@dataclass(frozen=True)
class IssuedToken:
    """The encoded JWT string plus the claims that were embedded in it."""

    token: str
    jti: str
    expires_at: datetime


class InvalidTokenError(Exception):
    """Raised when a JWT fails signature verification, has expired, or is malformed."""


def _encode_token(
    *,
    subject: uuid.UUID,
    token_type: TokenType,
    expires_delta: timedelta,
    extra_claims: dict[str, Any] | None = None,
) -> IssuedToken:
    """Build and sign a JWT with standard claims (``sub``, ``jti``, ``iat``, ``exp``, ``iss``, ``type``)."""
    now = datetime.now(timezone.utc)
    expires_at = now + expires_delta
    jti = uuid.uuid4().hex

    payload: dict[str, Any] = {
        "sub": str(subject),
        "jti": jti,
        "iat": now,
        "exp": expires_at,
        "iss": settings.JWT_ISSUER,
        "type": token_type.value,
    }
    if extra_claims:
        payload.update(extra_claims)

    token = jwt.encode(payload, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return IssuedToken(token=token, jti=jti, expires_at=expires_at)


def create_access_token(user_id: uuid.UUID, *, permissions: list[str] | None = None) -> IssuedToken:
    """
    Issue a short-lived access token for the given user.

    Permission codes are embedded directly in the token (``perms`` claim)
    as a read-through-request-cycle optimization: routes protected by
    ``require_permission()`` can authorize without a DB round-trip on every
    single request. Permissions still originate from and are only ever
    edited in the database -- this is a cache of that data with a 15-minute
    natural expiry, not a second source of truth.
    """
    return _encode_token(
        subject=user_id,
        token_type=TokenType.ACCESS,
        expires_delta=timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
        extra_claims={"perms": sorted(permissions) if permissions is not None else []},
    )


def create_refresh_token(user_id: uuid.UUID) -> IssuedToken:
    """Issue a long-lived refresh token for the given user."""
    return _encode_token(
        subject=user_id,
        token_type=TokenType.REFRESH,
        expires_delta=timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
    )


def decode_token(token: str, *, expected_type: TokenType) -> dict[str, Any]:
    """
    Decode and verify a JWT, enforcing signature, expiry, issuer, and token type.

    Raises :class:`InvalidTokenError` for every failure mode (expired,
    bad signature, wrong type, malformed) so callers have exactly one
    exception type to handle, rather than needing to know PyJWT's internal
    exception hierarchy.
    """
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET_KEY,
            algorithms=[settings.JWT_ALGORITHM],
            issuer=settings.JWT_ISSUER,
            options={"require": ["exp", "iat", "sub", "jti", "type"]},
        )
    except jwt.PyJWTError as exc:
        raise InvalidTokenError(str(exc)) from exc

    if payload.get("type") != expected_type.value:
        raise InvalidTokenError(f"Expected a {expected_type.value} token, got {payload.get('type')!r}.")

    return payload
