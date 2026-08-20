"""
Queue API Routes.

Provides admin endpoints for managing background jobs:
  POST   /queue/jobs            — Enqueue a new job.
  GET    /queue/jobs            — List jobs (filterable by status, module).
  GET    /queue/jobs/{id}       — Get a single job.
  POST   /queue/jobs/{id}/cancel  — Cancel a pending job.
  POST   /queue/jobs/{id}/retry   — Re-queue a failed/cancelled job.
  GET    /queue/stats           — Status counts (pending/running/completed/…).
  GET    /queue/registered-jobs — List all job names that have a handler.
  GET    /queue/worker/status   — Worker heartbeat / running status.

All endpoints require the ``settings.manage`` permission, keeping queue
management restricted to system administrators.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.core.responses import build_success_response
from app.queue.constants import JobStatus
from app.queue.dependencies import get_background_worker, get_queue_service
from app.queue.models import QueueJob
from app.queue.registry import list_registered_jobs
from app.queue.schemas import (
    JobCreate,
    JobRead,
    JobRetry,
    JobSummary,
    QueueStats,
    RegisteredJobsResponse,
)
from app.queue.service import QueueService
from app.queue.worker import BackgroundWorker

router = APIRouter(prefix="/queue", tags=["Queue"])


def _job_read(job: QueueJob) -> dict:
    """Serialise a QueueJob ORM instance to a dict matching JobRead."""
    return JobRead.model_validate(job).model_dump(mode="json")


def _job_summary(job: QueueJob) -> dict:
    """Serialise a QueueJob ORM instance to a dict matching JobSummary."""
    return JobSummary.model_validate(job).model_dump(mode="json")


# ---------------------------------------------------------------------------
# Enqueue a job
# ---------------------------------------------------------------------------


@router.post("/jobs", status_code=status.HTTP_201_CREATED, summary="Enqueue a new background job")
async def create_job(
    payload: JobCreate,
    request: Request,
    service: QueueService = Depends(get_queue_service),
    current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Create and enqueue a new background job.

    The job will be picked up by the worker and executed according to its
    priority and ``run_at`` time. If no handler is registered for the given
    ``job_name``, the job will immediately fail when the worker tries to run it.
    """
    job = await service.create_job_from_schema(payload, created_by=current_user.id)
    return build_success_response(
        data=_job_read(job),
        request_id=request.state.request_id,
        message="Job enqueued successfully.",
    )


# ---------------------------------------------------------------------------
# List jobs
# ---------------------------------------------------------------------------


@router.get("/jobs", summary="List background jobs")
async def list_jobs(
    request: Request,
    job_status: JobStatus | None = Query(default=None, alias="status", description="Filter by job status."),
    module: str | None = Query(default=None, description="Filter by module name."),
    limit: int = Query(default=50, ge=1, le=200, description="Maximum number of results."),
    offset: int = Query(default=0, ge=0, description="Number of results to skip."),
    service: QueueService = Depends(get_queue_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    List background jobs with optional filtering by status and/or module.

    Results are ordered newest-first. Use ``limit``/``offset`` for pagination.
    """
    jobs, total = await service.list_jobs(
        status=job_status,
        module=module,
        limit=limit,
        offset=offset,
    )
    return build_success_response(
        data={
            "items": [_job_summary(j) for j in jobs],
            "total": total,
            "limit": limit,
            "offset": offset,
        },
        request_id=request.state.request_id,
    )


# ---------------------------------------------------------------------------
# Get a single job
# ---------------------------------------------------------------------------


@router.get("/jobs/{job_id}", summary="Get a background job by ID")
async def get_job(
    job_id: uuid.UUID,
    request: Request,
    service: QueueService = Depends(get_queue_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Fetch the full details of a single background job."""
    job = await service.get_job_or_raise(job_id)
    return build_success_response(data=_job_read(job), request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Cancel a job
# ---------------------------------------------------------------------------


@router.post("/jobs/{job_id}/cancel", summary="Cancel a pending job")
async def cancel_job(
    job_id: uuid.UUID,
    request: Request,
    service: QueueService = Depends(get_queue_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Cancel a PENDING job so it will never be executed.

    Raises 400 if the job is in any other status (RUNNING, COMPLETED, FAILED, CANCELLED).
    """
    job = await service.cancel_job(job_id)
    return build_success_response(
        data=_job_read(job),
        request_id=request.state.request_id,
        message="Job cancelled successfully.",
    )


# ---------------------------------------------------------------------------
# Retry a job
# ---------------------------------------------------------------------------


@router.post("/jobs/{job_id}/retry", summary="Re-queue a failed or cancelled job")
async def retry_job(
    job_id: uuid.UUID,
    payload: JobRetry,
    request: Request,
    service: QueueService = Depends(get_queue_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Re-queue a FAILED or CANCELLED job.

    The job's ``retry_count`` is reset to 0, giving it a fresh budget of
    ``max_retries`` attempts. Optionally provide ``run_at`` to schedule the
    retry for a future time.

    Raises 400 if the job is PENDING, RUNNING, or COMPLETED.
    """
    job = await service.retry_job(job_id, run_at=payload.run_at)
    return build_success_response(
        data=_job_read(job),
        request_id=request.state.request_id,
        message="Job re-queued successfully.",
    )


# ---------------------------------------------------------------------------
# Queue stats
# ---------------------------------------------------------------------------


@router.get("/stats", summary="Queue statistics by status")
async def queue_stats(
    request: Request,
    service: QueueService = Depends(get_queue_service),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return job counts grouped by status (PENDING, RUNNING, COMPLETED, FAILED, CANCELLED)."""
    counts = await service.get_queue_stats()
    stats = QueueStats.from_counts(counts)
    return build_success_response(
        data=stats.model_dump(),
        request_id=request.state.request_id,
    )


# ---------------------------------------------------------------------------
# Registered job handlers
# ---------------------------------------------------------------------------


@router.get("/registered-jobs", summary="List all registered job handler names")
async def list_registered(
    request: Request,
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Return the names of every job handler currently registered in the registry.

    Useful for discovering what job types are available to enqueue, and for
    debugging missing-handler failures.
    """
    jobs = list_registered_jobs()
    data = RegisteredJobsResponse(jobs=jobs, count=len(jobs)).model_dump()
    return build_success_response(data=data, request_id=request.state.request_id)


# ---------------------------------------------------------------------------
# Worker status / heartbeat
# ---------------------------------------------------------------------------


@router.get("/worker/status", summary="Background worker status")
async def worker_status(
    request: Request,
    worker: BackgroundWorker = Depends(get_background_worker),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Return the current state of the background worker task.

    Useful for health dashboards and verifying the worker started correctly.
    """
    return build_success_response(
        data={
            "running": worker.is_running,
            "description": (
                "Worker is polling the queue and executing jobs."
                if worker.is_running
                else "Worker is not running."
            ),
        },
        request_id=request.state.request_id,
    )
