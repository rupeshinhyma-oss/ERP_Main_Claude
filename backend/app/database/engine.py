"""
Database Engine.

Creates and owns the single, process-wide async SQLAlchemy engine and the
async session factory built on top of it. There should be exactly one
engine per process; creating a new engine per request (or per module) would
exhaust the database's connection limit and defeats connection pooling.

The engine is created lazily via :func:`get_engine` / :func:`get_sessionmaker`
so that importing this module never has side effects (important for
Alembic, testing, and for keeping import order irrelevant).
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import AsyncAdaptedQueuePool

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    """
    Return the process-wide async SQLAlchemy engine, creating it on first use.

    Pool sizing is externalized to :mod:`app.core.config` so operators can
    tune it per environment (e.g. smaller pools for staging, larger for
    production) without a code change.
    """
    global _engine
    if _engine is None:
        connect_args = {}
        if settings.DATABASE_DISABLE_STATEMENT_CACHE:
            # Required when connecting through a transaction-mode PgBouncer
            # (e.g. Supabase's default pooled connection on port 6543):
            # asyncpg's prepared-statement cache doesn't survive statements
            # being multiplexed across different backend connections, which
            # otherwise surfaces as "prepared statement ... does not exist"
            # errors under load. Session-mode poolers / direct connections
            # (e.g. Supabase's port 5432) don't need this.
            connect_args["statement_cache_size"] = 0

        _engine = create_async_engine(
            str(settings.DATABASE_URL),
            echo=settings.DATABASE_ECHO,
            poolclass=AsyncAdaptedQueuePool,
            pool_size=settings.DATABASE_POOL_SIZE,
            max_overflow=settings.DATABASE_MAX_OVERFLOW,
            pool_timeout=settings.DATABASE_POOL_TIMEOUT_SECONDS,
            pool_recycle=settings.DATABASE_POOL_RECYCLE_SECONDS,
            pool_pre_ping=True,  # transparently recovers from stale/dropped connections
            future=True,
            connect_args=connect_args,
        )
        logger.info("Database engine created.", extra={"pool_size": settings.DATABASE_POOL_SIZE})
    return _engine


def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Return the process-wide async session factory, creating it on first use."""
    global _sessionmaker
    if _sessionmaker is None:
        _sessionmaker = async_sessionmaker(
            bind=get_engine(),
            class_=AsyncSession,
            expire_on_commit=False,
            autoflush=False,
        )
    return _sessionmaker


async def dispose_engine() -> None:
    """
    Dispose of the engine and its connection pool.

    Must be called on application shutdown so that all pooled connections
    are closed cleanly instead of being dropped when the process exits.
    """
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
        logger.info("Database engine disposed.")
    _engine = None
    _sessionmaker = None
