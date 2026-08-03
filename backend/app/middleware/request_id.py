"""
Request ID Middleware.

Assigns a unique correlation ID to every incoming HTTP request. This ID is:

1. Read from an inbound ``X-Request-ID`` header if the caller (or an
   upstream gateway/load balancer) already supplied one, so a single
   request can be traced across multiple services.
2. Otherwise generated fresh as a UUID4.
3. Stored in a ``ContextVar`` (see :mod:`app.core.logging`) so every log
   line emitted while handling this request is automatically tagged with
   it, without threading it through every function signature.
4. Attached to ``request.state.request_id`` so route handlers/services can
   read it directly if needed (e.g. to embed it in the response envelope).
5. Echoed back to the client on the ``X-Request-ID`` response header.
"""

from __future__ import annotations

import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.core.logging import request_id_ctx_var

REQUEST_ID_HEADER = "X-Request-ID"


class RequestIdMiddleware(BaseHTTPMiddleware):
    """Attach a correlation ID to every request and its logs/response."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        """Generate/propagate the request ID, store it, and echo it back."""
        incoming_id = request.headers.get(REQUEST_ID_HEADER)
        request_id = incoming_id or str(uuid.uuid4())

        token = request_id_ctx_var.set(request_id)
        request.state.request_id = request_id
        try:
            response = await call_next(request)
        finally:
            request_id_ctx_var.reset(token)

        response.headers[REQUEST_ID_HEADER] = request_id
        return response
