"""
Health Check Routes.

Exposes liveness and readiness endpoints, standard in any production
deployment for use by load balancers, container orchestrators (e.g.
Kubernetes liveness/readiness probes), and uptime monitors.

These routes are intentionally thin: all actual logic lives in
:class:`app.core.health.HealthService`.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, Depends, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.health import ComponentStatus, HealthService
from app.core.responses import build_success_response
from app.database.session import get_db_session

router = APIRouter(prefix="/health", tags=["Health"])


def get_health_service() -> HealthService:
    """Provide a :class:`HealthService` instance (stateless, so a fresh one is cheap)."""
    return HealthService()


@router.get("/live", summary="Liveness probe")
async def liveness(
    request: Request,
    health_service: HealthService = Depends(get_health_service),
) -> dict:
    """
    Report whether the application process itself is alive.

    Does not check external dependencies. A failing liveness probe should
    cause an orchestrator to restart the process; it should not be tripped
    by a transient database outage (that's what readiness is for).
    """
    report = await health_service.check_liveness()
    return build_success_response(data=asdict(report), request_id=request.state.request_id)


@router.get("/ready", summary="Readiness probe")
async def readiness(
    request: Request,
    health_service: HealthService = Depends(get_health_service),
    db_session: AsyncSession = Depends(get_db_session),
) -> dict:
    """
    Report whether the application is ready to serve traffic.

    Includes a live database connectivity check. Returns HTTP 503 when any
    critical dependency is down, which is what most orchestrators expect in
    order to pull an instance out of a load-balancer rotation.
    """
    report = await health_service.check_readiness(db_session)
    payload = build_success_response(data=asdict(report), request_id=request.state.request_id)

    if report.status != ComponentStatus.UP:
        from fastapi.responses import JSONResponse

        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content=payload)

    return payload
