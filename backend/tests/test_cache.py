"""
Phase 5 Cache Tests.

Unit-level tests for InMemoryCacheBackend, CacheManager, and the cleanup
worker. These use only in-memory objects (real event loop, real clock via
``time.monotonic``) -- no database or external service is required.
"""

from __future__ import annotations

from app.cache.base import CacheBackend
from app.cache.cleanup import BackgroundCleanupWorker
from app.cache.in_memory import InMemoryCacheBackend
from app.cache.manager import CacheManager

# pytest.ini sets asyncio_mode = auto, so plain `async def test_*` methods
# below are collected and run automatically -- no per-test marker needed,
# consistent with the rest of this test suite (see tests/test_queue.py).


# ---------------------------------------------------------------------------
# CacheBackend.build_key
# ---------------------------------------------------------------------------


class TestBuildKey:
    """Tests for the namespaced key-building helper."""

    def test_build_key_single_part(self):
        """A single part is joined with the namespace using a colon."""
        assert CacheBackend.build_key("permissions", "user-1") == "permissions:user-1"

    def test_build_key_multiple_parts(self):
        """Multiple parts are all colon-joined in order."""
        assert CacheBackend.build_key("roles", "role-1", "permissions") == "roles:role-1:permissions"


# ---------------------------------------------------------------------------
# InMemoryCacheBackend: core operations
# ---------------------------------------------------------------------------


