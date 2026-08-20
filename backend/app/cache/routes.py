"""
Cache Admin Routes.

A small monitoring/management API for the built-in memory cache:

    GET    /cache/stats              Hit/miss counters, item count, estimated memory usage.
    GET    /cache/keys               List every currently cached key (debugging aid).
    GET    /cache/keys/{key}         Inspect a single key's TTL/size without exposing its value.
    DELETE /cache/flush              Clear the entire cache.
    DELETE /cache/namespace/{name}   Clear every key in one namespace (e.g. "permissions").

Open to any authenticated user by design -- no permission code gates these
routes. Cache is invisible, automatic infrastructure that should keep
working the same way for everyone regardless of what's been granted to
their role; it deliberately isn't part of the RBAC permission system.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from app.auth.dependencies import get_current_user
from app.auth.service import CurrentUser
from app.cache.base import CacheBackend
from app.cache.dependency import get_cache
from app.cache.in_memory import InMemoryCacheBackend
from app.core.exceptions import BadRequestException, NotFoundException
from app.core.responses import build_success_response

router = APIRouter(prefix="/cache", tags=["Cache (admin)"])


def _require_in_memory_backend(cache: CacheBackend) -> InMemoryCacheBackend:
    """
    Narrow the generic ``CacheBackend`` to the concrete in-memory implementation.

    The introspection endpoints below (stats, keys) are specific to how the
    built-in in-memory backend stores data. A future Redis backend would
    expose equivalent information through its own admin tooling (e.g.
    ``INFO``/``redis-cli``) rather than this API, so this guard makes that
    boundary explicit instead of silently returning wrong data.
    """
    if not isinstance(cache, InMemoryCacheBackend):
        raise BadRequestException(
            "Cache introspection is only available for the in-memory cache backend."
        )
    return cache


@router.get("/stats", summary="Cache performance statistics (admin)")
async def get_cache_stats(
    request: Request,
    cache: CacheBackend = Depends(get_cache),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return hit/miss counters, current item count, and estimated memory usage."""
    backend = _require_in_memory_backend(cache)
    return build_success_response(data=backend.stats.to_dict(), request_id=request.state.request_id)


@router.get("/keys", summary="List all cached keys (admin)")
async def list_cache_keys(
    request: Request,
    cache: CacheBackend = Depends(get_cache),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """List every currently non-expired key in the cache. A debugging/inspection aid."""
    backend = _require_in_memory_backend(cache)
    keys = await backend.get_all_keys()
    data = {"keys": sorted(keys), "count": len(keys)}
    return build_success_response(data=data, request_id=request.state.request_id)


@router.get("/keys/{key:path}", summary="Inspect a single cache key (admin)")
async def inspect_cache_key(
    key: str,
    request: Request,
    cache: CacheBackend = Depends(get_cache),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """Return TTL/size metadata for one key, without exposing its cached value."""
    backend = _require_in_memory_backend(cache)
    info = await backend.get_entry_info(key)
    if info is None:
        raise NotFoundException(f"No cached entry found for key {key!r}.")
    return build_success_response(data=info, request_id=request.state.request_id)


@router.delete("/flush", summary="Clear the entire cache (admin)")
async def flush_cache(
    request: Request,
    cache: CacheBackend = Depends(get_cache),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Clear every entry from the cache and reset statistics.

    Use sparingly in production: every subsequent request for previously
    cached data will fall through to the database until the cache warms
    back up.
    """
    await cache.clear()
    data = {"cleared": True, "namespace": None, "keys_removed": None}
    return build_success_response(data=data, request_id=request.state.request_id, message="Cache cleared.")


@router.delete("/namespace/{name}", summary="Clear one cache namespace (admin)")
async def flush_cache_namespace(
    name: str,
    request: Request,
    cache: CacheBackend = Depends(get_cache),
    _current_user: CurrentUser = Depends(get_current_user),
) -> dict:
    """
    Clear every key belonging to a single namespace (e.g. ``permissions``, ``departments``).

    Useful for surgical invalidation without a full flush -- e.g. after a
    bulk role-permission change, clear only ``permissions`` rather than
    every cached department/setting/dropdown too.
    """
    removed = await cache.delete_namespace(name)
    data = {"cleared": True, "namespace": name, "keys_removed": removed}
    return build_success_response(
        data=data, request_id=request.state.request_id, message=f"Namespace {name!r} cleared."
    )