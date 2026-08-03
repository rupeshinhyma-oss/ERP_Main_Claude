"""
Background Worker.

A single asyncio task that continuously polls the ``queue_jobs`` table,
picks up the next pending job, executes the registered handler, and writes
the outcome back. Everything runs inside the same process as the web server.

Design:
- Started once in :func:`app.main.lifespan` and stopped on shutdown.
- One worker per process. If horizontal scaling is needed later, each
  process runs its own worker; the SELECT FOR UPDATE SKIP LOCKED in
  ``QueueRepository.claim_next_job`` prevents double-processing.
- Uses exponential backoff on the polling interval when the queue is empty,
  so an idle system does not hammer the database.
- Graceful shutdown: the worker drains the currently-executing job before
  stopping, so a SIGTERM does not leave jobs in RUNNING state forever.

Job execution:
1. Claim the next PENDING job (atomic; marks it RUNNING).
2. Decode its payload and look up the registered handler.
3. Execute the handler.
4. On success: mark COMPLETED.
5. On failure: delegate to ``QueueService.mark_job_failed_or_retry`` which
   either schedules a retry with backoff or marks the job permanently FAILED.
"""

from __future__ import annotations

import asyncio
import json
import traceback
from datetime import datetime, timezone

from app.core.logging import get_logger
from app.database.engine import get_sessionmaker
from app.queue.registry import get_handler
from app.queue.service import QueueService

logger = get_logger(__name__)

# How long (seconds) to sleep between polls when the queue is empty.
_IDLE_POLL_INTERVAL: float = 5.0

# How long (seconds) to sleep between polls when jobs are actively being processed.
# Kept short so throughput is high.
_ACTIVE_POLL_INTERVAL: float = 0.5

# Maximum idle interval — doubles on each empty poll, capped here.
_MAX_IDLE_POLL_INTERVAL: float = 30.0

# How often (seconds) the worker checks for and resets stuck jobs.
_STUCK_JOB_CHECK_INTERVAL: float = 300.0  # 5 minutes


