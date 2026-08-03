"""
In-Memory Cache Backend.

Production-grade implementation of :class:`CacheBackend`. Implements every
method of the abstract interface plus:

- Per-key TTL expiration (checked lazily on access and proactively by the
  cleanup worker in :mod:`app.cache.cleanup`).
- An optional maximum-size cap with LRU eviction, so a runaway cache can
  never exhaust process memory.
- Statistics tracking (hits, misses, sets, deletes, evictions, expired
  items, estimated memory usage) via :class:`app.cache.statistics.CacheStats`.
- Namespace deletion: delete every key that starts with a given prefix,
  used to invalidate e.g. all cached permission sets at once.
- Async safety: every mutation is guarded by a single ``asyncio.Lock``.
  Because this backend only ever runs inside one asyncio event loop (the
  FastAPI app), a single lock is sufficient -- there is no multi-process
  or multi-thread access to guard against.

Internal data structure
------------------------
``_store: dict[str, _CacheEntry]``

``_CacheEntry`` is a small dataclass holding the stored value, its
expiry timestamp, the last-accessed timestamp (for LRU), and an estimated
byte size (for the memory-usage statistic).
"""

from __future__ import annotations

import asyncio
import sys
import time
from dataclasses import dataclass
from typing import Any

from app.cache.base import CacheBackend
from app.cache.statistics import CacheStats


@dataclass
class _CacheEntry:
    """Internal container for a single cached item."""

    value: Any
    expires_at: float | None  # monotonic timestamp, or None = never expires
    last_used: float          # monotonic timestamp -- updated on every access
    size_bytes: int           # estimated byte size of key + value


def _estimate_size(key: str, value: Any) -> int:
    """
    Return a rough estimate of how many bytes ``key`` + ``value`` occupy.

    Uses ``sys.getsizeof``, which measures only the top-level object, not
    deep/recursive contents (e.g. a list's items aren't walked). This is
    intentionally approximate -- good enough for the admin dashboard's
    "estimated memory usage" figure, not a precise allocator measurement.
    """
    try:
        return sys.getsizeof(key) + sys.getsizeof(value)
    except TypeError:
        return sys.getsizeof(key) + 64  # fallback for types getsizeof rejects


