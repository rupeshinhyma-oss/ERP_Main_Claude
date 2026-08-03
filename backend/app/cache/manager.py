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

T = TypeVar("T")

# ----------------------------------------------------------------------
# Default TTLs per use case, in seconds. Centralized here so tuning cache
# lifetimes is a one-line change instead of a hunt through every module.
# ----------------------------------------------------------------------
TTL_USER_PERMISSIONS = 300        # 5 minutes -- balances freshness vs. DB load
TTL_USER_ROLES = 300              # 5 minutes
TTL_APP_SETTINGS = 600            # 10 minutes -- settings change rarely
TTL_DEPARTMENTS = 600             # 10 minutes
TTL_DESIGNATIONS = 600            # 10 minutes
TTL_DROPDOWN_DATA = 900           # 15 minutes -- static reference/lookup lists
TTL_DASHBOARD_COUNTS = 60         # 1 minute -- counts should feel "live"
TTL_RECORD = 300                  # 5 minutes -- generic frequently-accessed record

# Namespaces, used both as key prefixes and as the argument to
# ``delete_namespace`` for bulk invalidation.
NS_USER_PERMISSIONS = "permissions"
NS_USER_ROLES = "roles"
NS_APP_SETTINGS = "settings"
NS_DEPARTMENTS = "departments"
NS_DESIGNATIONS = "designations"
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
        """Return the cached value for ``key``, or None if absent/expired."""
        return await self._backend.get(key)

    async def set(self, key: str, value: Any, *, ttl_seconds: int | None = None) -> None:
        """Store ``value`` under ``key`` with an optional TTL."""
        await self._backend.set(key, value, ttl_seconds=ttl_seconds)

    async def delete(self, key: str) -> None:
        """Remove a single key from the cache."""
        await self._backend.delete(key)

    async def exists(self, key: str) -> bool:
        """Return True if ``key`` is present and not expired."""
        return await self._backend.exists(key)

    async def clear(self) -> None:
        """Remove every entry from the cache. Primarily for tests/admin use."""
        await self._backend.clear()

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
        """
        cached = await self._backend.get(key)
        if cached is not None:
            return cached
        value = await loader()
        await self._backend.set(key, value, ttl_seconds=ttl_seconds)
        return value

    # ------------------------------------------------------------------
    # Named helpers: User Permissions
    # ------------------------------------------------------------------

    async def get_user_permissions(self, user_id: uuid.UUID | str) -> set[str] | None:
        """Return the cached permission-code set for a user, or None on a miss."""
        return await self._backend.get(CacheBackend.build_key(NS_USER_PERMISSIONS, str(user_id)))

    async def set_user_permissions(self, user_id: uuid.UUID | str, permissions: set[str]) -> None:
        """Cache a user's resolved permission-code set."""
        await self._backend.set(
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
            await self._backend.delete(CacheBackend.build_key(NS_USER_PERMISSIONS, str(user_id)))
            return 1
        return await self._backend.delete_namespace(NS_USER_PERMISSIONS)

    # ------------------------------------------------------------------
    # Named helpers: User Roles
    # ------------------------------------------------------------------

    async def get_user_roles(self, user_id: uuid.UUID | str) -> list[str] | None:
        """Return the cached role-name list for a user, or None on a miss."""
        return await self._backend.get(CacheBackend.build_key(NS_USER_ROLES, str(user_id)))

    async def set_user_roles(self, user_id: uuid.UUID | str, roles: list[str]) -> None:
        """Cache a user's assigned role names."""
        await self._backend.set(
            CacheBackend.build_key(NS_USER_ROLES, str(user_id)), roles, ttl_seconds=TTL_USER_ROLES
        )

    async def invalidate_user_roles(self, user_id: uuid.UUID | str | None = None) -> int:
        """Invalidate one user's cached roles, or every user's if ``user_id`` is omitted."""
        if user_id is not None:
            await self._backend.delete(CacheBackend.build_key(NS_USER_ROLES, str(user_id)))
            return 1
        return await self._backend.delete_namespace(NS_USER_ROLES)

    # ------------------------------------------------------------------
    # Named helpers: Application Settings
    # ------------------------------------------------------------------

    async def get_setting(self, setting_key: str) -> Any | None:
        """Return a cached application-setting value, or None on a miss."""
        return await self._backend.get(CacheBackend.build_key(NS_APP_SETTINGS, setting_key))

    async def set_setting(self, setting_key: str, value: Any) -> None:
        """Cache an application-setting value."""
        await self._backend.set(
            CacheBackend.build_key(NS_APP_SETTINGS, setting_key), value, ttl_seconds=TTL_APP_SETTINGS
        )

    async def invalidate_settings(self) -> int:
        """Invalidate every cached application setting (e.g. after an admin updates one)."""
        return await self._backend.delete_namespace(NS_APP_SETTINGS)

    # ------------------------------------------------------------------
    # Named helpers: Departments / Designations / Dropdown data
    # ------------------------------------------------------------------

    async def get_departments(self) -> list[Any] | None:
        """Return the cached department list, or None on a miss."""
        return await self._backend.get(CacheBackend.build_key(NS_DEPARTMENTS, "all"))

    async def set_departments(self, departments: list[Any]) -> None:
        """Cache the full department list."""
        await self._backend.set(
            CacheBackend.build_key(NS_DEPARTMENTS, "all"), departments, ttl_seconds=TTL_DEPARTMENTS
        )

    async def invalidate_departments(self) -> int:
        """Invalidate the cached department list (call after any department create/update/delete)."""
        return await self._backend.delete_namespace(NS_DEPARTMENTS)

    async def get_designations(self) -> list[Any] | None:
        """Return the cached designation list, or None on a miss."""
        return await self._backend.get(CacheBackend.build_key(NS_DESIGNATIONS, "all"))

    async def set_designations(self, designations: list[Any]) -> None:
        """Cache the full designation list."""
        await self._backend.set(
            CacheBackend.build_key(NS_DESIGNATIONS, "all"), designations, ttl_seconds=TTL_DESIGNATIONS
        )

    async def invalidate_designations(self) -> int:
        """Invalidate the cached designation list."""
        return await self._backend.delete_namespace(NS_DESIGNATIONS)

    async def get_dropdown(self, dropdown_name: str) -> list[Any] | None:
        """Return cached dropdown/lookup options by name (e.g. 'countries', 'currencies')."""
        return await self._backend.get(CacheBackend.build_key(NS_DROPDOWN, dropdown_name))

    async def set_dropdown(self, dropdown_name: str, options: list[Any]) -> None:
        """Cache a dropdown/lookup option list under a given name."""
        await self._backend.set(
            CacheBackend.build_key(NS_DROPDOWN, dropdown_name), options, ttl_seconds=TTL_DROPDOWN_DATA
        )

    async def invalidate_dropdown(self, dropdown_name: str | None = None) -> int:
        """Invalidate one named dropdown list, or every cached dropdown if omitted."""
        if dropdown_name is not None:
            await self._backend.delete(CacheBackend.build_key(NS_DROPDOWN, dropdown_name))
            return 1
        return await self._backend.delete_namespace(NS_DROPDOWN)

    # ------------------------------------------------------------------
    # Named helpers: Dashboard counts
    # ------------------------------------------------------------------

    async def get_dashboard_count(self, metric_name: str) -> int | None:
        """Return a cached dashboard count metric (e.g. 'active_users'), or None on a miss."""
        return await self._backend.get(CacheBackend.build_key(NS_DASHBOARD, metric_name))

    async def set_dashboard_count(self, metric_name: str, count: int) -> None:
        """Cache a dashboard count metric with a short TTL, since counts should stay near-live."""
        await self._backend.set(
            CacheBackend.build_key(NS_DASHBOARD, metric_name), count, ttl_seconds=TTL_DASHBOARD_COUNTS
        )

    async def invalidate_dashboard_counts(self) -> int:
        """Invalidate all cached dashboard counts."""
        return await self._backend.delete_namespace(NS_DASHBOARD)

    # ------------------------------------------------------------------
    # Named helpers: Generic frequently-accessed records
    # ------------------------------------------------------------------

    async def get_record(self, entity: str, record_id: uuid.UUID | str) -> Any | None:
        """
        Return a cached record by entity type + id, e.g. ``get_record("user", user_id)``.

        A generic escape hatch for "frequently accessed records" that
        don't warrant their own named helper above.
        """
        return await self._backend.get(CacheBackend.build_key(NS_RECORD, entity, str(record_id)))

    async def set_record(self, entity: str, record_id: uuid.UUID | str, value: Any) -> None:
        """Cache a record by entity type + id."""
        await self._backend.set(
            CacheBackend.build_key(NS_RECORD, entity, str(record_id)), value, ttl_seconds=TTL_RECORD
        )

    async def invalidate_record(self, entity: str, record_id: uuid.UUID | str | None = None) -> int:
        """Invalidate one cached record, or every cached record of a given entity type."""
        if record_id is not None:
            await self._backend.delete(CacheBackend.build_key(NS_RECORD, entity, str(record_id)))
            return 1
        return await self._backend.delete_namespace(CacheBackend.build_key(NS_RECORD, entity))
