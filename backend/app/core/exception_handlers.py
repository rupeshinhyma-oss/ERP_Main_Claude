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


async def integrity_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Handle database unique/foreign key integrity errors (duplicate entries)."""
    request_id = _get_request_id(request)
    logger.warning("Database integrity constraint error.", extra={"path": request.url.path, "request_id": request_id})
    return JSONResponse(
        status_code=status.HTTP_400_BAD_REQUEST,
        content=build_error_response(
            code="DUPLICATE_ENTRY",
            message="A record with this code or unique detail already exists.",
            request_id=request_id,
        ),
    )


def register_exception_handlers(app: FastAPI) -> None:
    """Register all global exception handlers on the given FastAPI app instance."""
    from sqlalchemy.exc import IntegrityError
    app.add_exception_handler(AppException, app_exception_handler)
    app.add_exception_handler(StarletteHTTPException, http_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(IntegrityError, integrity_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)