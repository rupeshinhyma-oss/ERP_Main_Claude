"""
Cache Dependency / Factory.

The single place in the codebase that decides WHICH :class:`CacheBackend`
implementation is active, based on ``settings.CACHE_BACKEND``, and wires
up the process-wide :class:`BackgroundCleanupWorker`. Everywhere else,
code depends on ``Depends(get_cache)`` / ``Depends(get_cache_manager)``
and the abstract interfaces only -- never a concrete backend class.

To add Redis support later:
    1. pip install redis
    2. Add app/cache/redis_backend.py implementing CacheBackend.
    3. Add an ``elif settings.CACHE_BACKEND == "redis": ...`` branch in
       ``_build_cache_backend`` below.
No other file in the codebase needs to change.
"""

from __future__ import annotations

from fastapi import Depends

from app.cache.base import CacheBackend
from app.cache.cleanup import BackgroundCleanupWorker
from app.cache.in_memory import InMemoryCacheBackend
from app.cache.manager import CacheManager
from app.core.config import settings

_cache_instance: CacheBackend | None = None
_cleanup_worker: BackgroundCleanupWorker | None = None


def _build_cache_backend() -> CacheBackend:
    """Construct the configured cache backend based on ``settings.CACHE_BACKEND``."""
    if settings.CACHE_BACKEND == "in_memory":
        return InMemoryCacheBackend(
            max_size=settings.CACHE_MAX_SIZE,
            default_ttl_seconds=settings.CACHE_DEFAULT_TTL_SECONDS,
        )

    # Future extension point, e.g.:
    # if settings.CACHE_BACKEND == "redis":
    #     from app.cache.redis_backend import RedisCacheBackend
    #     return RedisCacheBackend(settings.REDIS_URL)

    raise ValueError(f"Unsupported CACHE_BACKEND: {settings.CACHE_BACKEND!r}")


def get_cache() -> CacheBackend:
    """
    Return the process-wide cache backend singleton (FastAPI dependency).

    A singleton (rather than one instance per request) is correct here
    because the cache is meant to be shared across requests; only the
    underlying storage differs by backend (in-process dict vs. a future
    shared Redis server).
    """
    global _cache_instance
    if _cache_instance is None:
        _cache_instance = _build_cache_backend()
    return _cache_instance


def get_cache_manager(cache: CacheBackend = Depends(get_cache)) -> CacheManager:
    """
    Return a :class:`CacheManager` wrapping the process-wide cache backend.

    This is the dependency business modules should use in routes/services
    (``cache_manager: CacheManager = Depends(get_cache_manager)``) rather
    than depending on ``CacheBackend`` directly, so ERP-specific caching
    policy (namespaces, TTLs) stays centralized in ``app.cache.manager``.
    """
    return CacheManager(cache)


def get_cleanup_worker() -> BackgroundCleanupWorker:
    """
    Return the process-wide :class:`BackgroundCleanupWorker` singleton.

    Started/stopped from ``app.main.lifespan`` alongside the queue worker.
    Bound to the same cache singleton returned by :func:`get_cache`, since
    an ``InMemoryCacheBackend`` is required for the sweep loop to make sense
    (a future Redis backend would expire keys server-side and would not
    need this worker at all).
    """
    global _cleanup_worker
    if _cleanup_worker is None:
        backend = get_cache()
        if not isinstance(backend, InMemoryCacheBackend):
            raise TypeError(
                "BackgroundCleanupWorker requires an InMemoryCacheBackend; "
                f"the configured CACHE_BACKEND ({settings.CACHE_BACKEND!r}) does not use one."
            )
        _cleanup_worker = BackgroundCleanupWorker(
            backend, interval_seconds=settings.CACHE_CLEANUP_INTERVAL_SECONDS
        )
    return _cleanup_worker


def reset_cache_singletons() -> None:
    """
    Clear the process-wide cache/cleanup-worker singletons.

    Test-only helper: each test that builds a fresh application via
    ``create_application()`` would otherwise share cache state (and a
    stale, already-stopped cleanup worker) with every other test in the
    same process.
    """
    global _cache_instance, _cleanup_worker
    _cache_instance = None
    _cleanup_worker = None
