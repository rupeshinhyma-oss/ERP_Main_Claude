"""
Automatic Audit Middleware.

Provides the "Automatic Logging" half of Phase 3: every mutating request
(``POST``/``PUT``/``PATCH``/``DELETE``) is recorded to the audit trail even
if the route/service it hits never calls :meth:`AuditService.record`
explicitly. This is a *fallback net*, not the primary mechanism -- routes
that need richer semantics (a proper ``LOGIN``/``ROLE_ASSIGNED`` action
code, real old/new entity snapshots) call ``AuditService.record`` directly
and set ``request.state.audit_logged = True``, which this middleware
checks so a single action is never written twice.

Deliberately uses its own short-lived database session (the same pattern
:mod:`app.queue.worker` uses for its background session) rather than the
per-request session from ``get_db_session``, so:

1. An audit entry for a *failed* request (a 4xx/5xx response, or a request
   whose handler raised) is still committed even though the request's own
   transaction gets rolled back -- audit trails should capture failures
   too (e.g. a failed login, a 403, a validation error), not just
   successes.
2. Nothing about the audit write can itself affect the business
   transaction's isolation/locking.
"""

from __future__ import annotations

import json
import re
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.audit.constants import AuditAction
from app.audit.masking import mask_sensitive_data
from app.audit.repository import AuditRepository
from app.audit.service import AuditService
from app.auth.security import InvalidTokenError, TokenType, decode_token
from app.core.config import settings
from app.core.logging import get_logger
from app.database.engine import get_sessionmaker

logger = get_logger("app.audit")

_MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_SKIP_PATH_PREFIXES = (
    f"{settings.API_V1_PREFIX}/audit",  # avoid noisy self-referential entries
    "/docs",
    "/redoc",
    "/openapi.json",
)
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

_METHOD_TO_ACTION = {
    "POST": AuditAction.CREATE,
    "PUT": AuditAction.UPDATE,
    "PATCH": AuditAction.UPDATE,
    "DELETE": AuditAction.DELETE,
}

# Path-suffix overrides for actions that aren't plain CRUD, keyed by
# (method, path suffix after the API prefix).
_PATH_ACTION_OVERRIDES: dict[tuple[str, str], AuditAction] = {
    ("POST", "/auth/login"): AuditAction.LOGIN,
    ("POST", "/auth/logout"): AuditAction.LOGOUT,
    ("POST", "/auth/refresh"): AuditAction.OTHER,
    ("POST", "/auth/change-password"): AuditAction.PASSWORD_CHANGE,
    ("POST", "/auth/forgot-password"): AuditAction.PASSWORD_RESET,
}


class AuditMiddleware(BaseHTTPMiddleware):
    """Automatically records every mutating HTTP request to the audit trail."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        method = request.method.upper()
        path = request.url.path

        if method not in _MUTATING_METHODS or any(path.startswith(p) for p in _SKIP_PATH_PREFIXES):
            return await call_next(request)

        body_bytes = await self._safe_read_body(request)
        response: Response | None = None
        try:
            response = await call_next(request)
            return response
        finally:
            await self._write_entry(request, method, path, body_bytes, response)

    @staticmethod
    async def _safe_read_body(request: Request) -> bytes:
        """Read and cache the request body so downstream handlers can still consume it."""
        try:
            return await request.body()
        except Exception:  # noqa: BLE001 - never block the request over a body-read failure.
            return b""

    async def _write_entry(
        self, request: Request, method: str, path: str, body_bytes: bytes, response: Response | None
    ) -> None:
        """Best-effort: build and persist one audit row. Never raises."""
        if getattr(request.state, "audit_logged", False):
            return  # A route/service already recorded a richer entry for this request.

        try:
            user_id = self._extract_user_id(request)
            action = self._resolve_action(method, path)
            module, entity_type, entity_id = self._parse_path(path)
            new_values = self._parse_body(body_bytes)
            status_code = response.status_code if response is not None else 500
            if action is AuditAction.LOGIN and status_code >= 400:
                action = AuditAction.LOGIN_FAILED

            session_factory = get_sessionmaker()
            async with session_factory() as session:
                audit_service = AuditService(AuditRepository(session))
                await audit_service.record(
                    action=action,
                    module=module,
                    user_id=user_id,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    new_values=new_values,
                    ip_address=request.client.host if request.client else None,
                    user_agent=request.headers.get("user-agent"),
                    request_id=getattr(request.state, "request_id", None),
                    http_method=method,
                    endpoint=path,
                    response_status=status_code,
                )
                await session.commit()
        except Exception:  # noqa: BLE001 - the audit fallback must never break a real request.
            logger.exception("Automatic audit middleware failed to record an entry.", extra={"path": path})

    @staticmethod
    def _extract_user_id(request: Request) -> uuid.UUID | None:
        """Best-effort decode of the bearer access token, without ever raising."""
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("bearer "):
            return None
        token = header[7:].strip()
        try:
            payload = decode_token(token, expected_type=TokenType.ACCESS)
            return uuid.UUID(payload["sub"])
        except (InvalidTokenError, ValueError, KeyError):
            return None

    @staticmethod
    def _resolve_action(method: str, path: str) -> AuditAction:
        suffix = path[len(settings.API_V1_PREFIX) :] if path.startswith(settings.API_V1_PREFIX) else path
        for (m, p), action in _PATH_ACTION_OVERRIDES.items():
            if m == method and suffix == p:
                return action
        if "/roles" in suffix and method == "POST":
            return AuditAction.ROLE_ASSIGNED
        if "/roles/" in suffix and method == "DELETE":
            return AuditAction.ROLE_REMOVED
        return _METHOD_TO_ACTION.get(method, AuditAction.OTHER)

    @staticmethod
    def _parse_path(path: str) -> tuple[str, str | None, str | None]:
        """Derive (module, entity_type, entity_id) from a versioned API path."""
        suffix = path[len(settings.API_V1_PREFIX) :] if path.startswith(settings.API_V1_PREFIX) else path
        segments = [s for s in suffix.split("/") if s]
        if not segments:
            return "unknown", None, None
        module = segments[0]
        entity_id = next((s for s in segments[1:] if _UUID_RE.match(s)), None)
        entity_type = module[:-1].capitalize() if module.endswith("s") else module.capitalize()
        return module, entity_type, entity_id

    @staticmethod
    def _parse_body(body_bytes: bytes) -> dict | None:
        """Best-effort parse + mask of a JSON request body. Returns None for non-JSON/empty bodies."""
        if not body_bytes:
            return None
        try:
            parsed = json.loads(body_bytes)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None
        if not isinstance(parsed, dict):
            return None
        return mask_sensitive_data(parsed)
