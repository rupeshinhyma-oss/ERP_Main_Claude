"""
Generic Dynamic Filtering.

Supports arbitrary exact-match query filters (``?status=active&department=HR``)
plus the two standard date-range filters every list endpoint gets for free
(``?created_after=...&created_before=...``), without every route needing to
declare its own filter schema.

Because the set of valid filter keys is inherently module-specific (a
``users`` list can filter on ``status``; a future ``departments`` list
cannot), :class:`FilterParams` deliberately does NOT validate keys against
an allow-list itself -- that happens one layer down, in
``BaseRepository.filterable_fields`` (see :mod:`app.common.base_repository`),
which silently ignores any key it doesn't recognize rather than erroring,
so callers can pass extra query params (e.g. for client-side use) without
breaking the request.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from fastapi import Request

from app.core.constants import Limits
from app.core.exceptions import BadRequestException

# Query parameter names reserved for pagination/search/sorting -- never
# treated as dynamic exact-match filters, even though they appear
# alongside them in the same query string.
_RESERVED_PARAM_NAMES = {"page", "page_size", "search", "sort_by", "sort_order"}

# Suffixes recognized as range operators on a base column name, e.g.
# "created_after"/"created_before" both operate on the "created_at" column.
_RANGE_SUFFIXES = {"_after": "gte", "_before": "lte"}


@dataclass
class FilterParams:
    """
    Parsed dynamic filters from the request's query string.

    Attributes:
        exact: Mapping of column name -> exact-match value (e.g. ``{"status": "active"}``).
        ranges: Mapping of column name -> {"gte": ..., "lte": ...} datetime bounds
            (e.g. ``{"created_at": {"gte": <datetime>}}`` from ``?created_after=...``).
    """

    exact: dict[str, str] = field(default_factory=dict)
    ranges: dict[str, dict[str, datetime]] = field(default_factory=dict)


def _parse_range_key(key: str) -> tuple[str, str] | None:
    """Return ``(column_name, operator)`` if ``key`` is a recognized range-filter key, else None."""
    for suffix, operator in _RANGE_SUFFIXES.items():
        if key.endswith(suffix):
            column = key[: -len(suffix)] + "_at"  # created_after -> created_at, updated_before -> updated_at
            return column, operator
    return None


def get_filter_params(request: Request) -> FilterParams:
    """
    FastAPI dependency: parse every non-reserved query parameter into :class:`FilterParams`.

    Usage::

        @router.get("/users")
        async def list_users(filters: FilterParams = Depends(get_filter_params)) -> ...:
            ...
    """
    exact: dict[str, str] = {}
    ranges: dict[str, dict[str, datetime]] = {}

    for key, value in request.query_params.items():
        if key in _RESERVED_PARAM_NAMES:
            continue
        if len(value) > Limits.MAX_FILTER_VALUE_LENGTH:
            raise BadRequestException(f"Filter value for {key!r} exceeds the maximum allowed length.")

        range_match = _parse_range_key(key)
        if range_match is not None:
            column, operator = range_match
            try:
                parsed = datetime.fromisoformat(value)
            except ValueError as exc:
                raise BadRequestException(f"Invalid date/time value for filter {key!r}: {value!r}.") from exc
            ranges.setdefault(column, {})[operator] = parsed
        else:
            exact[key] = value

    return FilterParams(exact=exact, ranges=ranges)
