"""
Pagination Primitives.

Shared, framework-agnostic pagination request parameters and response
metadata, reused by every module that exposes a "list" endpoint so that
paging behaves identically (same query params, same response shape) across
the entire API surface.
"""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

from app.core.config import settings

ItemT = TypeVar("ItemT")


class PageParams(BaseModel):
    """
    Standard pagination query parameters: ``?page=1&page_size=20``.

    Uses simple offset/limit pagination. This can be swapped for
    cursor-based pagination later behind the same repository interface
    without changing any route signatures.
    """

    page: int = Field(default=1, ge=1, description="1-indexed page number.")
    # NOTE: plain `default=`, not `default_factory=` -- see the comment on
    # SortParams.sort_order in app/common/sorting.py for why. Same bug,
    # same fix: `settings.DEFAULT_PAGE_SIZE` is fixed at class-definition
    # time in both cases, so behavior is unchanged.
    page_size: int = Field(
        default=settings.DEFAULT_PAGE_SIZE,
        ge=1,
        le=settings.MAX_PAGE_SIZE,
        description=f"Number of items per page (max {settings.MAX_PAGE_SIZE}).",
    )

    @property
    def offset(self) -> int:
        """Compute the SQL OFFSET for this page."""
        return (self.page - 1) * self.page_size

    @property
    def limit(self) -> int:
        """Compute the SQL LIMIT for this page."""
        return self.page_size


class PageMeta(BaseModel):
    """
    Pagination metadata returned alongside a page of results.

    Field names match the Phase 2.5 spec exactly (``total_records``,
    ``total_pages``, ``current_page``, ``has_next``, ``has_previous``) so
    every paginated list endpoint in the API is shaped identically.
    """

    current_page: int
    page_size: int
    total_records: int
    total_pages: int
    has_next: bool
    has_previous: bool

    @classmethod
    def build(cls, *, page: int, page_size: int, total_records: int) -> "PageMeta":
        """Compute derived pagination metadata (total_pages, has_next/has_previous) from raw counts."""
        total_pages = (total_records + page_size - 1) // page_size if page_size else 0
        return cls(
            current_page=page,
            page_size=page_size,
            total_records=total_records,
            total_pages=total_pages,
            has_next=page < total_pages,
            has_previous=page > 1,
        )

    def as_meta_dict(self) -> dict:
        """Return this pagination metadata as a plain dict, ready to merge into a response ``meta`` block."""
        return {"pagination": self.model_dump(mode="json")}


class Page(BaseModel, Generic[ItemT]):
    """A single page of results plus its pagination metadata (for internal/service-layer use)."""

    items: list[ItemT]
    pagination: PageMeta