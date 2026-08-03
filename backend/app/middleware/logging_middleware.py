"""
Access Logging Middleware.

Logs one structured line per request with method, path, status code, and
duration. This is intentionally separate from the ``RequestIdMiddleware``
(single responsibility) and from web-server access logs, so we get
consistent, structured logs regardless of how uvicorn is configured.
"""

from __future__ import annotations

import time

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import get_logger

logger = get_logger("app.access")


class AccessLogMiddleware(BaseHTTPMiddleware):
    """Log method, path, status code and duration for every request."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Time the request and emit a structured access-log entry."""
        start_time = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start_time) * 1000, 2)

        response.headers["X-Process-Time-Ms"] = str(duration_ms)

        logger.info(
            "request handled",
            extra={
                "http_method": request.method,
                "http_path": request.url.path,
                "status_code": response.status_code,
                "duration_ms": duration_ms,
                "client_host": request.client.host if request.client else None,
            },
        )
        return response