class TestInMemoryCacheCore:
    """Tests for get/set/delete/exists/clear on the in-memory backend."""

    async def test_set_then_get_returns_value(self):
        """A value stored via set() should be retrievable via get()."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", {"a": 1})
        assert await cache.get("k1") == {"a": 1}

    async def test_get_missing_key_returns_none(self):
        """get() on a key that was never set should return None."""
        cache = InMemoryCacheBackend()
        assert await cache.get("nope") is None

    async def test_delete_removes_key(self):
        """delete() should make a subsequent get() return None."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")
        await cache.delete("k1")
        assert await cache.get("k1") is None

    async def test_delete_missing_key_is_noop(self):
        """Deleting a key that doesn't exist should not raise."""
        cache = InMemoryCacheBackend()
        await cache.delete("nope")  # should not raise

    async def test_exists_true_for_present_key(self):
        """exists() should return True for a key that is currently cached."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")
        assert await cache.exists("k1") is True

    async def test_exists_false_for_missing_key(self):
        """exists() should return False for a key that was never cached."""
        cache = InMemoryCacheBackend()
        assert await cache.exists("nope") is False

    async def test_clear_empties_the_cache(self):
        """clear() should remove every entry."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")
        await cache.set("k2", "v2")
        await cache.clear()
        assert await cache.get("k1") is None
        assert await cache.get("k2") is None

    async def test_set_overwrites_existing_key(self):
        """Setting an already-cached key should overwrite its value."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "first")
        await cache.set("k1", "second")
        assert await cache.get("k1") == "second"

    async def test_falsy_values_are_cached_correctly(self):
        """Falsy-but-not-None values (0, '', False, []) must round-trip correctly."""
        cache = InMemoryCacheBackend()
        await cache.set("zero", 0)
        await cache.set("empty_str", "")
        await cache.set("false", False)
        await cache.set("empty_list", [])
        assert await cache.get("zero") == 0
        assert await cache.get("empty_str") == ""
        assert await cache.get("false") is False
        assert await cache.get("empty_list") == []


# ---------------------------------------------------------------------------
# InMemoryCacheBackend: TTL expiration
# ---------------------------------------------------------------------------


class TestTTLExpiration:
    """Tests for per-key TTL expiration."""

    async def test_key_expires_after_ttl(self, monkeypatch):
        """A key set with a short TTL should be gone once that TTL elapses."""
        cache = InMemoryCacheBackend()
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("k1", "v1", ttl_seconds=10)
        assert await cache.get("k1") == "v1"

        fake_time[0] += 11  # advance past the TTL
        assert await cache.get("k1") is None

    async def test_key_without_ttl_never_expires(self, monkeypatch):
        """A key set with no TTL should still be present after a long time."""
        cache = InMemoryCacheBackend()
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("k1", "v1")
        fake_time[0] += 100_000
        assert await cache.get("k1") == "v1"

    async def test_default_ttl_applied_when_not_specified(self, monkeypatch):
        """A backend-level default_ttl_seconds should apply when set() omits ttl_seconds."""
        cache = InMemoryCacheBackend(default_ttl_seconds=10)
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("k1", "v1")
        fake_time[0] += 11
        assert await cache.get("k1") is None

    async def test_explicit_ttl_overrides_default(self, monkeypatch):
        """An explicit ttl_seconds on set() should override the backend default."""
        cache = InMemoryCacheBackend(default_ttl_seconds=5)
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("k1", "v1", ttl_seconds=100)
        fake_time[0] += 6  # past the default, but not the explicit TTL
        assert await cache.get("k1") == "v1"

    async def test_sweep_expired_removes_stale_entries(self, monkeypatch):
        """sweep_expired() should proactively remove entries whose TTL has elapsed."""
        cache = InMemoryCacheBackend()
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("expires_soon", "v1", ttl_seconds=5)
        await cache.set("lives_forever", "v2")

        fake_time[0] += 10
        removed = await cache.sweep_expired()

        assert removed == 1
        assert cache.stats.total_items == 1  # only "lives_forever" remains


# ---------------------------------------------------------------------------
# InMemoryCacheBackend: statistics
# ---------------------------------------------------------------------------


class TestCacheStatistics:
    """Tests for hit/miss/eviction/expiry counters."""

    async def test_hit_and_miss_counts(self):
        """Hits and misses should be tracked separately."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")

        await cache.get("k1")  # hit
        await cache.get("k1")  # hit
        await cache.get("missing")  # miss

        assert cache.stats.hits == 2
        assert cache.stats.misses == 1
        assert cache.stats.total_requests == 3

    async def test_hit_rate_pct(self):
        """hit_rate_pct should reflect hits / total_requests as a percentage."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")
        await cache.get("k1")
        await cache.get("missing")
        assert cache.stats.hit_rate_pct == 50.0

    async def test_sets_and_deletes_counted(self):
        """sets and deletes counters should increment on each respective call."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")
        await cache.set("k2", "v2")
        await cache.delete("k1")
        assert cache.stats.sets == 2
        assert cache.stats.deletes == 1
        assert cache.stats.total_items == 1

    async def test_clear_resets_stats(self):
        """clear() should reset all statistics counters to zero."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "v1")
        await cache.get("k1")
        await cache.clear()
        assert cache.stats.hits == 0
        assert cache.stats.sets == 0
        assert cache.stats.total_items == 0

    async def test_estimated_bytes_nonzero_after_set(self):
        """estimated_bytes should be > 0 once at least one entry is cached."""
        cache = InMemoryCacheBackend()
        await cache.set("k1", "some reasonably sized value")
        assert cache.stats.estimated_bytes > 0


# ---------------------------------------------------------------------------
# InMemoryCacheBackend: LRU eviction / max_size
# ---------------------------------------------------------------------------


class TestLRUEviction:
    """Tests for the max_size cap and LRU eviction policy."""

    async def test_eviction_when_max_size_exceeded(self, monkeypatch):
        """Adding a new key beyond max_size should evict the least-recently-used entry."""
        cache = InMemoryCacheBackend(max_size=2)
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("k1", "v1")
        fake_time[0] += 1
        await cache.set("k2", "v2")
        fake_time[0] += 1
        await cache.set("k3", "v3")  # should evict k1 (least recently used)

        assert await cache.get("k1") is None
        assert await cache.get("k2") == "v2"
        assert await cache.get("k3") == "v3"
        assert cache.stats.evictions == 1

    async def test_get_refreshes_lru_order(self, monkeypatch):
        """Accessing a key via get() should protect it from being the next LRU eviction."""
        cache = InMemoryCacheBackend(max_size=2)
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("k1", "v1")
        fake_time[0] += 1
        await cache.set("k2", "v2")
        fake_time[0] += 1
        await cache.get("k1")  # k1 is now more recently used than k2
        fake_time[0] += 1
        await cache.set("k3", "v3")  # should evict k2, not k1

        assert await cache.get("k1") == "v1"
        assert await cache.get("k2") is None

    async def test_max_size_zero_disables_eviction(self):
        """max_size=0 (the default) should never evict entries."""
        cache = InMemoryCacheBackend(max_size=0)
        for i in range(50):
            await cache.set(f"k{i}", i)
        assert cache.stats.evictions == 0
        assert cache.stats.total_items == 50


# ---------------------------------------------------------------------------
# InMemoryCacheBackend: namespace deletion
# ---------------------------------------------------------------------------


class TestNamespaceDeletion:
    """Tests for bulk namespace invalidation."""

    async def test_delete_namespace_removes_matching_keys_only(self):
        """delete_namespace() should remove only keys under that namespace."""
        cache = InMemoryCacheBackend()
        await cache.set(CacheBackend.build_key("permissions", "u1"), {"a"})
        await cache.set(CacheBackend.build_key("permissions", "u2"), {"b"})
        await cache.set(CacheBackend.build_key("settings", "all"), [1, 2, 3])

        removed = await cache.delete_namespace("permissions")

        assert removed == 2
        assert await cache.get(CacheBackend.build_key("permissions", "u1")) is None
        assert await cache.get(CacheBackend.build_key("permissions", "u2")) is None
        assert await cache.get(CacheBackend.build_key("settings", "all")) == [1, 2, 3]

    async def test_delete_namespace_with_no_matches_returns_zero(self):
        """delete_namespace() on an unused namespace should return 0 and not raise."""
        cache = InMemoryCacheBackend()
        assert await cache.delete_namespace("nonexistent") == 0


# ---------------------------------------------------------------------------
# CacheManager
# ---------------------------------------------------------------------------


class TestCacheManager:
    """Tests for the high-level CacheManager developer API."""

    async def test_get_or_set_calls_loader_only_on_miss(self):
        """get_or_set() should call the loader on a miss and cache its result."""
        cache = InMemoryCacheBackend()
        manager = CacheManager(cache)
        calls = {"count": 0}

        async def loader():
            calls["count"] += 1
            return "computed-value"

        first = await manager.get_or_set("k1", loader, ttl_seconds=60)
        second = await manager.get_or_set("k1", loader, ttl_seconds=60)

        assert first == "computed-value"
        assert second == "computed-value"
        assert calls["count"] == 1  # loader only invoked once (second call was a hit)

    async def test_user_permissions_round_trip(self):
        """Named permission helpers should cache and invalidate correctly."""
        manager = CacheManager(InMemoryCacheBackend())
        await manager.set_user_permissions("user-1", {"user.create", "user.read"})

        assert await manager.get_user_permissions("user-1") == {"user.create", "user.read"}

        await manager.invalidate_user_permissions("user-1")
        assert await manager.get_user_permissions("user-1") is None

    async def test_invalidate_all_user_permissions(self):
        """Omitting user_id from invalidate_user_permissions should clear every user's cache."""
        manager = CacheManager(InMemoryCacheBackend())
        await manager.set_user_permissions("user-1", {"a"})
        await manager.set_user_permissions("user-2", {"b"})

        removed = await manager.invalidate_user_permissions()

        assert removed == 2
        assert await manager.get_user_permissions("user-1") is None
        assert await manager.get_user_permissions("user-2") is None

    async def test_dropdown_named_lookup(self):
        """Dropdown helper should key by the dropdown's own name."""
        manager = CacheManager(InMemoryCacheBackend())
        await manager.set_dropdown("countries", ["US", "IN"])
        await manager.set_dropdown("currencies", ["USD", "INR"])

        assert await manager.get_dropdown("countries") == ["US", "IN"]
        assert await manager.get_dropdown("currencies") == ["USD", "INR"]

        await manager.invalidate_dropdown("countries")
        assert await manager.get_dropdown("countries") is None
        assert await manager.get_dropdown("currencies") == ["USD", "INR"]

    async def test_dashboard_count_round_trip(self):
        """Dashboard count helper should store and retrieve integer metrics."""
        manager = CacheManager(InMemoryCacheBackend())
        await manager.set_dashboard_count("active_users", 42)
        assert await manager.get_dashboard_count("active_users") == 42

    async def test_generic_record_helpers(self):
        """Generic record helpers should namespace by entity type + id."""
        manager = CacheManager(InMemoryCacheBackend())
        await manager.set_record("user", "u1", {"name": "Alice"})
        await manager.set_record("user", "u2", {"name": "Bob"})

        assert await manager.get_record("user", "u1") == {"name": "Alice"}

        await manager.invalidate_record("user", "u1")
        assert await manager.get_record("user", "u1") is None
        assert await manager.get_record("user", "u2") == {"name": "Bob"}

        await manager.invalidate_record("user")  # clear all users
        assert await manager.get_record("user", "u2") is None


