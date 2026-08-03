"""
Queue Constants.

JobStatus and JobPriority enums used by the ORM model, schemas, and
service layer. Defined here so they are importable from a single location
without pulling in the full ORM or SQLAlchemy dependencies.
"""

from __future__ import annotations

from enum import Enum


class JobStatus(str, Enum):
    """Lifecycle states a queue job moves through."""

    PENDING = "PENDING"       # Waiting to be picked up by the worker.
    RUNNING = "RUNNING"       # Currently being executed.
    COMPLETED = "COMPLETED"   # Finished successfully.
    FAILED = "FAILED"         # Exhausted all retries; permanently failed.
    CANCELLED = "CANCELLED"   # Manually cancelled before it could run.


class JobPriority(int, Enum):
    """
    Numeric priority for a job. Higher number = higher priority.

    The worker orders the pending queue by priority DESC then run_at ASC,
    so HIGH jobs always run before NORMAL, which always run before LOW.
    """

    LOW = 1
    NORMAL = 5
    HIGH = 10
