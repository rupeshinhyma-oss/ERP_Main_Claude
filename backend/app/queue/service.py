"""
Queue Service.

All business logic for background job management lives here. The service
layer is the only layer that coordinates repositories, applies business
rules, and decides what the worker does.

Rules:
- Only PENDING jobs can be cancelled.
- Only FAILED or CANCELLED jobs can be retried.
- Job payload is stored as a JSON string; the service handles serialization.
- Retry delay uses exponential backoff: 2^attempt * base_delay seconds.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.exceptions import BadRequestException, NotFoundException
from app.core.logging import get_logger
from app.queue.constants import JobPriority, JobStatus
from app.queue.models import QueueJob
from app.queue.repository import QueueRepository
from app.queue.schemas import JobCreate

logger = get_logger(__name__)

# Base delay (seconds) for exponential backoff on retries.
RETRY_BASE_DELAY_SECONDS = 30


class QueueService:
    """Orchestrates all background job lifecycle operations."""

    not_found_message = "Job not found."

    def __init__(self, session: AsyncSession) -> None:
        """Bind the service to a database session."""
        self.session = session
        self.repository = QueueRepository(session)

    # ------------------------------------------------------------------
    # Job creation
    # ------------------------------------------------------------------

    async def create_job(
        self,
        *,
        job_name: str,
        module: str,
        payload: dict[str, Any] | None = None,
        priority: JobPriority = JobPriority.NORMAL,
        run_at: datetime | None = None,
        max_retries: int = 3,
        created_by: uuid.UUID | None = None,
    ) -> QueueJob:
        """
        Enqueue a new background job.

        Args:
            job_name: The registered handler name to execute.
            module: The owning feature module (for grouping/filtering).
            payload: Arbitrary key-value arguments passed to the handler.
            priority: Execution priority (HIGH > NORMAL > LOW).
            run_at: Earliest execution time; defaults to now (immediate).
            max_retries: Maximum execution attempts before permanent failure.
            created_by: UUID of the user who triggered this job (None = system).

        Returns:
            The created :class:`QueueJob` instance.
        """
        now = datetime.now(timezone.utc)
        job = await self.repository.create(
            job_name=job_name,
            module=module,
            payload=json.dumps(payload or {}),
            priority=priority.value,
            run_at=run_at or now,
            max_retries=max_retries,
            status=JobStatus.PENDING,
            retry_count=0,
            created_by=created_by,
        )
        logger.info(
            "Job enqueued.",
            extra={
                "job_id": str(job.id),
                "job_name": job_name,
                "module": module,
                "priority": priority.name,
                "run_at": (run_at or now).isoformat(),
            },
        )
        return job

    async def create_job_from_schema(
        self,
        schema: JobCreate,
        *,
        created_by: uuid.UUID | None = None,
    ) -> QueueJob:
        """Convenience wrapper: create a job from a validated API request schema."""
        return await self.create_job(
            job_name=schema.job_name,
            module=schema.module,
            payload=schema.payload,
            priority=schema.priority,
            run_at=schema.run_at,
            max_retries=schema.max_retries,
            created_by=created_by,
        )

    # ------------------------------------------------------------------
    # Job reads
    # ------------------------------------------------------------------

    async def get_job_or_raise(self, job_id: uuid.UUID) -> QueueJob:
        """Fetch a job by ID or raise :class:`NotFoundException`."""
        job = await self.repository.get_by_id(job_id)
        if job is None:
            raise NotFoundException(self.not_found_message)
        return job

    async def list_jobs(
        self,
        *,
        status: JobStatus | None = None,
        module: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[QueueJob], int]:
        """
        List jobs with optional status/module filtering.

        Returns:
            ``(items, total_count)`` for the given filters.
        """
        filters: dict[str, Any] = {}
        if status is not None:
            filters["status"] = status
        if module is not None:
            filters["module"] = module

        items = await self.repository.list(
            offset=offset,
            limit=limit,
            filters=filters or None,
            order_by=QueueJob.created_at.desc(),
        )
        total = await self.repository.count(filters=filters or None)
        return items, total

    async def get_queue_stats(self) -> dict[str, int]:
        """Return a count of jobs grouped by status."""
        return await self.repository.count_by_status()

    # ------------------------------------------------------------------
    # Job management (cancel / retry)
    # ------------------------------------------------------------------

    async def cancel_job(self, job_id: uuid.UUID) -> QueueJob:
        """
        Cancel a pending job.

        Only PENDING jobs can be cancelled. RUNNING, COMPLETED, FAILED, and
        CANCELLED jobs all raise :class:`BadRequestException`.

        Returns:
            The updated :class:`QueueJob`.
        """
        job = await self.get_job_or_raise(job_id)

        if job.status != JobStatus.PENDING:
            raise BadRequestException(
                f"Cannot cancel a job in status {job.status!r}. "
                "Only PENDING jobs can be cancelled."
            )

        cancelled = await self.repository.cancel_job(job_id)
        if not cancelled:
            # Race condition: another request changed state between our read and write.
            raise BadRequestException("Job could not be cancelled — it may have already started running.")

        await self.session.refresh(job)
        logger.info("Job cancelled.", extra={"job_id": str(job_id)})
        return job

    async def retry_job(
        self,
        job_id: uuid.UUID,
        *,
        run_at: datetime | None = None,
    ) -> QueueJob:
        """
        Re-queue a FAILED or CANCELLED job.

        Resets retry_count to 0 so the retried job gets its full max_retries
        budget again. This is an explicit admin action, not the automatic
        retry path.

        Args:
            job_id: The job to retry.
            run_at: Optional future time to delay the retry. Defaults to now.

        Returns:
            The updated :class:`QueueJob`.
        """
        job = await self.get_job_or_raise(job_id)

        if job.status not in (JobStatus.FAILED, JobStatus.CANCELLED):
            raise BadRequestException(
                f"Cannot retry a job in status {job.status!r}. "
                "Only FAILED or CANCELLED jobs can be retried."
            )

        now = datetime.now(timezone.utc)
        await self.repository.mark_pending_for_retry(
            job_id,
            retry_count=0,  # fresh budget
            run_at=run_at or now,
            error=job.error_message or "",
        )
        # Also clear the completed_at so it is not confusing in the UI.
        await self.repository.update(job, completed_at=None, started_at=None)

        await self.session.refresh(job)
        logger.info("Job re-queued by admin.", extra={"job_id": str(job_id)})
        return job

    # ------------------------------------------------------------------
    # Worker-facing methods (called from worker.py, not from routes)
    # ------------------------------------------------------------------

    async def claim_next_job(self) -> QueueJob | None:
        """Claim the next runnable job atomically. Returns None if queue is empty."""
        return await self.repository.claim_next_job()

    async def mark_job_completed(self, job: QueueJob) -> None:
        """Mark a job as COMPLETED after successful execution."""
        await self.repository.mark_completed(job.id)
        logger.info(
            "Job completed.",
            extra={"job_id": str(job.id), "job_name": job.job_name},
        )

    async def mark_job_failed_or_retry(self, job: QueueJob, *, error: str) -> None:
        """
        After a job execution failure, either schedule a retry or mark it permanently FAILED.

        Retry delay uses exponential backoff:
            delay = RETRY_BASE_DELAY_SECONDS * (2 ** retry_count)

        Example delays (base=30s): 30s, 60s, 120s, 240s, ...
        """
        next_retry = job.retry_count + 1

        if next_retry < job.max_retries:
            # Schedule a retry with exponential backoff.
            delay_seconds = RETRY_BASE_DELAY_SECONDS * (2 ** job.retry_count)
            run_at = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)
            await self.repository.mark_pending_for_retry(
                job.id,
                retry_count=next_retry,
                run_at=run_at,
                error=error,
            )
            logger.warning(
                "Job failed; scheduled for retry.",
                extra={
                    "job_id": str(job.id),
                    "job_name": job.job_name,
                    "retry_count": next_retry,
                    "max_retries": job.max_retries,
                    "retry_at": run_at.isoformat(),
                    "error": error[:500],
                },
            )
        else:
            # All retries exhausted — permanently fail the job.
            await self.repository.mark_failed(job.id, error=error)
            logger.error(
                "Job permanently failed — all retries exhausted.",
                extra={
                    "job_id": str(job.id),
                    "job_name": job.job_name,
                    "retry_count": next_retry,
                    "max_retries": job.max_retries,
                    "error": error[:500],
                },
            )

    async def recover_stuck_jobs(self, *, older_than_minutes: int = 30) -> int:
        """
        Reset RUNNING jobs that have been stuck for too long back to PENDING.

        This handles the case where a worker process crashed mid-execution,
        leaving a job permanently stuck in RUNNING status. Called once at
        worker startup and periodically thereafter.

        Returns:
            Number of jobs reset.
        """
        count = await self.repository.reset_stuck_jobs(older_than_minutes=older_than_minutes)
        if count > 0:
            logger.warning(
                "Recovered stuck jobs.",
                extra={"count": count, "older_than_minutes": older_than_minutes},
            )
        return count
