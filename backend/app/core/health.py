"""
Health Check Service.

Encapsulates the actual health-check business logic (what does "healthy"
mean for this service?) so that the route in ``app.api.v1.health`` stays a
thin translation layer, per the "routes contain no business logic" rule.

Kept in ``app.core`` (rather than a feature module) because health checks
are an infrastructure concern used by orchestrators/load balancers, not a
business domain.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.logging import get_logger

logger = get_logger(__name__)


class ComponentStatus(str, Enum):
    """Health status of an individual dependency/component."""

    UP = "up"
    DOWN = "down"


@dataclass
class ComponentHealth:
    """Health information for a single dependency (e.g. the database)."""

    name: str
    status: ComponentStatus
    latency_ms: float | None = None
    detail: str | None = None


@dataclass
class HealthReport:
    """Aggregate health report for the whole application."""

    status: ComponentStatus
    app_name: str
    app_version: str
    environment: str
    components: list[ComponentHealth] = field(default_factory=list)


class HealthService:
    """Performs liveness/readiness checks against the application and its dependencies."""

    async def check_liveness(self) -> HealthReport:
        """
        Return a liveness report.

        Liveness only confirms the process itself is running and able to
        handle requests -- it deliberately does NOT check the database, so
        an orchestrator does not restart a healthy process just because the
        database is briefly unavailable.
        """
        return HealthReport(
            status=ComponentStatus.UP,
            app_name=settings.APP_NAME,
            app_version=settings.APP_VERSION,
            environment=settings.ENVIRONMENT.value,
        )

    async def check_readiness(self, db_session: AsyncSession) -> HealthReport:
        """
        Return a readiness report, including a live database round-trip.

        Readiness confirms the application can actually serve traffic
        (i.e. its dependencies are reachable), and is what should be wired
        up to a load balancer's health-check / Kubernetes readiness probe.
        """
        db_health = await self._check_database(db_session)
        overall_status = ComponentStatus.UP if db_health.status == ComponentStatus.UP else ComponentStatus.DOWN

        return HealthReport(
            status=overall_status,
            app_name=settings.APP_NAME,
            app_version=settings.APP_VERSION,
            environment=settings.ENVIRONMENT.value,
            components=[db_health],
        )

    async def _check_database(self, db_session: AsyncSession) -> ComponentHealth:
        """Execute a trivial ``SELECT 1`` to confirm the database is reachable."""
        start = time.perf_counter()
        try:
            await db_session.execute(text("SELECT 1"))
        except Exception as exc:  # noqa: BLE001 - deliberately broad: any failure means "down"
            logger.error("Database health check failed.", extra={"error": str(exc)})
            return ComponentHealth(name="database", status=ComponentStatus.DOWN, detail=str(exc))
        latency_ms = round((time.perf_counter() - start) * 1000, 2)
        return ComponentHealth(name="database", status=ComponentStatus.UP, latency_ms=latency_ms)
