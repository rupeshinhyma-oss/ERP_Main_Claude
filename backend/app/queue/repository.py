"""
Queue Repository.

Only responsibility: translate method calls into SQL against the
``queue_jobs`` table. No business logic here — that belongs in
``QueueService``.

Inherits ``BaseRepository`` for the generic CRUD helpers (get_by_id,
create, update, delete, paginated_list), and adds queue-specific queries:
- Claiming the next pending job (atomic select-for-update-skip-locked).
- Fetching jobs due for retry.
- Bulk status queries (list by status, count by status).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import and_, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.base_repository import BaseRepository
from app.queue.constants import JobPriority, JobStatus
from app.queue.models import QueueJob


class QueueRepository(BaseRepository[QueueJob]):
    """Database access layer for queue_jobs."""

    # Columns the API can search/sort/filter on (used by BaseRepository.paginated_list).
    searchable_fields = ("job_name", "module", "error_message")
    sortable_fields = ("created_at", "updated_at", "run_at", "priority", "status", "retry_count")
    filterable_fields = ("status", "module", "job_name", "priority", "created_by")

    def __init__(self, session: AsyncSession) -> None:
        super().__init__(session, QueueJob)

    # ------------------------------------------------------------------
    # Worker-facing queries
    # ------------------------------------------------------------------

    async def claim_next_job(self) -> QueueJob | None:
        """
        Atomically claim the highest-priority pending job that is due now.

        Uses SELECT ... FOR UPDATE SKIP LOCKED so that multiple worker
        processes (or future horizontal scaling) never pick the same job,
        and a slow job in one worker does not block others from picking
        the next one.

        Returns the claimed job (already marked RUNNING in the DB) or None
        if there is nothing to do right now.
        """
        now = datetime.now(timezone.utc)

        stmt = (
            select(QueueJob)
            .where(
                and_(
                    QueueJob.status == JobStatus.PENDING,
                    QueueJob.run_at <= now,
                )
            )
            .order_by(QueueJob.priority.desc(), QueueJob.run_at.asc())
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        result = await self.session.execute(stmt)
        job = result.scalar_one_or_none()

        if job is None:
            return None

        # Mark it RUNNING immediately so another worker cannot pick it up.
        await self.session.execute(
            update(QueueJob)
            .where(QueueJob.id == job.id)
            .values(status=JobStatus.RUNNING, started_at=now)
        )
        await self.session.flush()
        await self.session.refresh(job)
        return job

    async def mark_completed(self, job_id: uuid.UUID) -> None:
        """Mark a job as COMPLETED with a completion timestamp."""
        await self.session.execute(
            update(QueueJob)
            .where(QueueJob.id == job_id)
            .values(status=JobStatus.COMPLETED, completed_at=datetime.now(timezone.utc))
        )
        await self.session.flush()

    async def mark_failed(self, job_id: uuid.UUID, *, error: str) -> None:
        """
        Mark a job as FAILED (permanently — all retries exhausted) with the
        last error message.
        """
        await self.session.execute(
            update(QueueJob)
            .where(QueueJob.id == job_id)
            .values(
                status=JobStatus.FAILED,
                error_message=error[:4000],  # guard against very long tracebacks
                completed_at=datetime.now(timezone.utc),
            )
        )
        await self.session.flush()

    async def mark_pending_for_retry(
        self,
        job_id: uuid.UUID,
        *,
        retry_count: int,
        run_at: datetime,
        error: str,
    ) -> None:
        """
        Reset a job back to PENDING so the worker will pick it up again
        after the retry delay, incrementing retry_count and recording the
        last error for debugging.
        """
        await self.session.execute(
            update(QueueJob)
            .where(QueueJob.id == job_id)
            .values(
                status=JobStatus.PENDING,
                retry_count=retry_count,
                run_at=run_at,
                error_message=error[:4000],
            )
        )
        await self.session.flush()

    # ------------------------------------------------------------------
    # API / admin queries
    # ------------------------------------------------------------------

    async def get_by_status(self, status: JobStatus, *, limit: int = 100) -> list[QueueJob]:
        """Return up to ``limit`` jobs matching the given status, newest first."""
        stmt = (
            select(QueueJob)
            .where(QueueJob.status == status)
            .order_by(QueueJob.created_at.desc())
            .limit(limit)
        )
        result = await self.session.execute(stmt)
        return list(result.scalars().all())

    async def count_by_status(self) -> dict[str, int]:
        """Return a mapping of status -> count for every status in the database."""
        stmt = select(QueueJob.status, func.count(QueueJob.id)).group_by(QueueJob.status)
        result = await self.session.execute(stmt)
        return {row[0]: row[1] for row in result.all()}

    async def cancel_job(self, job_id: uuid.UUID) -> bool:
        """
        Cancel a PENDING job. Returns True if the job was found and cancelled,
        False if the job was not in a cancellable state (already RUNNING,
        COMPLETED, FAILED, or CANCELLED).
        """
        result = await self.session.execute(
            update(QueueJob)
            .where(and_(QueueJob.id == job_id, QueueJob.status == JobStatus.PENDING))
            .values(status=JobStatus.CANCELLED)
            .returning(QueueJob.id)
        )
        await self.session.flush()
        return result.scalar_one_or_none() is not None

    async def reset_stuck_jobs(self, *, older_than_minutes: int = 30) -> int:
        """
        Reset RUNNING jobs that have been stuck for longer than
        ``older_than_minutes`` back to PENDING (e.g. after a worker crash).

        Returns the number of jobs reset.
        """
        from datetime import timedelta
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=older_than_minutes)
        result = await self.session.execute(
            update(QueueJob)
            .where(
                and_(
                    QueueJob.status == JobStatus.RUNNING,
                    QueueJob.started_at <= cutoff,
                )
            )
            .values(status=JobStatus.PENDING, started_at=None)
            .returning(QueueJob.id)
        )
        await self.session.flush()
        rows = result.fetchall()
        return len(rows)
