"""
Background Cleanup Worker.

A single asyncio task that wakes up on a fixed interval and sweeps expired
entries out of the in-memory cache. This exists because lazy expiration
alone (removing an entry only when something calls ``get()`` on it) can
leave stale, never-accessed entries sitting in memory indefinitely -- e.g.
a permission set cached for a user who never logs in again.

Lifecycle mirrors :class:`app.queue.worker.BackgroundWorker` for
consistency with the rest of the codebase:

    worker = BackgroundCleanupWorker(cache_backend)
    await worker.start()   # call from lifespan startup
    ...
    await worker.stop()    # call from lifespan shutdown

Started once in ``app.main.lifespan`` alongside the queue worker, and
stopped gracefully on shutdown.
"""

from __future__ import annotations

import asyncio

from app.cache.in_memory import InMemoryCacheBackend
from app.core.logging import get_logger

logger = get_logger(__name__)


class BackgroundCleanupWorker:
    """Periodically sweeps expired entries from an :class:`InMemoryCacheBackend`."""

    def __init__(self, cache: InMemoryCacheBackend, *, interval_seconds: float = 60.0) -> None:
        """
        Bind the worker to the cache instance it will clean and its sweep interval.

        Args:
            cache: The in-memory cache backend to sweep.
            interval_seconds: How often to run a sweep. Defaults to 60
                seconds -- frequent enough that expired entries don't
                linger long, infrequent enough to be negligible overhead.
        """
        self._cache = cache
        self._interval_seconds = interval_seconds
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()

    @property
    def is_running(self) -> bool:
        """Return True if the cleanup loop is currently running."""
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """
        Launch the periodic sweep loop as an asyncio Task.

        Safe to call multiple times; a no-op if already running.
        """
        if self.is_running:
            logger.warning("BackgroundCleanupWorker.start() called but worker is already running.")
            return
        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="cache-cleanup-worker")
        logger.info("Cache cleanup worker started.", extra={"interval_seconds": self._interval_seconds})

    async def stop(self) -> None:
        """Signal the sweep loop to stop and wait for the current iteration to finish."""
        if not self.is_running:
            return
        self._stop_event.set()
        assert self._task is not None
        await self._task
        logger.info("Cache cleanup worker stopped.")

    async def _run(self) -> None:
        """Sweep expired entries every ``interval_seconds`` until stopped."""
        while not self._stop_event.is_set():
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=self._interval_seconds)
                # stop_event was set while waiting -- exit the loop.
                break
            except asyncio.TimeoutError:
                # Normal case: the interval elapsed without a stop signal.
                pass

            try:
                removed = await self._cache.sweep_expired()
                if removed:
                    logger.info("Cache cleanup sweep removed expired entries.", extra={"removed": removed})
            except Exception:  # noqa: BLE001 -- a sweep failure must never crash the worker loop
                logger.exception("Cache cleanup sweep failed; will retry on the next interval.")

    async def run_once(self) -> int:
        """Run a single sweep immediately and return the number of entries removed. Mainly for tests/admin use."""
        return await self._cache.sweep_expired()
