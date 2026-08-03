"""
Cache Admin API Schemas.

Response models for the small admin/monitoring API exposed by
:mod:`app.cache.routes`. Kept separate from :mod:`app.cache.statistics`
(which is a plain dataclass used internally) so the API surface can evolve
independently of the internal stats representation.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CacheStatsRead(BaseModel):
    """Cache performance counters and current state, as returned by GET /cache/stats."""

    hits: int = Field(..., description="Number of get() calls that returned a cached value.")
    misses: int = Field(..., description="Number of get() calls that found nothing (absent or expired).")
    sets: int = Field(..., description="Number of set() calls made.")
    deletes: int = Field(..., description="Number of explicit delete() calls made.")
    evictions: int = Field(..., description="Entries removed early because max_size was reached (LRU eviction).")
    expired_items: int = Field(..., description="Cumulative count of entries removed because their TTL elapsed.")
    total_items: int = Field(..., description="Current number of unexpired entries in the cache.")
    total_requests: int = Field(..., description="Total get() calls made (hits + misses).")
    hit_rate_pct: float = Field(..., description="Cache hit rate as a percentage (0-100).")
    estimated_bytes: int = Field(..., description="Estimated memory used by cached data, in bytes.")
    estimated_kb: float = Field(..., description="Estimated memory used by cached data, in kilobytes.")
    snapshot_at: str = Field(..., description="UTC timestamp this snapshot was taken.")


class CacheEntryInfo(BaseModel):
    """Metadata about a single cache entry, without exposing its stored value."""

    key: str = Field(..., description="The cache key.")
    expires: bool = Field(..., description="Whether this entry has a TTL at all.")
    ttl_remaining_seconds: float | None = Field(
        default=None, description="Seconds until expiry, or null if the entry never expires."
    )
    size_bytes: int = Field(..., description="Estimated size of this entry in bytes.")


class CacheKeysRead(BaseModel):
    """List of currently cached keys, as returned by GET /cache/keys."""

    keys: list[str] = Field(..., description="Every non-expired key currently in the cache.")
    count: int = Field(..., description="Number of keys returned.")


class CacheFlushResult(BaseModel):
    """Result of a cache-clearing operation."""

    cleared: bool = Field(..., description="Whether the cache was cleared.")
    namespace: str | None = Field(default=None, description="The namespace cleared, or null if the whole cache was cleared.")
    keys_removed: int | None = Field(default=None, description="Number of keys removed, when clearing a single namespace.")
