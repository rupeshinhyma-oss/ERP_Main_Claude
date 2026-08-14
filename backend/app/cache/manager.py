"""
Cache Manager.

The high-level developer-facing API that business modules should use
instead of talking to :class:`CacheBackend` directly. It wraps a backend
instance and adds:

- ``get_or_set``: the "read-through" pattern almost every use case wants
  (return the cached value, or compute it, cache it, and return it).
- Named, pre-configured helpers for the ERP's known hot-path use cases
  (user permissions, roles, app settings, departments, designations,
  dropdown data, dashboard counts) so call sites don't have to know the
  right namespace or TTL for each -- they just call
  ``cache_manager.get_user_permissions(user_id)`` etc.
- Namespace invalidation helpers (e.g. ``invalidate_user_permissions``)
  so write paths can clear stale data without reaching into cache
  internals.

Why a manager on top of the backend?
-------------------------------------
``CacheBackend`` is deliberately generic (get/set/delete/exists/clear) so
it stays trivially replaceable with Redis later. ``CacheManager`` is where
ERP-specific *policy* lives -- which namespace a permission set belongs
in, how long a dropdown list should stay cached, etc. Keeping policy out
of the backend means swapping backends never requires touching this
policy, and keeping policy out of scattered business modules means the
whole caching strategy is visible in one file.

Business modules should never import ``InMemoryCacheBackend`` directly --
only ``CacheManager`` (or the raw ``CacheBackend`` interface, for cases
like auth rate-limiting that predate this manager and use bespoke keys).
"""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from app.cache.base import CacheBackend
from app.core.logging import get_logger

T = TypeVar("T")

logger = get_logger(__name__)

# ----------------------------------------------------------------------
# Default TTLs per use case, in seconds. Centralized here so tuning cache
# lifetimes is a one-line change instead of a hunt through every module.
# ----------------------------------------------------------------------
TTL_USER_PERMISSIONS = 300        # 5 minutes -- balances freshness vs. DB load
TTL_USER_ROLES = 300              # 5 minutes
TTL_APP_SETTINGS = 600            # 10 minutes -- settings change rarely
TTL_DROPDOWN_DATA = 900           # 15 minutes -- static reference/lookup lists
TTL_DASHBOARD_COUNTS = 60         # 1 minute -- counts should feel "live"
TTL_RECORD = 300                  # 5 minutes -- generic frequently-accessed record

# Namespaces, used both as key prefixes and as the argument to
# ``delete_namespace`` for bulk invalidation.
NS_USER_PERMISSIONS = "permissions"
NS_USER_ROLES = "roles"
NS_APP_SETTINGS = "settings"
NS_DROPDOWN = "dropdown"
NS_DASHBOARD = "dashboard"
NS_RECORD = "record"

# Master Data modules (countries, states, cities, currencies, uom, hsn,
# brands, product_categories, product_sub_categories) are simple lookup
# tables, so they reuse the existing NS_DROPDOWN namespace/TTL rather than
# adding ten near-identical named helpers here: e.g.
#     await cache_manager.get_dropdown("countries")
#     await cache_manager.set_dropdown("countries", countries)
#     await cache_manager.invalidate_dropdown("countries")
# The dropdown name used by each master matches its table name (see each
# module's ``service.py``).


