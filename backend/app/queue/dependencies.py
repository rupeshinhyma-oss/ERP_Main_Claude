"""
Queue Dependencies.

FastAPI dependency-injection wiring for the queue module. Routes depend on
``get_queue_service`` rather than constructing ``QueueService`` directly,
keeping the request-scoped session lifecycle in one place.
"""

from __future__ import annotations

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database.session import get_db_session
from app.queue.service import QueueService
from app.queue.worker import BackgroundWorker, get_worker


def get_queue_service(db: AsyncSession = Depends(get_db_session)) -> QueueService:
    """Build a request-scoped :class:`QueueService` wired to the current session."""
    return QueueService(db)


def get_background_worker() -> BackgroundWorker:
    """Return the process-wide :class:`BackgroundWorker` singleton."""
    return get_worker()
