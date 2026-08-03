"""
Cache Backend Interface.

Defines the contract every cache implementation must satisfy. This is the
ONLY thing business modules should depend on -- never a concrete class.

The interface is deliberately kept small:
    get / set / delete / exists / clear

so that both the built-in InMemoryCacheBackend and a future Redis client
can satisfy it without leaking backend-specific details into shared code.

The static helper ``build_key`` centralizes key construction so every
namespace follows the same ``namespace:part1:part2`` convention, preventing
silent key collisions between modules.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class CacheBackend(ABC):
    """Abstract interface for a key-value cache with optional per-key TTL."""

    # ------------------------------------------------------------------
    # Core operations
    # ------------------------------------------------------------------

    @abstractmethod
    async def get(self, key: str) -> Any | None:
        """Return the cached value for ``key``, or None if absent/expired."""
        raise NotImplementedError

    @abstractmethod
    async def set(self, key: str, value: Any, *, ttl_seconds: int | None = None) -> None:
        """Store ``value`` under ``key``, expiring after ``ttl_seconds`` if given."""
        raise NotImplementedError

    @abstractmethod
    async def delete(self, key: str) -> None:
        """Remove ``key`` from the cache (no-op if absent)."""
        raise NotImplementedError

    @abstractmethod
    async def exists(self, key: str) -> bool:
        """Return True if ``key`` is present and not expired."""
        raise NotImplementedError

    @abstractmethod
    async def clear(self) -> None:
        """Remove ALL entries from the cache. Use with care in production."""
        raise NotImplementedError

    # ------------------------------------------------------------------
    # Key-building helpers
    # ------------------------------------------------------------------

    @staticmethod
    def build_key(namespace: str, *parts: str) -> str:
        """
        Build a consistently-namespaced cache key.

        Example::

            CacheBackend.build_key("permissions", user_id)
            -> "permissions:<user_id>"

            CacheBackend.build_key("roles", role_id, "permissions")
            -> "roles:<role_id>:permissions"

        Centralizing key construction here avoids ad-hoc string formatting
        and accidental namespace collisions between modules.
        """
        return ":".join([namespace, *parts])

    # ------------------------------------------------------------------
    # Namespace operations (optional -- concrete classes may override)
    # ------------------------------------------------------------------

    async def delete_namespace(self, namespace: str) -> int:
        """
        Delete all keys whose name starts with ``namespace:``.

        Default implementation is a no-op that returns 0. Concrete
        backends that can efficiently delete a namespace (e.g. Redis with
        SCAN + DEL) should override this.

        Returns the number of keys deleted.
        """
        return 0