class BackgroundWorker:
    """
    Polls the database queue and executes pending jobs.

    Lifecycle::

        worker = BackgroundWorker()
        await worker.start()   # call from lifespan startup
        ...
        await worker.stop()    # call from lifespan shutdown
    """

    def __init__(self) -> None:
        """Initialise the worker (does not start the poll loop)."""
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._last_stuck_check: float = 0.0

    @property
    def is_running(self) -> bool:
        """Return True if the worker task is currently running."""
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """
        Launch the background poll loop as an asyncio Task.

        Called once from ``app.main.lifespan`` at application startup. Safe
        to call multiple times (a no-op if already running).
        """
        if self.is_running:
            logger.warning("BackgroundWorker.start() called but worker is already running.")
            return

        self._stop_event.clear()
        self._task = asyncio.create_task(self._run(), name="queue-worker")
        self._task.add_done_callback(self._on_task_done)
        logger.info("Background queue worker started.")

    async def stop(self) -> None:
        """
        Signal the poll loop to stop and wait for the current job (if any) to finish.

        Called from ``app.main.lifespan`` at application shutdown. Waits up
        to 30 seconds for a graceful stop before cancelling the task.
        """
        if not self.is_running:
            return

        logger.info("Stopping background queue worker (graceful)...")
        self._stop_event.set()

        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=30.0)
            except asyncio.TimeoutError:
                logger.warning("Worker did not stop within 30 s; cancelling task.")
                self._task.cancel()
            except asyncio.CancelledError:
                pass

        logger.info("Background queue worker stopped.")

    def _on_task_done(self, task: asyncio.Task) -> None:
        """Log unexpected task completion (e.g. an unhandled exception in _run)."""
        exc = task.exception() if not task.cancelled() else None
        if exc is not None:
            logger.exception(
                "Queue worker task exited with an unexpected exception.",
                exc_info=exc,
            )

    # ------------------------------------------------------------------
    # Internal poll loop
    # ------------------------------------------------------------------

    async def _run(self) -> None:
        """Main poll loop: claim and execute jobs until stop() is called."""
        poll_interval = _IDLE_POLL_INTERVAL

        while not self._stop_event.is_set():
            # Periodic stuck-job recovery.
            await self._maybe_recover_stuck_jobs()

            job_was_processed = await self._process_one_job()

            if job_was_processed:
                # There may be more work; poll quickly.
                poll_interval = _ACTIVE_POLL_INTERVAL
            else:
                # Queue was empty; back off to reduce DB load.
                poll_interval = min(poll_interval * 2, _MAX_IDLE_POLL_INTERVAL)

            # Wait until the next poll OR until stop() signals us.
            try:
                await asyncio.wait_for(
                    asyncio.shield(self._stop_event.wait()),
                    timeout=poll_interval,
                )
                # stop_event fired — break out of the loop.
                break
            except asyncio.TimeoutError:
                # Normal: timeout expired, loop continues.
                pass

    async def _process_one_job(self) -> bool:
        """
        Claim and execute a single pending job.

        Returns True if a job was claimed and processed (regardless of
        success or failure), False if the queue was empty.
        """
        session_factory = get_sessionmaker()

        async with session_factory() as session:
            service = QueueService(session)

            try:
                job = await service.claim_next_job()
            except Exception:
                logger.exception("Error while claiming next job from queue.")
                return False

            if job is None:
                return False  # queue is empty

            job_id_str = str(job.id)
            logger.info(
                "Executing job.",
                extra={"job_id": job_id_str, "job_name": job.job_name, "module": job.module},
            )

            # Look up the registered handler.
            handler = get_handler(job.job_name)
            if handler is None:
                error = (
                    f"No handler registered for job_name={job.job_name!r}. "
                    "Register a handler with @register('{job.job_name}') in the relevant module."
                )
                logger.error(error, extra={"job_id": job_id_str})
                try:
                    await service.mark_job_failed_or_retry(job, error=error)
                    await session.commit()
                except Exception:
                    logger.exception("Error marking job as failed.", extra={"job_id": job_id_str})
                    await session.rollback()
                return True

            # Decode the payload.
            try:
                payload: dict = json.loads(job.payload or "{}")
            except json.JSONDecodeError as exc:
                error = f"Payload is not valid JSON: {exc}"
                logger.error(error, extra={"job_id": job_id_str})
                try:
                    await service.mark_job_failed_or_retry(job, error=error)
                    await session.commit()
                except Exception:
                    await session.rollback()
                return True

            # Execute the handler.
            try:
                await handler(payload)
                await service.mark_job_completed(job)
                await session.commit()
                logger.info(
                    "Job completed successfully.",
                    extra={"job_id": job_id_str, "job_name": job.job_name},
                )
            except Exception:
                tb = traceback.format_exc()
                logger.exception(
                    "Job handler raised an exception.",
                    extra={"job_id": job_id_str, "job_name": job.job_name},
                )
                try:
                    await service.mark_job_failed_or_retry(job, error=tb)
                    await session.commit()
                except Exception:
                    logger.exception("Error updating job status after failure.", extra={"job_id": job_id_str})
                    await session.rollback()

        return True

    async def _maybe_recover_stuck_jobs(self) -> None:
        """Run stuck-job recovery if enough time has passed since the last check."""
        import time

        now = time.monotonic()
        if now - self._last_stuck_check < _STUCK_JOB_CHECK_INTERVAL:
            return

        self._last_stuck_check = now
        session_factory = get_sessionmaker()

        async with session_factory() as session:
            service = QueueService(session)
            try:
                count = await service.recover_stuck_jobs(older_than_minutes=30)
                await session.commit()
                if count > 0:
                    logger.info("Stuck job recovery ran.", extra={"recovered": count})
            except Exception:
                logger.exception("Error during stuck-job recovery.")
                await session.rollback()


# Process-wide singleton — one worker per process.
_worker: BackgroundWorker | None = None


def get_worker() -> BackgroundWorker:
    """Return (creating if necessary) the process-wide worker singleton."""
    global _worker
    if _worker is None:
        _worker = BackgroundWorker()
    return _worker
