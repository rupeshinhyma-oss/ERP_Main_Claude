"""
Generic Sorting Parameters.

A single, reusable ``?sort_by=&sort_order=`` pair of query parameters
shared by every list endpoint. Which columns are valid to sort by is
module-specific, so :class:`SortParams` only validates the *shape*
(``sort_order`` must be "asc"/"desc") -- concrete repositories validate
``sort_by`` against their own ``sortable_fields`` allow-list (see
:mod:`app.common.base_repository`) so a caller can never sort by an
unindexed or sensitive column that wasn't explicitly exposed.
"""

from __future__ import annotations

from pydantic import BaseModel, Field

from app.core.config import settings
from app.core.constants import SortOrder


class SortParams(BaseModel):
    """Standard sorting query parameters: ``?sort_by=created_at&sort_order=desc``."""

    sort_by: str | None = Field(default=None, description="Field name to sort by.")
    # NOTE: uses a plain `default=` rather than `default_factory=`. FastAPI's
    # query-param resolution for a BaseModel bound via a bare `Depends()`
    # does not reliably invoke `default_factory` when the query param is
    # entirely absent from the request (observed with fastapi==0.115.6 /
    # pydantic==2.10.4) -- it instead validates an empty value against the
    # field, which fails for a str enum ("Input should be 'asc' or 'desc'"),
    # surfacing as "Request validation failed" on every list endpoint that
    # doesn't explicitly pass ?sort_order=. A plain `default=` is applied
    # correctly in that same code path, so it is used here instead. Since
    # `settings.DEFAULT_SORT_ORDER` is only read once at class-definition
    # time either way (Settings is already fully loaded well before any
    # request), this is not a meaningful behavior change from the previous
    # default_factory.
    sort_order: SortOrder = Field(
        default=SortOrder(settings.DEFAULT_SORT_ORDER),
        description="Sort direction: 'asc' or 'desc'.",
    )

    @property
    def is_active(self) -> bool:
        """Return True if an explicit sort field was requested."""
        return bool(self.sort_by and self.sort_by.strip())