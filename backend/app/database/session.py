"""
Database Session Dependency.

Exposes :func:`get_db_session`, the single FastAPI dependency used by every
route/service in the codebase to obtain an ``AsyncSession``. Centralizing
this here means the commit/rollback/close policy is defined exactly once.

Usage::

    @router.get("/items")
    async def list_items(db: AsyncSession = Depends(get_db_session)) -> ...:
        ...

Transaction policy
-------------------
- The session is committed automatically if the request handler completes
  without raising.
- The session is rolled back automatically if any exception propagates out
  of the request handler, so a failed request never leaves a half-applied
  write in the database.
- The session is always closed/returned to the pool in the ``finally``
  block, regardless of outcome.
"""

import asyncio
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.database.engine import get_sessionmaker

logger = get_logger(__name__)


async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """
    Yield a transactional, per-request ``AsyncSession``.

    This is a FastAPI dependency (used via ``Depends(get_db_session)``); it
    is also usable as a plain async context manager anywhere outside of a
    request (e.g. background tasks) via ``async with get_sessionmaker()()``.
    """
    session_factory = get_sessionmaker()
    session = session_factory()
    try:
        yield session
        await session.commit()
    except BaseException as exc:
        try:
            await session.rollback()
        except Exception:
            pass
        if not isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, GeneratorExit)):
            logger.exception("Session rolled back due to an unhandled exception.")
        raise
    finally:
        try:
            await session.close()
        except Exception:
            pass