"""
Standard API Response Envelope.

Every endpoint in this API returns a response shaped like one of the two
models below, so that API consumers can write one generic response parser
instead of one per endpoint.

Success::

    {
        "success": true,
        "message": "Success",
        "data": { ... },
        "errors": [],
        "meta": { "request_id": "...", "timestamp": "..." }
    }

Error::

    {
        "success": false,
        "message": "Department not found.",
        "data": null,
        "errors": [{ "code": "NOT_FOUND", "message": "Department not found.", "details": null }],
        "meta": { "request_id": "...", "timestamp": "..." }
    }

``meta`` is also where pagination metadata (see :mod:`app.common.pagination`)
is attached for list endpoints, via the ``meta`` kwarg on
:func:`build_success_response`.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, Field

DataT = TypeVar("DataT")


class ResponseMeta(BaseModel):
    """Envelope metadata attached to every API response."""

    request_id: str = Field(..., description="Correlation ID for this request, echoed from the X-Request-ID header.")
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="UTC timestamp at which the response was generated.",
    )


class ErrorDetail(BaseModel):
    """A single structured error entry inside the ``errors`` list."""

    code: str = Field(..., description="Stable, machine-readable error code, e.g. 'NOT_FOUND'.")
    message: str = Field(..., description="Human-readable error message.")
    field: str | None = Field(default=None, description="The request field this error relates to, if applicable.")
    details: Any | None = Field(default=None, description="Optional structured error context.")


class SuccessResponse(BaseModel, Generic[DataT]):
    """Standard envelope for successful responses."""

    success: bool = True
    message: str = "Success"
    data: DataT
    errors: list[ErrorDetail] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)


class ErrorResponse(BaseModel):
    """Standard envelope for error responses."""

    success: bool = False
    message: str
    data: None = None
    errors: list[ErrorDetail]
    meta: dict[str, Any] = Field(default_factory=dict)


def _build_meta(*, request_id: str, extra_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build the ``meta`` block, merging in any endpoint-specific metadata (e.g. pagination)."""
    meta: dict[str, Any] = {"request_id": request_id, "timestamp": datetime.now(timezone.utc).isoformat()}
    if extra_meta:
        meta.update(extra_meta)
    return meta


def build_success_response(
    *,
    data: Any,
    request_id: str,
    message: str = "Success",
    meta: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build a plain-dict success envelope.

    A plain dict (rather than constructing/serializing a Pydantic model) is
    returned so callers can hand this straight to ``JSONResponse`` or return
    it directly from a route without an extra validation round-trip, while
    still following the exact same shape as :class:`SuccessResponse`.

    Args:
        data: The response payload.
        request_id: Correlation ID for this request.
        message: Human-readable status message (default ``"Success"``).
        meta: Extra metadata to merge into the ``meta`` block -- most
            commonly pagination metadata from
            :meth:`app.common.pagination.PageMeta.build`.
    """
    return {
        "success": True,
        "message": message,
        "data": data,
        "errors": [],
        "meta": _build_meta(request_id=request_id, extra_meta=meta),
    }


def build_error_response(
    *,
    code: str,
    message: str,
    request_id: str,
    details: Any | None = None,
    errors: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """
    Build a plain-dict error envelope matching :class:`ErrorResponse`.

    Args:
        code: Stable, machine-readable error code (e.g. ``"NOT_FOUND"``).
        message: Top-level human-readable error message.
        request_id: Correlation ID for this request.
        details: Optional structured context attached to the single error entry.
        errors: Optional pre-built list of error-detail dicts (e.g. one per
            invalid field, for validation failures). If omitted, a single
            error entry is built from ``code``/``message``/``details``.
    """
    error_list = errors if errors is not None else [{"code": code, "message": message, "details": details}]
    return {
        "success": False,
        "message": message,
        "data": None,
        "errors": error_list,
        "meta": _build_meta(request_id=request_id),
    }