class TestCacheManagerFailureFallback:
    """
    Phase 3 resilience tests: a backend failure must degrade to
    "cache miss"/no-op, never propagate and break the caller.

    Uses a small backend double whose methods raise on demand, rather
    than InMemoryCacheBackend (which has no way to simulate a failure --
    a plain dict essentially never raises), to prove CacheManager's own
    try/except wrapping actually works, independent of which concrete
    backend is plugged in.
    """

    class _FlakyCacheBackend(CacheBackend):
        """A backend whose every method raises, simulating e.g. a dropped Redis connection."""

        async def get(self, key: str):
            raise ConnectionError("simulated cache backend outage")

        async def set(self, key: str, value, *, ttl_seconds=None) -> None:
            raise ConnectionError("simulated cache backend outage")

        async def delete(self, key: str) -> None:
            raise ConnectionError("simulated cache backend outage")

        async def exists(self, key: str) -> bool:
            raise ConnectionError("simulated cache backend outage")

        async def clear(self) -> None:
            raise ConnectionError("simulated cache backend outage")

        async def delete_namespace(self, namespace: str) -> int:
            raise ConnectionError("simulated cache backend outage")

    async def test_get_failure_returns_none_instead_of_raising(self):
        """A failing backend.get() must surface as a miss (None), not an exception."""
        manager = CacheManager(self._FlakyCacheBackend())
        result = await manager.get("some-key")
        assert result is None

    async def test_set_failure_is_swallowed(self):
        """A failing backend.set() must not raise -- the value simply isn't cached."""
        manager = CacheManager(self._FlakyCacheBackend())
        await manager.set("some-key", "some-value")  # must not raise

    async def test_delete_failure_is_swallowed(self):
        """A failing backend.delete() must not raise."""
        manager = CacheManager(self._FlakyCacheBackend())
        await manager.delete("some-key")  # must not raise

    async def test_exists_failure_returns_false(self):
        """A failing backend.exists() must surface as False, not an exception."""
        manager = CacheManager(self._FlakyCacheBackend())
        assert await manager.exists("some-key") is False

    async def test_delete_namespace_failure_returns_zero(self):
        """A failing backend.delete_namespace() must surface as 0, not an exception."""
        manager = CacheManager(self._FlakyCacheBackend())
        assert await manager.delete_namespace("some-namespace") == 0

    async def test_get_or_set_falls_through_to_loader_when_backend_is_down(self):
        """
        With the cache backend entirely down, get_or_set() must still
        return a correct value by falling through to the loader --
        i.e. the ERP keeps working (degraded to "always a cache miss"),
        exactly as if there were simply no cache at all.
        """
        manager = CacheManager(self._FlakyCacheBackend())
        calls = {"count": 0}

        async def loader():
            calls["count"] += 1
            return "value-from-database"

        result = await manager.get_or_set("k1", loader, ttl_seconds=60)

        assert result == "value-from-database"
        assert calls["count"] == 1

    async def test_named_helpers_degrade_gracefully_when_backend_is_down(self):
        """
        Every named helper (permissions, dropdown, departments, etc.)
        routes through the same hardened get/set/delete -- spot-check a
        few to confirm none of them bypass the fallback and raise.
        """
        manager = CacheManager(self._FlakyCacheBackend())

        assert await manager.get_user_permissions("u1") is None
        await manager.set_user_permissions("u1", {"a"})  # must not raise
        # Always returns 1 when a user_id is given (by design -- see
        # invalidate_user_permissions's own implementation), regardless
        # of whether the underlying delete succeeded; the point here is
        # just that calling it with a down backend must not raise.
        assert await manager.invalidate_user_permissions("u1") == 1

        assert await manager.get_dropdown("countries") is None
        await manager.set_dropdown("countries", ["US"])  # must not raise
        assert await manager.get_dashboard_count("metric") is None