class InMemoryCacheBackend(CacheBackend):
    """
    Process-local cache with TTL expiration, optional LRU eviction, and stats.

    NOT suitable for a multi-process/multi-instance deployment (each
    process has its own, inconsistent cache) -- that is precisely the gap a
    future ``RedisCacheBackend`` would fill, without requiring any change
    to code that only calls :class:`CacheBackend` methods.

    Args:
        max_size: Maximum number of entries before LRU eviction kicks in.
            ``0`` (the default) disables the size cap entirely.
        default_ttl_seconds: TTL applied to ``set()`` calls that do not
            supply their own ``ttl_seconds``. ``None`` means "no default
            TTL" (entries live forever unless a TTL is given explicitly).
    """

    def __init__(self, *, max_size: int = 0, default_ttl_seconds: int | None = None) -> None:
        """Initialize an empty, async-safe in-memory cache."""
        self._store: dict[str, _CacheEntry] = {}
        self._lock = asyncio.Lock()
        self._max_size = max_size
        self._default_ttl = default_ttl_seconds
        self.stats = CacheStats()

    # ------------------------------------------------------------------
    # CacheBackend interface
    # ------------------------------------------------------------------

    async def get(self, key: str) -> Any | None:
        """
        Return the stored value for ``key``, or None if absent/expired.

        Refreshes the entry's ``last_used`` timestamp on a hit (for LRU).
        An expired entry is removed immediately on access (lazy expiration)
        in addition to being swept periodically by the cleanup worker.
        """
        async with self._lock:
            entry = self._store.get(key)

            if entry is None:
                self.stats.misses += 1
                return None

            now = time.monotonic()
            if entry.expires_at is not None and entry.expires_at < now:
                # Lazy expiration: the cleanup worker hasn't gotten to this
                # key yet, but it's stale, so treat it as a miss and evict it.
                self._remove_entry_locked(key, entry, expired=True)
                self.stats.misses += 1
                return None

            entry.last_used = now
            self.stats.hits += 1
            return entry.value

    async def set(self, key: str, value: Any, *, ttl_seconds: int | None = None) -> None:
        """
        Store ``value`` under ``key``.

        If ``ttl_seconds`` is omitted, the backend's ``default_ttl_seconds``
        is used (if configured). If both are ``None``, the entry never
        expires on its own.

        If inserting a *new* key would exceed ``max_size``, the least-
        recently-used entry is evicted first to make room.
        """
        effective_ttl = ttl_seconds if ttl_seconds is not None else self._default_ttl
        now = time.monotonic()
        expires_at = (now + effective_ttl) if effective_ttl is not None else None
        size = _estimate_size(key, value)

        async with self._lock:
            existing = self._store.get(key)
            if existing is not None:
                # Updating an existing key: back out its old accounting first.
                self.stats.total_items -= 1
                self.stats.estimated_bytes -= existing.size_bytes
            elif self._max_size > 0 and len(self._store) >= self._max_size:
                # New key and we're at capacity: evict the LRU entry.
                self._evict_lru_locked()

            self._store[key] = _CacheEntry(value=value, expires_at=expires_at, last_used=now, size_bytes=size)
            self.stats.sets += 1
            self.stats.total_items += 1
            self.stats.estimated_bytes += size

    async def delete(self, key: str) -> None:
        """Remove ``key`` from the cache (no-op if absent)."""
        async with self._lock:
            entry = self._store.get(key)
            if entry is not None:
                self._remove_entry_locked(key, entry, expired=False)
                self.stats.deletes += 1

    async def exists(self, key: str) -> bool:
        """Return True if ``key`` is present and not expired."""
        return (await self.get(key)) is not None

    async def clear(self) -> None:
        """Remove every entry from the cache and reset all statistics."""
        async with self._lock:
            self._store.clear()
            self.stats.reset()

    async def delete_namespace(self, namespace: str) -> int:
        """
        Delete all keys whose name starts with ``"<namespace>:"``.

        Used to invalidate a whole category of cached data at once, e.g.
        ``await cache.delete_namespace("permissions")`` after a role's
        permissions change, rather than tracking every individual user's
        cache key.

        Returns the number of keys deleted.
        """
        prefix = f"{namespace}:"
        async with self._lock:
            keys_to_delete = [k for k in self._store if k.startswith(prefix)]
            for key in keys_to_delete:
                entry = self._store[key]
                self._remove_entry_locked(key, entry, expired=False)
                self.stats.deletes += 1
        return len(keys_to_delete)

    # ------------------------------------------------------------------
    # Cleanup worker support
    # ------------------------------------------------------------------

    async def sweep_expired(self) -> int:
        """
        Remove every entry whose TTL has elapsed.

        Called periodically by :class:`app.cache.cleanup.BackgroundCleanupWorker`
        so expired entries are reclaimed even if nothing ever calls
        ``get()`` on them again. Returns the number of entries removed.
        """
        now = time.monotonic()
        async with self._lock:
            expired_keys = [
                key for key, entry in self._store.items()
                if entry.expires_at is not None and entry.expires_at < now
            ]
            for key in expired_keys:
                entry = self._store[key]
                self._remove_entry_locked(key, entry, expired=True)
        return len(expired_keys)

    # ------------------------------------------------------------------
    # Introspection (used by the admin API)
    # ------------------------------------------------------------------

    async def get_all_keys(self) -> list[str]:
        """Return a snapshot of all currently non-expired keys."""
        now = time.monotonic()
        async with self._lock:
            return [
                key for key, entry in self._store.items()
                if entry.expires_at is None or entry.expires_at >= now
            ]

    async def get_entry_info(self, key: str) -> dict[str, Any] | None:
        """Return metadata about a single key (TTL remaining, size) without its value."""
        now = time.monotonic()
        async with self._lock:
            entry = self._store.get(key)
            if entry is None or (entry.expires_at is not None and entry.expires_at < now):
                return None
            ttl_remaining = None
            if entry.expires_at is not None:
                ttl_remaining = max(0.0, round(entry.expires_at - now, 1))
            return {
                "key": key,
                "expires": entry.expires_at is not None,
                "ttl_remaining_seconds": ttl_remaining,
                "size_bytes": entry.size_bytes,
            }

    # ------------------------------------------------------------------
    # Internal helpers -- callers must already hold ``self._lock``
    # ------------------------------------------------------------------

    def _remove_entry_locked(self, key: str, entry: _CacheEntry, *, expired: bool) -> None:
        """Remove ``key``/``entry`` from the store and update stats accordingly."""
        del self._store[key]
        self.stats.total_items -= 1
        self.stats.estimated_bytes -= entry.size_bytes
        if expired:
            self.stats.expired_items += 1

    def _evict_lru_locked(self) -> None:
        """Evict the single least-recently-used entry to make room for a new one."""
        if not self._store:
            return
        lru_key = min(self._store, key=lambda k: self._store[k].last_used)
        entry = self._store[lru_key]
        self._remove_entry_locked(lru_key, entry, expired=False)
        self.stats.evictions += 1
