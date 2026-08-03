"""
Cache Module.

A lightweight, built-in, process-local memory cache -- no Redis,
Memcached, or any other external cache service required. Everything runs
inside the same Python process as the web server.

Architecture
------------
Application code
     |
     v
CacheManager        <- high-level developer API (get_or_set, named helpers)
     |
     v
CacheBackend        <- abstract interface (get/set/delete/exists/clear)
     |
     v
InMemoryCacheBackend <- concrete implementation (TTL, LRU, stats)
     |
     v  (only on a cache miss)
Database

Feature modules should depend on :class:`CacheManager` (via
``Depends(get_cache_manager)``) for named ERP use cases, or on the raw
:class:`CacheBackend` protocol (via ``Depends(get_cache)``) for bespoke
key patterns -- never on a concrete backend implementation directly. This
keeps the door open to swapping in Redis later with a two-line change:

1. Implement ``RedisCacheBackend(CacheBackend)`` in ``app/cache/redis_backend.py``.
2. Change the single factory function in ``app/cache/dependency.py`` to
   return it based on ``settings.CACHE_BACKEND``.

No calling code anywhere else in the codebase needs to change.

Files
-----
base.py          Abstract CacheBackend interface.
in_memory.py      InMemoryCacheBackend: TTL expiration, optional LRU
                  eviction, statistics tracking, namespace deletion.
statistics.py     CacheStats dataclass: hits, misses, sets, deletes,
                  evictions, expired items, item count, estimated memory.
cleanup.py        BackgroundCleanupWorker: asyncio task that periodically
                  sweeps expired entries so memory is reclaimed even for
                  keys nobody ever reads again.
manager.py        CacheManager: the high-level developer API, with named
                  helpers for permissions, roles, settings, departments,
                  designations, dropdown data, dashboard counts, and
                  generic records.
dependency.py     FastAPI DI wiring: get_cache(), get_cache_manager(),
                  get_cleanup_worker().
routes.py         Admin API: GET /cache/stats, GET /cache/keys,
                  DELETE /cache/flush, DELETE /cache/namespace/{name}.
schemas.py        Pydantic response models for the admin API.

Guarantees / non-guarantees
----------------------------
- Thread-safe within the single asyncio event loop (guarded by an
  asyncio.Lock on every mutation).
- Configurable per-key TTL, with automatic expiration (lazy on access,
  proactive via the cleanup worker).
- NOT persisted to disk -- cache contents are lost on process restart, by
  design (this is a cache, not a store of record).
- NOT replicated or shared across processes/instances. A future Redis
  backend is the intended answer if that's ever needed.
- NO pub/sub or distributed invalidation. Invalidation is explicit
  (``CacheManager.invalidate_*`` / ``CacheBackend.delete_namespace``),
  called from the write path that changed the underlying data.
"""

from app.cache.base import CacheBackend
from app.cache.dependency import get_cache, get_cache_manager
from app.cache.manager import CacheManager

__all__ = ["CacheBackend", "CacheManager", "get_cache", "get_cache_manager"]
