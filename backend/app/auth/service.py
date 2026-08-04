"""
Auth Service.

All authentication business logic lives here: credential verification,
account lockout, login rate limiting, token issuance/rotation, session
tracking, and password change/reset. Routes only translate HTTP <->
these methods; repositories only translate these methods <-> SQL.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from app.auth.models import Session
from app.auth.repository import PasswordHistoryRepository, SessionRepository, TokenBlacklistRepository
from app.auth.security import (
    InvalidTokenError,
    TokenType,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    validate_password_strength,
    verify_password,
)
from app.cache.base import CacheBackend
from app.core.config import settings
from app.core.exceptions import ForbiddenException, TooManyRequestsException, UnauthorizedException, ValidationException
from app.rbac.repository import RoleRepository
from app.users.models import User, UserStatus
from app.users.repository import UserRepository


@dataclass
class LoginContext:
    """Request-derived context needed for lockout/rate-limiting and session tracking."""

    ip_address: str | None = None
    user_agent: str | None = None
    device_info: str | None = None


@dataclass
class CurrentUser:
    """
    The resolved identity + authorization context of an authenticated request.

    Built once per request by ``app.auth.dependencies.get_current_user`` from
    a verified access token, and passed down to route handlers /
    ``require_permission`` checks.
    """

    id: uuid.UUID
    username: str
    permissions: set[str] = field(default_factory=set)
    access_token_jti: str = ""
    must_change_password: bool = False


class AuthService:
    """Orchestrates authentication flows on top of the user/session/token repositories."""

    def __init__(
        self,
        user_repository: UserRepository,
        role_repository: RoleRepository,
        session_repository: SessionRepository,
        token_blacklist_repository: TokenBlacklistRepository,
        password_history_repository: PasswordHistoryRepository,
        cache: CacheBackend,
    ) -> None:
        """Bind this service to its repositories and the rate-limiting cache."""
        self.user_repository = user_repository
        self.role_repository = role_repository
        self.session_repository = session_repository
        self.token_blacklist_repository = token_blacklist_repository
        self.password_history_repository = password_history_repository
        self.cache = cache

    # --- Login rate limiting (per-identifier, independent of account lockout) ---
    def _rate_limit_key(self, identifier: str) -> str:
        """Build the cache key tracking login attempts for a given identifier."""
        return CacheBackend.build_key("login_rate_limit", identifier.lower())

    async def _check_rate_limit(self, identifier: str) -> None:
        """Reject the login attempt outright if the identifier has been hammered recently."""
        key = self._rate_limit_key(identifier)
        attempts = await self.cache.get(key) or 0
        if attempts >= settings.LOGIN_RATE_LIMIT_MAX_ATTEMPTS:
            raise TooManyRequestsException(
                "Too many login attempts. Please wait a few minutes before trying again."
            )

    async def _record_rate_limit_attempt(self, identifier: str) -> None:
        """Increment the login-attempt counter for an identifier within the rate-limit window."""
        key = self._rate_limit_key(identifier)
        attempts = (await self.cache.get(key) or 0) + 1
        await self.cache.set(key, attempts, ttl_seconds=settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS)

    # --- Effective Permissions helper ---------------------------------------
    async def get_user_effective_permissions(self, user_id: uuid.UUID) -> set[str]:
        """Fetch user's effective permissions with caching and immediate invalidation support."""
        cache_key = CacheBackend.build_key("user_perms", str(user_id))
        cached = await self.cache.get(cache_key)
        if cached is not None and isinstance(cached, list):
            return set(cached)

        perms = await self.role_repository.get_permission_codes_for_user(user_id)
        await self.cache.set(cache_key, list(perms), ttl_seconds=3600)
        return perms

    # --- Login --------------------------------------------------------------
    async def login(self, *, identifier: str, password: str, context: LoginContext) -> tuple[User, str, str]:
        """
        Verify credentials and, on success, issue a new access/refresh token pair.
        """
        await self._check_rate_limit(identifier)

        user = await self.user_repository.get_by_username_or_email(identifier)
        if user is None:
            await self._record_rate_limit_attempt(identifier)
            raise UnauthorizedException("Invalid username/email or password.")

        if user.is_locked or user.status == UserStatus.LOCKED:
            raise UnauthorizedException(
                "This account is temporarily locked due to repeated failed login attempts. "
                "Please try again later or contact an administrator."
            )

        if not verify_password(password, user.password_hash):
            await self._record_rate_limit_attempt(identifier)
            await self._register_failed_attempt(user)
            raise UnauthorizedException("Invalid username/email or password.")

        if not user.can_login:
            raise UnauthorizedException("This account is not active. Please contact an administrator.")

        # Success: reset failed-attempt counter and record login.
        user.failed_login_count = 0
        user.locked_until = None
        user.last_login_at = datetime.now(timezone.utc)
        await self.user_repository.update(user)

        access_token, refresh_token = await self._issue_token_pair(user, context)
        return user, access_token, refresh_token

    async def _register_failed_attempt(self, user: User) -> None:
        """Increment a user's failed-login counter, locking the account if threshold is hit."""
        user.failed_login_count += 1
        if user.failed_login_count >= settings.MAX_FAILED_LOGIN_ATTEMPTS:
            user.locked_until = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCOUNT_LOCK_MINUTES)
            user.status = UserStatus.LOCKED
        await self.user_repository.update(user)

    async def _issue_token_pair(self, user: User, context: LoginContext) -> tuple[str, str]:
        """Issue a fresh access + refresh token pair and persist the new session row."""
        permissions = await self.get_user_effective_permissions(user.id)
        access = create_access_token(user.id, permissions=list(permissions))
        refresh = create_refresh_token(user.id)

        await self.session_repository.create(
            user_id=user.id,
            refresh_token_jti=refresh.jti,
            device_info=context.device_info,
            user_agent=context.user_agent,
            ip_address=context.ip_address,
            is_revoked=False,
            expires_at=refresh.expires_at,
        )
        return access.token, refresh.token

    # --- Refresh --------------------------------------------------------------
    async def refresh(self, *, refresh_token: str, context: LoginContext) -> tuple[str, str]:
        """Rotate a refresh token: verify it, revoke it, and issue a brand new pair."""
        try:
            payload = decode_token(refresh_token, expected_type=TokenType.REFRESH)
        except InvalidTokenError as exc:
            raise UnauthorizedException("Invalid or expired refresh token.") from exc

        jti = payload["jti"]
        if await self.token_blacklist_repository.is_blacklisted(jti):
            raise UnauthorizedException("This refresh token has been revoked.")

        session = await self.session_repository.get_by_refresh_jti(jti)
        if session is None or not session.is_active:
            raise UnauthorizedException("This session is no longer active. Please log in again.")

        user = await self.user_repository.get_by_id(uuid.UUID(payload["sub"]))
        if user is None or not user.can_login:
            raise UnauthorizedException("This account is not active. Please contact an administrator.")

        # Rotate: revoke the old session/token, issue a fresh pair.
        await self.session_repository.revoke(session, reason="rotated_on_refresh")
        await self.token_blacklist_repository.blacklist(
            jti=jti,
            token_type=TokenType.REFRESH.value,
            user_id=user.id,
            expires_at=session.expires_at,
            reason="rotated_on_refresh",
        )
        session.last_used_at = datetime.now(timezone.utc)

        access_token, new_refresh_token = await self._issue_token_pair(user, context)
        return access_token, new_refresh_token

    # --- Logout -----------------------------------------------------------------
    async def logout(self, *, access_token_jti: str, access_token_exp: datetime, refresh_token: str) -> None:
        """Blacklist the current access token and revoke the session behind the refresh token."""
        await self.token_blacklist_repository.blacklist(
            jti=access_token_jti,
            token_type=TokenType.ACCESS.value,
            user_id=None,
            expires_at=access_token_exp,
            reason="logout",
        )
        try:
            payload = decode_token(refresh_token, expected_type=TokenType.REFRESH)
        except InvalidTokenError:
            return

        session = await self.session_repository.get_by_refresh_jti(payload["jti"])
        if session is not None and session.is_active:
            await self.session_repository.revoke(session, reason="logout")
            await self.token_blacklist_repository.blacklist(
                jti=payload["jti"],
                token_type=TokenType.REFRESH.value,
                user_id=None,
                expires_at=session.expires_at,
                reason="logout",
            )

    async def force_logout_user(self, user_id: uuid.UUID, *, reason: str = "admin_force_logout") -> int:
        """Revoke every active session for a user."""
        return await self.session_repository.revoke_all_for_user(user_id, reason=reason)

    # --- Sessions -----------------------------------------------------------------
    async def list_sessions(self, user_id: uuid.UUID) -> list[Session]:
        """List a user's currently active sessions."""
        return await self.session_repository.list_active_for_user(user_id)

    # --- Password management --------------------------------------------------------
    async def change_password(self, user: User, *, current_password: str, new_password: str) -> None:
        """Change a user's own password, verifying current password and strength policy."""
        if not verify_password(current_password, user.password_hash):
            raise UnauthorizedException("Current password is incorrect.")
        await self._set_password(user, new_password, require_change_on_next_login=False)
        if user.status == UserStatus.PASSWORD_CHANGE_REQUIRED:
            user.status = UserStatus.ACTIVE
            await self.user_repository.update(user)
        await self.force_logout_user(user.id, reason="password_changed")

    async def admin_reset_password(self, user: User, new_password: str) -> None:
        """Admin-driven password reset."""
        await self._set_password(user, new_password, require_change_on_next_login=True)
        user.status = UserStatus.PASSWORD_CHANGE_REQUIRED
        await self.user_repository.update(user)
        await self.force_logout_user(user.id, reason="password_reset")

    async def _set_password(
        self, user: User, new_password: str, *, require_change_on_next_login: bool = False
    ) -> None:
        """Validate strength + history, then hash and persist a new password for a user."""
        violations = validate_password_strength(new_password)
        if violations:
            raise ValidationException("The new password does not meet the password policy.", details=violations)

        recent_hashes = await self.password_history_repository.list_recent_for_user(
            user.id, limit=settings.PASSWORD_HISTORY_SIZE
        )
        if any(verify_password(new_password, entry.password_hash) for entry in recent_hashes):
            raise ValidationException(
                f"You cannot reuse any of your last {settings.PASSWORD_HISTORY_SIZE} passwords."
            )
        if verify_password(new_password, user.password_hash):
            raise ValidationException("The new password must be different from your current password.")

        new_hash = hash_password(new_password)
        await self.password_history_repository.record(user.id, user.password_hash)
        user.password_hash = new_hash
        user.password_changed_at = datetime.now(timezone.utc)
        user.must_change_password = require_change_on_next_login
        if require_change_on_next_login:
            user.status = UserStatus.PASSWORD_CHANGE_REQUIRED
        await self.user_repository.update(user)

    async def forgot_password(self, identifier: str) -> None:
        """Record a self-service password-reset request."""
        user = await self.user_repository.get_by_username_or_email(identifier)
        if user is None:
            return
        user.must_change_password = True
        user.status = UserStatus.PASSWORD_CHANGE_REQUIRED
        await self.user_repository.update(user)

    # --- Access-token verification (used by get_current_user dependency) ---
    async def verify_access_token(self, token: str) -> CurrentUser:
        """Decode and verify an access token, checking blacklist and fetching live effective permissions."""
        try:
            payload = decode_token(token, expected_type=TokenType.ACCESS)
        except InvalidTokenError as exc:
            raise UnauthorizedException("Invalid or expired access token.") from exc

        if await self.token_blacklist_repository.is_blacklisted(payload["jti"]):
            raise UnauthorizedException("This access token has been revoked.")

        user_id = uuid.UUID(payload["sub"])
        user = await self.user_repository.get_by_id(user_id)
        if user is None:
            raise UnauthorizedException("User account no longer exists.")
        if not user.can_login:
            raise ForbiddenException("This account is not active.")

        # Dynamically fetch effective permissions (backed by cache with instant invalidation)
        live_permissions = await self.get_user_effective_permissions(user_id)

        return CurrentUser(
            id=user.id,
            username=user.username,
            permissions=live_permissions,
            access_token_jti=payload["jti"],
            must_change_password=user.must_change_password,
        )
