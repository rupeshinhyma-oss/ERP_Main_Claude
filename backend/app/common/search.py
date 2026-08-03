"""
Generic Search Parameter.

A single, reusable ``?search=`` query parameter shared by every list
endpoint in the API. What columns a search term is matched against is
inherently module-specific (searching users means matching
username/email; searching roles means matching name/description), so
:class:`SearchParams` only carries the raw term -- concrete repositories
declare which columns it applies to via ``BaseRepository.searchable_fields``
(see :mod:`app.common.base_repository`).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.constants import Limits


class SearchParams(BaseModel):
    """Standard search query parameter: ``?search=john``."""

    search: str | None = Field(
        default=None,
        max_length=Limits.MAX_SEARCH_LENGTH,
        description="Free-text search term, matched against each resource's searchable fields.",
    )

    @property
    def is_active(self) -> bool:
        """Return True if a non-empty search term was supplied."""
        return bool(self.search and self.search.strip())

    @property
    def normalized(self) -> str | None:
        """Return the search term stripped of surrounding whitespace, or None if absent."""
        return self.search.strip() if self.is_active else None
