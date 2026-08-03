"""
Queue Job ORM Model.

Owns the ``queue_jobs`` table. Every background job is a row in this table:
the worker selects pending rows, executes them, and writes the outcome back.

Design choices:
- UUID primary key (non-guessable, globally unique, consistent with the rest
  of the codebase).
- ``payload`` stored as JSON text so any future job type can pass arbitrary
  structured data without schema migrations for each new type.
- ``run_at`` lets callers schedule jobs in the future (just set run_at to
  a future UTC time; the worker will ignore it until then).
- No ``SoftDeleteMixin`` — completed/failed/cancelled jobs are kept
  permanently for auditability. Use the admin API or a future archival job
  to prune them.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum as SAEnum, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database.base import GUID, Base, TimestampMixin, UUIDPrimaryKeyMixin
from app.queue.constants import JobPriority, JobStatus

if TYPE_CHECKING:
    from app.users.models import User


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class QueueJob(Base, UUIDPrimaryKeyMixin, TimestampMixin):
    """A single background job stored in the database queue."""

    __tablename__ = "queue_jobs"

    # --- Job identity ----------------------------------------------------------
    job_name: Mapped[str] = mapped_column(
        String(150), nullable=False, index=True,
        doc="Human-readable name, e.g. 'send_welcome_email'. Matched to a handler in the registry.",
    )
    module: Mapped[str] = mapped_column(
        String(100), nullable=False, index=True,
        doc="Feature module that owns this job, e.g. 'notifications', 'reports'.",
    )

    # --- Payload ---------------------------------------------------------------
    payload: Mapped[str] = mapped_column(
        Text, nullable=False, default="{}",
        doc="JSON-encoded dict of arguments passed to the job handler.",
    )

    # --- Scheduling / priority -------------------------------------------------
    priority: Mapped[int] = mapped_column(
        Integer, nullable=False, default=JobPriority.NORMAL.value, index=True,
        doc="Higher value = higher priority. See JobPriority enum.",
    )
    run_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utcnow, index=True,
        doc="Earliest UTC time the worker may pick this job up.",
    )

    # --- Status ----------------------------------------------------------------
    status: Mapped[str] = mapped_column(
        SAEnum(JobStatus, name="job_status", native_enum=False, length=20),
        nullable=False, default=JobStatus.PENDING, index=True,
    )

    # --- Retry -----------------------------------------------------------------
    retry_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0,
        doc="Number of times this job has been attempted so far.",
    )
    max_retries: Mapped[int] = mapped_column(
        Integer, nullable=False, default=3,
        doc="Maximum number of attempts before the job is marked FAILED permanently.",
    )

    # --- Execution timestamps --------------------------------------------------
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # --- Error tracking --------------------------------------------------------
    error_message: Mapped[str | None] = mapped_column(
        Text, nullable=True,
        doc="Last error/traceback from a failed attempt.",
    )

    # --- Ownership -------------------------------------------------------------
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        GUID(), ForeignKey("users.id", ondelete="SET NULL"), nullable=True,
        doc="User who enqueued this job (null for system-generated jobs).",
    )
    creator: Mapped["User | None"] = relationship(foreign_keys=[created_by], lazy="noload")

    def __repr__(self) -> str:
        return f"<QueueJob job_name={self.job_name!r} status={self.status!r} priority={self.priority}>"

    @property
    def is_retriable(self) -> bool:
        """Return True if this job can be retried (has remaining attempts)."""
        return self.retry_count < self.max_retries

    @property
    def priority_label(self) -> str:
        """Return a human-readable priority label."""
        try:
            return JobPriority(self.priority).name
        except ValueError:
            return str(self.priority)
