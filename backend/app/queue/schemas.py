"""
Queue Job Schemas.

Pydantic request/response models for the queue API. All external-facing
shapes are defined here. ORM models never cross the API boundary directly.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.queue.constants import JobPriority, JobStatus


# ---------------------------------------------------------------------------
# Request schemas
# ---------------------------------------------------------------------------


class JobCreate(BaseModel):
    """Payload for creating a new background job."""

    job_name: str = Field(
        ...,
        min_length=1,
        max_length=150,
        description="Handler name registered in the job registry, e.g. 'send_welcome_email'.",
    )
    module: str = Field(
        ...,
        min_length=1,
        max_length=100,
        description="Feature module that owns this job, e.g. 'notifications', 'reports'.",
    )
    payload: dict[str, Any] = Field(
        default_factory=dict,
        description="Arbitrary JSON-serialisable arguments passed to the job handler.",
    )
    priority: JobPriority = Field(
        default=JobPriority.NORMAL,
        description="Job priority. Higher priority jobs run first.",
    )
    run_at: datetime | None = Field(
        default=None,
        description="Optional UTC datetime to delay execution until. Defaults to now.",
    )
    max_retries: int = Field(
        default=3,
        ge=0,
        le=10,
        description="Maximum number of attempts before the job is permanently failed.",
    )


class JobRetry(BaseModel):
    """Payload for manually re-queuing a failed/cancelled job."""

    run_at: datetime | None = Field(
        default=None,
        description="Optional UTC time to schedule the retry. Defaults to now.",
    )


# ---------------------------------------------------------------------------
# Response schemas
# ---------------------------------------------------------------------------


class JobRead(BaseModel):
    """Full representation of a queue job returned by API endpoints."""

    id: uuid.UUID
    job_name: str
    module: str
    payload: str  # raw JSON string stored in DB; clients parse as needed
    priority: int
    priority_label: str
    status: JobStatus
    retry_count: int
    max_retries: int
    run_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    error_message: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class JobSummary(BaseModel):
    """Lightweight representation used in list responses."""

    id: uuid.UUID
    job_name: str
    module: str
    priority: int
    priority_label: str
    status: JobStatus
    retry_count: int
    max_retries: int
    run_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class QueueStats(BaseModel):
    """Status counts returned by the queue stats endpoint."""

    pending: int = 0
    running: int = 0
    completed: int = 0
    failed: int = 0
    cancelled: int = 0
    total: int = 0

    @classmethod
    def from_counts(cls, counts: dict[str, int]) -> "QueueStats":
        """Build from the dict returned by ``QueueRepository.count_by_status``."""
        pending = counts.get(JobStatus.PENDING, 0)
        running = counts.get(JobStatus.RUNNING, 0)
        completed = counts.get(JobStatus.COMPLETED, 0)
        failed = counts.get(JobStatus.FAILED, 0)
        cancelled = counts.get(JobStatus.CANCELLED, 0)
        return cls(
            pending=pending,
            running=running,
            completed=completed,
            failed=failed,
            cancelled=cancelled,
            total=pending + running + completed + failed + cancelled,
        )


class RegisteredJobsResponse(BaseModel):
    """List of job names that have a handler registered."""

    jobs: list[str]
    count: int