class CacheManager:
    """
    High-level cache API for business modules.

    Wraps a :class:`CacheBackend` instance (obtained via DI) and exposes
    both a generic ``get_or_set`` helper and named, pre-configured helpers
    for the ERP's standard caching use cases.
    """

    def __init__(self, backend: CacheBackend) -> None:
        """Bind this manager to a concrete cache backend."""
        self._backend = backend

    # ------------------------------------------------------------------
    # Generic developer API (thin passthrough, for arbitrary use cases)
    # ------------------------------------------------------------------

    async def get(self, key: str) -> Any | None:
        """
        Return the cached value for ``key``, or ``None`` on a genuine
        miss OR if the backend itself failed.

        Phase 3 performance/resilience fix: previously a bare passthrough
        to ``self._backend.get(key)`` -- fine for the in-memory backend
        (a plain dict, which essentially never raises), but this
        interface is explicitly designed to be swapped for a real
        networked backend later (Redis, etc. -- see this class's own
        docstring), and a network cache CAN legitimately time out or
        drop a connection. Without this try/except, that failure would
        propagate straight out of a read-through cache lookup and 500 an
        otherwise-healthy request purely because the ACCELERATION layer
        had a blip -- exactly the "cache becomes a single point of
        failure" failure mode Phase 3 explicitly calls out to avoid.
        Treating a backend error the same as a cache miss means every
        caller (including ``get_or_set`` below) transparently falls back
        to whatever it would already do on a miss -- load from the
        database -- with no special-case handling needed at any call site.
        """
        try:
            return await self._backend.get(key)
        except Exception:  # noqa: BLE001 - a cache failure must degrade to "miss", never propagate
            logger.warning("Cache backend .get() failed; treating as a cache miss.", extra={"key": key})
            return None

    async def set(self, key: str, value: Any, *, ttl_seconds: int | None = None) -> None:
        """
        Store ``value`` under ``key`` with an optional TTL.

        Failures are logged and swallowed for the same reason as
        :meth:`get`: a cache WRITE failing must not break the request
        that computed the value being cached -- the value is still
        returned to that request's caller either way (see
        :meth:`get_or_set`); it just won't be cached for next time.
        """
        try:
            await self._backend.set(key, value, ttl_seconds=ttl_seconds)
        except Exception:  # noqa: BLE001
            logger.warning("Cache backend .set() failed; value was not cached.", extra={"key": key})

    async def delete(self, key: str) -> None:
        """
        Remove a single key from the cache.

        Failures are logged and swallowed -- an invalidation that fails
        to reach the cache backend should not block/fail the write
        operation that triggered it (the write to the database already
        succeeded by the time invalidation runs); worst case the cache
        serves a stale entry until its TTL naturally expires.
        """
        try:
            await self._backend.delete(key)
        except Exception:  # noqa: BLE001
            logger.warning("Cache backend .delete() failed.", extra={"key": key})

    async def exists(self, key: str) -> bool:
        """Return True if ``key`` is present and not expired. Returns False (not an exception) if the backend fails."""
        try:
            return await self._backend.exists(key)
        except Exception:  # noqa: BLE001
            logger.warning("Cache backend .exists() failed; treating as absent.", extra={"key": key})
            return False

    async def clear(self) -> None:
        """Remove every entry from the cache. Primarily for tests/admin use."""
        await self._backend.clear()

    async def delete_namespace(self, namespace: str) -> int:
        """
        Delete every key under ``namespace`` (see ``CacheBackend.delete_namespace``).

        Backs every ``invalidate_*`` helper below. Failures are logged
        and swallowed for the same reason as :meth:`delete`: a failed
        invalidation should not block the write operation that triggered
        it. Returns 0 (rather than raising) on failure, matching
        ``CacheBackend.delete_namespace``'s own "0 if nothing to do"
        contract, so a caller checking the returned count can't
        distinguish "genuinely nothing to invalidate" from "the backend
        errored" -- both are safe/inert outcomes for a caller here.
        """
        try:
            return await self._backend.delete_namespace(namespace)
        except Exception:  # noqa: BLE001
            logger.warning("Cache backend .delete_namespace() failed.", extra={"namespace": namespace})
            return 0

    async def get_or_set(
        self,
        key: str,
        loader: Callable[[], Awaitable[T]],
        *,
        ttl_seconds: int | None = None,
    ) -> T:
        """
        Read-through cache helper: return the cached value, or compute-and-cache it.

        This is the pattern almost every caching use case actually wants:

            departments = await cache_manager.get_or_set(
                "departments:all",
                loader=lambda: department_repository.list_all(),
                ttl_seconds=TTL_DEPARTMENTS,
            )

        The ``loader`` is only invoked on a cache miss, so an expensive
        database query only runs when the cache genuinely has nothing to
        offer.

        Routes through :meth:`get`/:meth:`set` (not ``self._backend``
        directly) specifically so a backend failure here gets the same
        fail-safe "treat as a miss, fall through to the database"
        behavior documented on those methods -- a network cache outage
        should make every ``get_or_set`` call temporarily behave like the
        cache is simply always empty, never make it raise.
        """
        cached = await self.get(key)
        if cached is not None:
            return cached
        value = await loader()
        await self.set(key, value, ttl_seconds=ttl_seconds)
        return value

    # ------------------------------------------------------------------
    # Named helpers: User Permissions
    # ------------------------------------------------------------------

    async def get_user_permissions(self, user_id: uuid.UUID | str) -> set[str] | None:
        """Return the cached permission-code set for a user, or None on a miss."""
        return await self.get(CacheBackend.build_key(NS_USER_PERMISSIONS, str(user_id)))

    async def set_user_permissions(self, user_id: uuid.UUID | str, permissions: set[str]) -> None:
        """Cache a user's resolved permission-code set."""
        await self.set(
            CacheBackend.build_key(NS_USER_PERMISSIONS, str(user_id)),
            permissions,
            ttl_seconds=TTL_USER_PERMISSIONS,
        )

    async def invalidate_user_permissions(self, user_id: uuid.UUID | str | None = None) -> int:
        """
        Invalidate one user's cached permissions, or every user's if ``user_id`` is omitted.

        Call this after any role/permission change that could affect a
        user's effective permission set (role assignment, permission
        grant/revoke on a role, etc.).
        """
        if user_id is not None:
            await self.delete(CacheBackend.build_key(NS_USER_PERMISSIONS, str(user_id)))
            return 1
        return await self.delete_namespace(NS_USER_PERMISSIONS)

    # ------------------------------------------------------------------
    # Named helpers: User Roles
    # ------------------------------------------------------------------

    async def get_user_roles(self, user_id: uuid.UUID | str) -> list[str] | None:
        """Return the cached role-name list for a user, or None on a miss."""
        return await self.get(CacheBackend.build_key(NS_USER_ROLES, str(user_id)))

    async def set_user_roles(self, user_id: uuid.UUID | str, roles: list[str]) -> None:
        """Cache a user's assigned role names."""
        await self.set(
            CacheBackend.build_key(NS_USER_ROLES, str(user_id)), roles, ttl_seconds=TTL_USER_ROLES
        )

    async def invalidate_user_roles(self, user_id: uuid.UUID | str | None = None) -> int:
        """Invalidate one user's cached roles, or every user's if ``user_id`` is omitted."""
        if user_id is not None:
            await self.delete(CacheBackend.build_key(NS_USER_ROLES, str(user_id)))
            return 1
        return await self.delete_namespace(NS_USER_ROLES)

    # ------------------------------------------------------------------
    # Named helpers: Application Settings
    # ------------------------------------------------------------------

    async def get_setting(self, setting_key: str) -> Any | None:
        """Return a cached application-setting value, or None on a miss."""
        return await self.get(CacheBackend.build_key(NS_APP_SETTINGS, setting_key))

    async def set_setting(self, setting_key: str, value: Any) -> None:
        """Cache an application-setting value."""
        await self.set(
            CacheBackend.build_key(NS_APP_SETTINGS, setting_key), value, ttl_seconds=TTL_APP_SETTINGS
        )

    async def invalidate_settings(self) -> int:
        """Invalidate every cached application setting (e.g. after an admin updates one)."""
        return await self.delete_namespace(NS_APP_SETTINGS)

    # ------------------------------------------------------------------
    # Named helpers: Dropdown data
    # ------------------------------------------------------------------

    async def get_dropdown(self, dropdown_name: str) -> list[Any] | None:
        """Return cached dropdown/lookup options by name (e.g. 'countries', 'currencies')."""
        return await self.get(CacheBackend.build_key(NS_DROPDOWN, dropdown_name))

    async def set_dropdown(self, dropdown_name: str, options: list[Any]) -> None:
        """Cache a dropdown/lookup option list under a given name."""
        await self.set(
            CacheBackend.build_key(NS_DROPDOWN, dropdown_name), options, ttl_seconds=TTL_DROPDOWN_DATA
        )

    async def invalidate_dropdown(self, dropdown_name: str | None = None) -> int:
        """Invalidate one named dropdown list, or every cached dropdown if omitted."""
        if dropdown_name is not None:
            await self.delete(CacheBackend.build_key(NS_DROPDOWN, dropdown_name))
            return 1
        return await self.delete_namespace(NS_DROPDOWN)

    # ------------------------------------------------------------------
    # Named helpers: Dashboard counts
    # ------------------------------------------------------------------

    async def get_dashboard_count(self, metric_name: str) -> int | None:
        """Return a cached dashboard count metric (e.g. 'active_users'), or None on a miss."""
        return await self.get(CacheBackend.build_key(NS_DASHBOARD, metric_name))

    async def set_dashboard_count(self, metric_name: str, count: int) -> None:
        """Cache a dashboard count metric with a short TTL, since counts should stay near-live."""
        await self.set(
            CacheBackend.build_key(NS_DASHBOARD, metric_name), count, ttl_seconds=TTL_DASHBOARD_COUNTS
        )

    async def invalidate_dashboard_counts(self) -> int:
        """Invalidate all cached dashboard counts."""
        return await self.delete_namespace(NS_DASHBOARD)

    # ------------------------------------------------------------------
    # Named helpers: Generic frequently-accessed records
    # ------------------------------------------------------------------

    async def get_record(self, entity: str, record_id: uuid.UUID | str) -> Any | None:
        """
        Return a cached record by entity type + id, e.g. ``get_record("user", user_id)``.

        A generic escape hatch for "frequently accessed records" that
        don't warrant their own named helper above.
        """
        return await self.get(CacheBackend.build_key(NS_RECORD, entity, str(record_id)))

    async def set_record(self, entity: str, record_id: uuid.UUID | str, value: Any) -> None:
        """Cache a record by entity type + id."""
        await self.set(
            CacheBackend.build_key(NS_RECORD, entity, str(record_id)), value, ttl_seconds=TTL_RECORD
        )

    async def invalidate_record(self, entity: str, record_id: uuid.UUID | str | None = None) -> int:
        """Invalidate one cached record, or every cached record of a given entity type."""
        if record_id is not None:
            await self.delete(CacheBackend.build_key(NS_RECORD, entity, str(record_id)))
            return 1
        return await self.delete_namespace(CacheBackend.build_key(NS_RECORD, entity))