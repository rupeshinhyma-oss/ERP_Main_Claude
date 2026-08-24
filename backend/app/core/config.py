"""
Application Configuration.

All runtime configuration is centralized here and sourced from environment
variables (with a local ``.env`` file supported for development). No module
in this codebase should read ``os.environ`` directly -- everything must flow
through the single :class:`Settings` instance exposed as ``settings``.

Why centralize configuration like this?
----------------------------------------
1. **Single source of truth** - every config value has exactly one
   definition, one type, one default, and one validation rule.
2. **Fail fast** - Pydantic validates types and required fields at process
   startup, not three requests into production.
3. **Testability** - tests can construct a ``Settings`` object directly with
   overrides instead of monkey-patching environment variables everywhere.
4. **Twelve-Factor compliance** - config lives in the environment, not in
   code, which is what allows the same build artifact to run unmodified in
   dev, staging, and production.
"""

from __future__ import annotations

from enum import Enum
from functools import lru_cache

from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict


class EnvironmentEnum(str, Enum):
    """Supported deployment environments."""

    LOCAL = "local"
    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"
    TEST = "test"


class Settings(BaseSettings):
    """
    Strongly-typed application settings, populated from environment
    variables and/or a ``.env`` file at the project root.

    Grouped by concern for readability. Every field has a sane local-dev
    default EXCEPT secrets and the database URL, which must be supplied
    explicitly so that production can never silently boot with a dev
    default.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # -------------------------------------------------------------------
    # Application metadata
    # -------------------------------------------------------------------
    APP_NAME: str = "ERP Backend"
    APP_VERSION: str = "0.1.0"
    ENVIRONMENT: EnvironmentEnum = EnvironmentEnum.LOCAL
    DEBUG: bool = False

    # -------------------------------------------------------------------
    # API
    # -------------------------------------------------------------------
    API_V1_PREFIX: str = "/api/v1"
    DOCS_URL: str | None = "/docs"
    REDOC_URL: str | None = "/redoc"
    OPENAPI_URL: str | None = "/openapi.json"

    # Absolute path to the built frontend (the React app's `dist/` folder).
    # Unset by default: local development runs the API and the Vite dev
    # server as two separate processes (see frontend/vite.config.ts's proxy).
    # Set this for a same-origin production deploy where this backend also
    # serves the built SPA -- see create_application()'s static mount.
    FRONTEND_DIST_DIR: str | None = None

    # -------------------------------------------------------------------
    # Server
    # -------------------------------------------------------------------
    HOST: str = "0.0.0.0"
    PORT: int = 8000

    # -------------------------------------------------------------------
    # CORS
    # -------------------------------------------------------------------
    # Stored as raw comma-separated strings from the environment (e.g.
    # "https://a.com,https://b.com" or "*"), and exposed as parsed lists
    # via the properties below. Pydantic Settings would otherwise attempt
    # to JSON-decode `list[str]` fields sourced from the environment,
    # which rejects plain comma-separated values -- so we keep the raw
    # field a `str` and do the splitting ourselves.
    CORS_ALLOWED_ORIGINS: str = "*"
    CORS_ALLOW_CREDENTIALS: bool = True
    CORS_ALLOWED_METHODS: str = "*"
    CORS_ALLOWED_HEADERS: str = "*"

    # -------------------------------------------------------------------
    # Database
    # -------------------------------------------------------------------
    DATABASE_URL: PostgresDsn = Field(
        default="postgresql+asyncpg://erp_user:erp_password@localhost:5432/erp_db",
        description="Async SQLAlchemy connection string, e.g. "
        "postgresql+asyncpg://user:pass@host:5432/dbname",
    )
    # Sized for ~100+ concurrent active users behind a small number of
    # Uvicorn/Gunicorn worker processes. Each worker gets its OWN pool of
    # this size (SQLAlchemy pools are per-process), so with e.g. 4 workers
    # the effective ceiling is roughly 4 * (POOL_SIZE + MAX_OVERFLOW) = 400
    # connections -- keep this in mind alongside PostgreSQL's own
    # `max_connections` (and put PgBouncer in front in production so the
    # database itself isn't holding hundreds of idle connections).
    DATABASE_POOL_SIZE: int = 50
    DATABASE_MAX_OVERFLOW: int = 50
    DATABASE_POOL_TIMEOUT_SECONDS: int = 30
    DATABASE_POOL_RECYCLE_SECONDS: int = 1800
    DATABASE_ECHO: bool = False
    DATABASE_CONNECT_RETRIES: int = 5
    DATABASE_CONNECT_RETRY_DELAY_SECONDS: float = 2.0
    DATABASE_DISABLE_STATEMENT_CACHE: bool = False

    # -------------------------------------------------------------------
    # Logging
    # -------------------------------------------------------------------
    LOG_LEVEL: str = "INFO"
    LOG_JSON: bool = True

    # -------------------------------------------------------------------
    # Timezone
    # -------------------------------------------------------------------
    # The application always stores and processes time in UTC internally.
    # This is not meant to be overridden per-environment; it is exposed as
    # a setting purely so it is documented and testable in one place.
    APP_TIMEZONE: str = "UTC"

    # -------------------------------------------------------------------
    # Future extension points (Redis / Celery-ready, disabled for Phase 1)
    # -------------------------------------------------------------------
    # Set CACHE_BACKEND=redis once running with more than one worker
    # process/instance -- "in_memory" is per-process, so with multiple
    # workers each one has its own disconnected cache, which silently
    # breaks any cache-based invalidation/consistency the app relies on.
    # No call-site code changes needed to flip this; see cache backend
    # wiring in app/core/cache.py (or equivalent).
    CACHE_BACKEND: str = "in_memory"  # switch to "redis" later, no code change needed at call sites
    REDIS_URL: str = "redis://localhost:6379/0"
    QUEUE_BACKEND: str = "in_process"  # switch to "celery" / "rabbitmq" later

    # -------------------------------------------------------------------
    # Built-in Memory Cache (Phase 5)
    # -------------------------------------------------------------------
    CACHE_MAX_SIZE: int = 10_000
    CACHE_DEFAULT_TTL_SECONDS: int | None = None
    CACHE_CLEANUP_INTERVAL_SECONDS: float = 60.0

    # -------------------------------------------------------------------
    # Soft-Delete Retention / Trash Auto-Purge
    # -------------------------------------------------------------------
    # Every user-facing delete across the system is a SOFT delete (sets
    # ``deleted_at``; see app.database.base.SoftDeleteMixin and
    # app.common.base_repository.BaseRepository.delete). A soft-deleted
    # record sits in Trash and can be restored at any time up until it is
    # permanently purged. RETENTION_DAYS controls how long that window is;
    # 365 * 4 = 1460 days ("keep for 4 years") is the default per company
    # policy. Restoring a record at any point resets nothing -- it simply
    # becomes a normal live record again with no ``deleted_at``/purge date,
    # exactly as if it had never been deleted, and stays until a user
    # deletes it again (soft-deleting it a second time starts a fresh
    # 4-year countdown from that new deletion).
    TRASH_RETENTION_DAYS: int = 1460  # 365 * 4
    # How often the background purge worker checks for records past their
    # retention window. Daily is frequent enough for a years-long
    # retention policy and cheap enough to not matter performance-wise.
    TRASH_PURGE_CHECK_INTERVAL_SECONDS: float = 86400.0  # 24 hours

    # -------------------------------------------------------------------
    # Authentication / JWT (Phase 2)
    # -------------------------------------------------------------------
    JWT_SECRET_KEY: str = Field(
        default="CHANGE-ME-IN-PRODUCTION-this-is-a-local-dev-only-secret",
        description="HMAC signing secret for access/refresh tokens. MUST be overridden via env "
        "in every non-local environment.",
    )
    JWT_ALGORITHM: str = "HS256"
    MEMBER_PASSWORD_ENCRYPTION_KEY: str = Field(
        default="CHANGE-ME-IN-PRODUCTION-this-is-a-local-dev-only-secret-2",
        description="Encryption key for the Teams 'Add Member' admin-recoverable password "
        "feature (app.members). MUST be overridden via env, and MUST differ from "
        "JWT_SECRET_KEY, in every non-local environment. Rotating this key makes every "
        "previously-encrypted member password unrecoverable.",
    )
    JWT_ISSUER: str = "erp-backend"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 720
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # -------------------------------------------------------------------
    # Password policy
    # -------------------------------------------------------------------
    PASSWORD_MIN_LENGTH: int = 10
    PASSWORD_REQUIRE_UPPERCASE: bool = True
    PASSWORD_REQUIRE_LOWERCASE: bool = True
    PASSWORD_REQUIRE_DIGIT: bool = True
    PASSWORD_REQUIRE_SPECIAL: bool = True
    PASSWORD_HISTORY_SIZE: int = 5
    PASSWORD_MAX_AGE_DAYS: int = 90

    # -------------------------------------------------------------------
    # Login security / account lockout / rate limiting
    # -------------------------------------------------------------------
    MAX_FAILED_LOGIN_ATTEMPTS: int = 5
    ACCOUNT_LOCK_MINUTES: int = 15
    LOGIN_RATE_LIMIT_MAX_ATTEMPTS: int = 10
    LOGIN_RATE_LIMIT_WINDOW_SECONDS: int = 300

    # -------------------------------------------------------------------
    # Cookie support (optional secure-cookie delivery of the refresh token)
    # -------------------------------------------------------------------
    AUTH_USE_SECURE_COOKIES: bool = False
    AUTH_REFRESH_COOKIE_NAME: str = "refresh_token"

    # -------------------------------------------------------------------
    # Bootstrap / seed data (used only by scripts/seed.py)
    # -------------------------------------------------------------------
    BOOTSTRAP_ADMIN_USERNAME: str = "admin"
    BOOTSTRAP_ADMIN_EMAIL: str = "admin@example.com"
    BOOTSTRAP_ADMIN_PASSWORD: str = "ChangeMe!12345"

    # -------------------------------------------------------------------
    # Pagination / search / sorting (Phase 2.5: shared list-endpoint framework)
    # -------------------------------------------------------------------
    DEFAULT_PAGE_SIZE: int = 20
    MAX_PAGE_SIZE: int = 10000
    DEFAULT_SORT_ORDER: str = "asc"

    # -------------------------------------------------------------------
    # SMTP / Automated Email Dispatch
    # -------------------------------------------------------------------
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_USER: str = "om1inhyma@gmail.com"
    SMTP_PASSWORD: str = "wmwdaqjhmqutizvr"
    SMTP_FROM_EMAIL: str = "om1inhyma@gmail.com"
    SMTP_FROM_NAME: str = "Yinglima Procurement Team"
    SMTP_USE_TLS: bool = True

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        """Parse CORS_ALLOWED_ORIGINS into a list, splitting on commas."""
        return [item.strip() for item in self.CORS_ALLOWED_ORIGINS.split(",") if item.strip()]

    @property
    def cors_allowed_methods_list(self) -> list[str]:
        """Parse CORS_ALLOWED_METHODS into a list, splitting on commas."""
        return [item.strip() for item in self.CORS_ALLOWED_METHODS.split(",") if item.strip()]

    @property
    def cors_allowed_headers_list(self) -> list[str]:
        """Parse CORS_ALLOWED_HEADERS into a list, splitting on commas."""
        return [item.strip() for item in self.CORS_ALLOWED_HEADERS.split(",") if item.strip()]

    @property
    def is_production(self) -> bool:
        """Return True when running in the production environment."""
        return self.ENVIRONMENT == EnvironmentEnum.PRODUCTION

    def validate_production_secrets(self) -> None:
        """
        Refuse to boot in production with the placeholder JWT secret.

        Called explicitly from the application lifespan (not from
        ``__init__``) so that unit tests / local tooling importing
        ``Settings`` never trip this check unexpectedly.
        """
        if self.is_production and "CHANGE-ME" in self.JWT_SECRET_KEY:
            raise RuntimeError(
                "JWT_SECRET_KEY is still set to its placeholder value in a production "
                "environment. Set a strong, random JWT_SECRET_KEY via the environment."
            )
        if self.is_production and "CHANGE-ME" in self.MEMBER_PASSWORD_ENCRYPTION_KEY:
            raise RuntimeError(
                "MEMBER_PASSWORD_ENCRYPTION_KEY is still set to its placeholder value in a "
                "production environment. Set a strong, random MEMBER_PASSWORD_ENCRYPTION_KEY "
                "via the environment."
            )

    @property
    def sync_database_url(self) -> str:
        """
        Return a synchronous (psycopg2) variant of DATABASE_URL.

        Alembic migrations run synchronously, while the application itself
        uses the async ``asyncpg`` driver. Rather than maintaining two
        separate URLs, we derive the sync URL from the single async source
        of truth.
        """
        return str(self.DATABASE_URL).replace("postgresql+asyncpg://", "postgresql+psycopg2://")


@lru_cache
def get_settings() -> Settings:
    """
    Return a cached, process-wide :class:`Settings` instance.

    ``lru_cache`` ensures the environment is parsed exactly once per
    process, and gives us a single dependency-injectable accessor
    (``Depends(get_settings)``) for use in FastAPI routes/services without
    re-reading the environment on every request.
    """
    return Settings()


# Module-level singleton for convenient direct import (`from app.core.config
# import settings`) in places where FastAPI's DI container is not in play
# (e.g. Alembic's env.py, startup scripts).
settings = get_settings()