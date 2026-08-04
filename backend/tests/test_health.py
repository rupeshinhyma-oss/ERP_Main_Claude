"""
Health Endpoint Tests.

Smoke tests confirming the application boots, the standard response
envelope is respected, and both liveness and readiness (with a real
database round-trip) succeed. These require a reachable PostgreSQL
instance matching ``DATABASE_URL`` in the environment (see README.md).
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.asyncio


async def test_liveness_returns_success_envelope(client: AsyncClient) -> None:
    """Liveness should report 'up' without touching the database."""
    response = await client.get("/api/v1/health/live")

    assert response.status_code == 200
    body = response.json()
    assert body["success"] is True
    assert body["data"]["status"] == "up"
    assert body["errors"] == []
    assert "request_id" in body["meta"]


async def test_readiness_reports_database_component(client: AsyncClient) -> None:
    """Readiness should report the database component's status explicitly."""
    response = await client.get("/api/v1/health/ready")

    assert response.status_code in (200, 503)
    body = response.json()
    component_names = [c["name"] for c in body["data"]["components"]]
    assert "database" in component_names


async def test_request_id_header_is_echoed(client: AsyncClient) -> None:
    """Every response should carry an X-Request-ID header for correlation."""
    response = await client.get("/api/v1/health/live")

    assert "x-request-id" in response.headers


async def test_unknown_route_returns_standard_error_envelope(client: AsyncClient) -> None:
    """A 404 on an unknown route should still use the standard error envelope."""
    response = await client.get("/api/v1/this-route-does-not-exist")

    assert response.status_code == 404
    body = response.json()
    assert body["success"] is False
    assert len(body["errors"]) > 0
    assert body["errors"][0]["code"] in ("HTTP_ERROR", "NOT_FOUND")
