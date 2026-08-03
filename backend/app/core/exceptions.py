"""
Application Exception Hierarchy.

Every business/domain error raised anywhere in the codebase (services,
repositories, routes) should be a subclass of :class:`AppException`. This
gives us exactly one place (the global exception handler registered in
``app.main``) that knows how to translate an internal error into the
standard API response envelope defined in :mod:`app.core.responses`.

Why not just raise ``fastapi.HTTPException`` everywhere?
---------------------------------------------------------
``HTTPException`` couples business logic to the web framework: a service
function should not need to know it's being called from an HTTP route
(it might one day be called from a CLI command, a queue worker, or a test).
By raising framework-agnostic exceptions from services/repositories and
translating them to HTTP responses at the edge (the exception handler),
services stay reusable and framework-independent, honoring the Dependency
Inversion Principle.
"""

from __future__ import annotations

from typing import Any


class AppException(Exception):
    """
    Base class for all application-raised exceptions.

    Attributes:
        message: Human-readable error message, safe to show to API clients.
        status_code: HTTP status code the exception handler should return.
        error_code: Stable, machine-readable identifier for this error type
            (e.g. ``"NOT_FOUND"``), useful for client-side error handling
            and localization.
        details: Optional structured extra context (e.g. field-level
            validation errors).
    """

    status_code: int = 500
    error_code: str = "INTERNAL_SERVER_ERROR"

    def __init__(
        self,
        message: str = "An unexpected error occurred.",
        *,
        details: Any = None,
    ) -> None:
        """Initialize the exception with a message and optional details."""
        self.message = message
        self.details = details
        super().__init__(message)


class NotFoundException(AppException):
    """Raised when a requested resource does not exist."""

    status_code = 404
    error_code = "NOT_FOUND"

    def __init__(self, message: str = "The requested resource was not found.", **kwargs: Any) -> None:
        """Initialize with a default 'not found' message."""
        super().__init__(message, **kwargs)


class BadRequestException(AppException):
    """Raised when a request is malformed or contains invalid parameters/combinations."""

    status_code = 400
    error_code = "BAD_REQUEST"

    def __init__(self, message: str = "The request could not be understood or was malformed.", **kwargs: Any) -> None:
        """Initialize with a default bad-request message."""
        super().__init__(message, **kwargs)


class ValidationException(AppException):
    """Raised when input fails business-level validation rules."""

    status_code = 422
    error_code = "VALIDATION_ERROR"

    def __init__(self, message: str = "Validation failed.", **kwargs: Any) -> None:
        """Initialize with a default validation-error message."""
        super().__init__(message, **kwargs)


class ConflictException(AppException):
    """Raised when a request conflicts with the current state of a resource (e.g. duplicates)."""

    status_code = 409
    error_code = "CONFLICT"

    def __init__(self, message: str = "The request conflicts with existing data.", **kwargs: Any) -> None:
        """Initialize with a default conflict message."""
        super().__init__(message, **kwargs)


class UnauthorizedException(AppException):
    """Raised when a request lacks valid authentication credentials."""

    status_code = 401
    error_code = "UNAUTHORIZED"

    def __init__(self, message: str = "Authentication is required.", **kwargs: Any) -> None:
        """Initialize with a default unauthorized message."""
        super().__init__(message, **kwargs)


class ForbiddenException(AppException):
    """Raised when an authenticated actor lacks permission for an action."""

    status_code = 403
    error_code = "FORBIDDEN"

    def __init__(self, message: str = "You do not have permission to perform this action.", **kwargs: Any) -> None:
        """Initialize with a default forbidden message."""
        super().__init__(message, **kwargs)


class TooManyRequestsException(AppException):
    """Raised when a client has exceeded a rate limit (e.g. login attempts, API throttling)."""

    status_code = 429
    error_code = "TOO_MANY_REQUESTS"

    def __init__(self, message: str = "Too many requests. Please try again later.", **kwargs: Any) -> None:
        """Initialize with a default rate-limit message."""
        super().__init__(message, **kwargs)


class ServiceUnavailableException(AppException):
    """Raised when a downstream dependency (e.g. the database) is unavailable."""

    status_code = 503
    error_code = "SERVICE_UNAVAILABLE"

    def __init__(self, message: str = "The service is temporarily unavailable.", **kwargs: Any) -> None:
        """Initialize with a default service-unavailable message."""
        super().__init__(message, **kwargs)


class InternalServerException(AppException):
    """Raised for unexpected, non-business-rule failures."""

    status_code = 500
    error_code = "INTERNAL_SERVER_ERROR"

    def __init__(self, message: str = "An unexpected error occurred.", **kwargs: Any) -> None:
        """Initialize with a default internal-error message."""
        super().__init__(message, **kwargs)
