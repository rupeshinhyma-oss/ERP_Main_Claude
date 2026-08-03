"""
Phase 4 Queue Tests.

Basic unit-level tests for the queue service, worker, and registry.
These tests use in-memory / mock objects so they do not require a running
database or PostgreSQL instance.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.queue.constants import JobPriority, JobStatus
from app.queue.registry import _registry, get_handler, list_registered_jobs, register
from app.queue.schemas import JobCreate, QueueStats


# ---------------------------------------------------------------------------
# Registry tests
# ---------------------------------------------------------------------------


class TestRegistry:
    """Tests for the job handler registry."""

    def setup_method(self):
        """Clear the registry before each test."""
        _registry.clear()

    def teardown_method(self):
        """Clear the registry after each test."""
        _registry.clear()

    def test_register_and_get_handler(self):
        """A registered handler should be retrievable by job_name."""

        @register("test_job")
        async def my_handler(payload: dict) -> None:
            pass

        handler = get_handler("test_job")
        assert handler is my_handler

    def test_get_handler_missing_returns_none(self):
        """Getting an unregistered job_name should return None."""
        assert get_handler("nonexistent_job") is None

    def test_register_duplicate_raises(self):
        """Registering two handlers for the same job_name should raise ValueError."""

        @register("duplicate_job")
        async def first(payload: dict) -> None:
            pass

        with pytest.raises(ValueError, match="already registered"):

            @register("duplicate_job")
            async def second(payload: dict) -> None:
                pass

    def test_list_registered_jobs(self):
        """list_registered_jobs should return a sorted list of job names."""

        @register("zzz_job")
        async def h1(payload: dict) -> None:
            pass

        @register("aaa_job")
        async def h2(payload: dict) -> None:
            pass

        jobs = list_registered_jobs()
        assert jobs == ["aaa_job", "zzz_job"]


# ---------------------------------------------------------------------------
# Schema tests
# ---------------------------------------------------------------------------


class TestSchemas:
    """Tests for Pydantic queue schemas."""

    def test_job_create_defaults(self):
        """JobCreate should have sensible defaults."""
        schema = JobCreate(job_name="send_email", module="notifications")
        assert schema.priority == JobPriority.NORMAL
        assert schema.max_retries == 3
        assert schema.payload == {}
        assert schema.run_at is None

    def test_queue_stats_from_counts(self):
        """QueueStats.from_counts should correctly sum totals."""
        counts = {
            JobStatus.PENDING: 5,
            JobStatus.RUNNING: 2,
            JobStatus.COMPLETED: 100,
            JobStatus.FAILED: 3,
            JobStatus.CANCELLED: 1,
        }
        stats = QueueStats.from_counts(counts)
        assert stats.pending == 5
        assert stats.running == 2
        assert stats.completed == 100
        assert stats.failed == 3
        assert stats.cancelled == 1
        assert stats.total == 111

    def test_queue_stats_missing_status(self):
        """QueueStats.from_counts should default missing statuses to 0."""
        stats = QueueStats.from_counts({JobStatus.PENDING: 3})
        assert stats.running == 0
        assert stats.total == 3


# ---------------------------------------------------------------------------
# Constants tests
# ---------------------------------------------------------------------------


class TestConstants:
    """Tests for JobStatus and JobPriority enums."""

    def test_job_priority_ordering(self):
        """HIGH priority should be numerically greater than NORMAL and LOW."""
        assert JobPriority.HIGH.value > JobPriority.NORMAL.value > JobPriority.LOW.value

    def test_job_status_values(self):
        """All expected status values should be present."""
        statuses = {s.value for s in JobStatus}
        assert statuses == {"PENDING", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"}


# ---------------------------------------------------------------------------
# Worker tests
# ---------------------------------------------------------------------------


class TestBackgroundWorker:
    """Tests for the BackgroundWorker start/stop lifecycle."""

    @pytest.mark.asyncio
    async def test_worker_starts_and_stops(self):
        """Worker should be running after start() and stopped after stop()."""
        from app.queue.worker import BackgroundWorker

        with patch("app.queue.worker.get_sessionmaker") as mock_sm:
            # Mock a session that always returns empty queue.
            mock_session = AsyncMock()
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=None)
            mock_sm.return_value = MagicMock(return_value=mock_session)

            # QueueService.claim_next_job returns None (empty queue).
            with patch("app.queue.worker.QueueService") as MockService:
                instance = MockService.return_value
                instance.claim_next_job = AsyncMock(return_value=None)
                instance.recover_stuck_jobs = AsyncMock(return_value=0)

                worker = BackgroundWorker()
                assert not worker.is_running

                await worker.start()
                assert worker.is_running

                await worker.stop()
                assert not worker.is_running

    @pytest.mark.asyncio
    async def test_start_idempotent(self):
        """Calling start() twice should not create two tasks."""
        from app.queue.worker import BackgroundWorker

        with patch("app.queue.worker.get_sessionmaker") as mock_sm:
            mock_session = AsyncMock()
            mock_session.__aenter__ = AsyncMock(return_value=mock_session)
            mock_session.__aexit__ = AsyncMock(return_value=None)
            mock_sm.return_value = MagicMock(return_value=mock_session)

            with patch("app.queue.worker.QueueService") as MockService:
                instance = MockService.return_value
                instance.claim_next_job = AsyncMock(return_value=None)
                instance.recover_stuck_jobs = AsyncMock(return_value=0)

                worker = BackgroundWorker()
                await worker.start()
                task1 = worker._task
                await worker.start()  # second call — should be no-op
                assert worker._task is task1  # same task object

                await worker.stop()
