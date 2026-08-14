"""
Global Exception Handlers.

Registers a small set of FastAPI exception handlers that translate every
exception the application can raise -- domain exceptions, FastAPI/Starlette
HTTP exceptions, Pydantic validation errors, and any truly unexpected
exception -- into the standard response envelope from
:mod:`app.core.responses`.

This is the ONLY place in the codebase that should catch broad exceptions
and turn them into HTTP responses. Everywhere else, code should let
exceptions propagate so they land here, keeping error-handling logic in one
place instead of scattered across every route.
"""

from __future__ import annotations

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from sqlalchemy.exc import OperationalError, TimeoutError as SATimeoutError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

from app.core.exceptions import AppException
from app.core.logging import get_logger
from app.core.responses import build_error_response

logger = get_logger(__name__)


def _get_request_id(request: Request) -> str:
    """Read the correlation ID attached by RequestIdMiddleware, defaulting to '-'."""
    return getattr(request.state, "request_id", "-")


async def app_exception_handler(request: Request, exc: AppException) -> JSONResponse:
    """Handle every application-raised :class:`AppException` subclass."""
    request_id = _get_request_id(request)
    logger.warning(
        "Handled application exception.",
        extra={"error_code": exc.error_code, "error_message": exc.message, "path": request.url.path},
    )
    return JSONResponse(
        status_code=exc.status_code,
        content=build_error_response(
            code=exc.error_code,
            message=exc.message,
            request_id=request_id,
            details=exc.details,
        ),
    )


async def http_exception_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Handle standard Starlette/FastAPI HTTPExceptions (e.g. 404 on unknown routes)."""
    request_id = _get_request_id(request)
    return JSONResponse(
        status_code=exc.status_code,
        content=build_error_response(
            code="HTTP_ERROR",
            message=str(exc.detail),
            request_id=request_id,
        ),
    )


async def validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Handle Pydantic request-validation failures, with one error entry per invalid field."""
    request_id = _get_request_id(request)
    errors = [
        {
            "code": "VALIDATION_ERROR",
            "message": error["msg"],
            "field": ".".join(str(part) for part in error["loc"][1:]) or None,
            "details": None,
        }
        for error in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=build_error_response(
            code="VALIDATION_ERROR",
            message="Request validation failed.",
            request_id=request_id,
            errors=errors,
        ),
    )


async def database_unavailable_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Handle database-connectivity failures specifically (Phase 7 item 7):
    ``OperationalError`` (connection refused/reset, auth failure to the DB
    itself) and SQLAlchemy's own pool-checkout ``TimeoutError`` (pool
    exhausted -- every connection is in use and none freed up within
    ``DATABASE_POOL_TIMEOUT_SECONDS``).

    These are distinguished from an arbitrary unhandled exception because
    they're a genuinely different, transient condition -- "the database is
    unreachable right now" -- and are mapped to 503 rather than a bare 500
    so that: (a) the frontend's retry logic treats them as retryable
    (RETRYABLE_STATUSES includes 503, see frontend/src/lib/api.ts), and
    (b) operators scanning logs/metrics can tell "DB is down" apart from
    "a bug threw an unexpected exception". The message shown to the client
    stays generic -- no DSN, host, or driver error text -- per the
    "never expose stack traces or internal database errors" rule.

    NOTE: any transaction on the failed session was already rolled back by
    ``app.database.session.get_db_session``'s own exception handling before
    this ever runs, so there is no risk of this handler seeing (or masking)
    a dirty/uncommitted transaction.
    """
    request_id = _get_request_id(request)
    logger.error(
        "Database unavailable while handling request.",
        extra={"path": request.url.path, "request_id": request_id, "error_type": type(exc).__name__},
    )
    return JSONResponse(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        content=build_error_response(
            code="SERVICE_UNAVAILABLE",
            message="The service is temporarily unavailable. Please try again in a moment.",
            request_id=request_id,
        ),
    )


async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """
    Catch-all handler for exceptions with no more specific handler.

    Logs the full stack trace server-side but returns a generic message to
    the client so internal details (stack traces, SQL, file paths) are never
    leaked, which is a common source of information disclosure in APIs
    that let default framework error pages reach production.
    """
    request_id = _get_request_id(request)
    logger.exception("Unhandled exception.", extra={"path": request.url.path, "request_id": request_id})
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=build_error_response(
            code="INTERNAL_SERVER_ERROR",
            message="An unexpected error occurred. Please try again later.",
            request_id=request_id,
        ),
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Register all global exception handlers on the given FastAPI app instance."""
    app.add_exception_handler(AppException, app_exception_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(OperationalError, database_unavailable_handler)
    app.add_exception_handler(SATimeoutError, database_unavailable_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)