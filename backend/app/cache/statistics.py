"""
Cache Statistics.

A single dataclass that the InMemoryCacheBackend updates on every
cache operation. Exposed via the admin API and the CacheManager so
operators can see cache efficiency at a glance.

Tracked metrics
---------------
hits            Number of get() calls that returned a non-None value.
misses          Number of get() calls that returned None (absent or expired).
sets            Number of set() calls.
deletes         Number of explicit delete() calls.
evictions       Number of entries removed because the cache hit max_size.
expired_items   Cumulative count of entries removed because their TTL elapsed.
total_items     Current number of unexpired entries in the cache.
estimated_bytes Rough estimate of memory used (sum of sys.getsizeof for
                keys + stored values; intentionally approximate).

All counters are monotonically increasing integers (never reset between
requests) unless the cache is cleared, at which point the caller may
choose to reset stats too.

Thread / async safety
---------------------
The InMemoryCacheBackend guards every write with an asyncio.Lock. Stats
are updated inside the same lock, so they are always consistent with the
state of the store.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


@dataclass
class CacheStats:
    """Snapshot of cache performance counters and current state."""

    # ------------------------------------------------------------------
    # Operation counters (monotonically increasing)
    # ------------------------------------------------------------------
    hits: int = 0
    misses: int = 0
    sets: int = 0
    deletes: int = 0
    evictions: int = 0
    expired_items: int = 0

    # ------------------------------------------------------------------
    # Current state
    # ------------------------------------------------------------------
    total_items: int = 0
    estimated_bytes: int = 0

    # ------------------------------------------------------------------
    # Derived metrics (computed as properties for zero-storage overhead)
    # ------------------------------------------------------------------

    @property
    def total_requests(self) -> int:
        """Total number of get() calls (hits + misses)."""
        return self.hits + self.misses

    @property
    def hit_rate(self) -> float:
        """Cache hit rate as a value between 0.0 and 1.0."""
        total = self.total_requests
        return (self.hits / total) if total > 0 else 0.0

    @property
    def hit_rate_pct(self) -> float:
        """Cache hit rate expressed as a percentage (0–100)."""
        return round(self.hit_rate * 100, 2)

    @property
    def estimated_kb(self) -> float:
        """Estimated memory usage in kilobytes."""
        return round(self.estimated_bytes / 1024, 2)

    # ------------------------------------------------------------------
    # Serialisation helper for the API response
    # ------------------------------------------------------------------

    def to_dict(self) -> dict:
        """Return a plain dict suitable for API responses."""
        return {
            "hits": self.hits,
            "misses": self.misses,
            "sets": self.sets,
            "deletes": self.deletes,
            "evictions": self.evictions,
            "expired_items": self.expired_items,
            "total_items": self.total_items,
            "total_requests": self.total_requests,
            "hit_rate_pct": self.hit_rate_pct,
            "estimated_bytes": self.estimated_bytes,
            "estimated_kb": self.estimated_kb,
            "snapshot_at": datetime.now(timezone.utc).isoformat(),
        }

    def reset(self) -> None:
        """Reset all counters to zero (called when the cache is cleared)."""
        self.hits = 0
        self.misses = 0
        self.sets = 0
        self.deletes = 0
        self.evictions = 0
        self.expired_items = 0
        self.total_items = 0
        self.estimated_bytes = 0
