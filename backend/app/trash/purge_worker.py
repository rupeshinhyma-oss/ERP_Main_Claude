"""
Trash Auto-Purge Worker.

A single asyncio task that wakes up once a day and permanently deletes
any soft-deleted record whose ``deleted_at`` is older than
``settings.TRASH_RETENTION_DAYS`` (4 years by default) -- i.e. it enforces
the company policy: "keep soft-deleted data for 4 years; if nobody
restores it in that time, permanently delete it from the system."

Lifecycle mirrors ``app.cache.cleanup.BackgroundCleanupWorker`` and
``app.queue.worker.BackgroundWorker`` for consistency with the rest of
the codebase:

    worker = TrashPurgeWorker()
    await worker.start()   # call from lifespan startup
    ...
    await worker.stop()    # call from lifespan shutdown

Started once in ``app.main.lifespan`` alongside the queue worker and the
cache cleanup worker, and stopped gracefully on shutdown.

WHY DAILY (not hourly, not on every request):
The retention window is measured in years, so there is no correctness
reason to check more often than once a day -- a record that crosses its
4-year cutoff at 2am and gets purged at the next daily run rather than
instantly makes no practical difference to anyone. Checking daily instead
of, say, every minute also means this never competes for meaningful
database load with actual user traffic.

WHY THIS DOESN'T NEED TO KNOW ABOUT INDIVIDUAL MODELS:
All purge logic (which models are soft-deletable, how to bulk-delete each
one) already lives in ``app.trash.service.TrashService.purge_expired`` --
this worker is intentionally a thin scheduling shell around that one
method, so adding a new soft-deletable model only ever means registering
it in ``TrashService.MODEL_MAP``; this file never needs to change.
"""

from __future__ import annotations

import asyncio

from app.core.config import settings
from app.core.logging import get_logger
from app.database.engine import get_sessionmaker
from app.trash.service import TrashService

logger = get_logger(__name__)


class TrashPurgeWorker:
    """Periodically purges soft-deleted records past the retention window."""

    def __init__(self, *, interval_seconds: float | None = None) -> None:
        """
        Set up the worker's check interval.

        Args:
            interval_seconds: How often to check for expired trash items.
                Defaults to ``settings.TRASH_PURGE_CHECK_INTERVAL_SECONDS``
                (24 hours) -- see the module docstring for why daily is
                the right cadence for a years-long retention window.
        """
        self._interval_seconds = (
            interval_seconds
            if interval_seconds is not None
            else settings.TRASH_PURGE_CHECK_INTERVAL_SECONDS
        )
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    @property
    def is_running(self) -> bool:
        """Return True if the purge loop is currently running."""
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """
        Launch the periodic purge loop as an asyncio Task.

        Safe to call multiple times; a no-op if already running.
        """
        if self.is_running:
            logger.warning("TrashPurgeWorker.start() called but worker is already running.")
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="trash-purge-worker")
        logger.info(
            "Trash auto-purge worker started.",
            extra={
                "interval_seconds": self._interval_seconds,
                "retention_days": settings.TRASH_RETENTION_DAYS,
            },
        )

    async def stop(self) -> None:
        """Signal the purge loop to stop and wait for the current iteration to finish."""
        if not self.is_running:
            return
        self._stop_event.set()
        assert self._task is not None
        await self._task
        logger.info("Trash auto-purge worker stopped.")

    async def _run(self) -> None:
        """Check for and purge expired trash items every ``interval_seconds`` until stopped."""
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._interval_seconds)
                # stop_event was set while waiting -- exit the loop.
                break
            except asyncio.TimeoutError:
                # Normal case: the interval elapsed without a stop signal.
                pass

            try:
                await self.run_once()
            except Exception:  # noqa: BLE001 -- a failed purge must never crash the worker loop
                logger.exception("Trash auto-purge run failed; will retry on the next interval.")

    async def run_once(self) -> dict[str, int]:
        """
        Run a single purge pass immediately and return ``{entity_type: rows_purged}``.

        Opens and owns its own database session (this worker runs
        outside any HTTP request, so there is no request-scoped session
        to reuse -- see ``app.queue.worker.BackgroundWorker`` for the
        same pattern), and commits explicitly since nothing else will.
        Mainly exposed as a public method for tests/admin use, same as
        ``BackgroundCleanupWorker.run_once``.
        """
        session_factory = get_sessionmaker()
        async with session_factory() as session:
            try:
                service = TrashService(session)
                purged_by_type = await service.purge_expired()
                await session.commit()
                if purged_by_type:
                    total = sum(purged_by_type.values())
                    logger.info(
                        "Trash auto-purge removed expired records past the retention window.",
                        extra={"total_purged": total, "by_entity_type": purged_by_type},
                    )
                return purged_by_type
            except Exception:
                await session.rollback()
                raise