# ---------------------------------------------------------------------------
# BackgroundCleanupWorker
# ---------------------------------------------------------------------------


class TestCleanupWorker:
    """Tests for the periodic cleanup worker lifecycle and sweep behavior."""

    async def test_start_and_stop(self):
        """start()/stop() should toggle is_running correctly."""
        cache = InMemoryCacheBackend()
        worker = BackgroundCleanupWorker(cache, interval_seconds=60)
        assert worker.is_running is False

        await worker.start()
        assert worker.is_running is True

        await worker.stop()
        assert worker.is_running is False

    async def test_double_start_is_noop(self):
        """Calling start() twice should not create a second task."""
        cache = InMemoryCacheBackend()
        worker = BackgroundCleanupWorker(cache, interval_seconds=60)
        await worker.start()
        first_task = worker._task
        await worker.start()
        assert worker._task is first_task
        await worker.stop()

    async def test_run_once_sweeps_expired_entries(self, monkeypatch):
        """run_once() should perform an immediate sweep without waiting for the interval."""
        cache = InMemoryCacheBackend()
        fake_time = [1000.0]
        monkeypatch.setattr("app.cache.in_memory.time.monotonic", lambda: fake_time[0])

        await cache.set("expires_soon", "v1", ttl_seconds=5)
        fake_time[0] += 10

        worker = BackgroundCleanupWorker(cache, interval_seconds=3600)
        removed = await worker.run_once()
        assert removed == 1