"""
Disabled / No-Op Cache Backend.

Used when ``settings.CACHE_BACKEND`` is set to "disabled", "none", or "off".
Bypasses in-memory caching entirely so that all read queries hit PostgreSQL
directly, ensuring live database updates are always immediately visible.
"""

from __future__ import annotations

from typing import Any

from app.cache.base import CacheBackend


class DisabledCacheBackend(CacheBackend):
    """A no-op cache backend that never stores or returns cached items."""

    async def get(self, key: str) -> Any | None:
        """Always returns None, forcing a database lookup."""
        return None

    async def set(self, key: str, value: Any, *, ttl_seconds: int | None = None) -> None:
        """No-op."""
        pass

    async def delete(self, key: str) -> None:
        """No-op."""
        pass

    async def exists(self, key: str) -> bool:
        """Always returns False."""
        return False

    async def clear(self) -> None:
        """No-op."""
        pass

    async def delete_namespace(self, namespace: str) -> int:
        """Always returns 0."""
        return 0
