# Merge Notes

This zip merges all four uploads into a single, consistent project tree.

## What I found in each upload
- **`erp_backend.zip`** — an early Phase 1 skeleton (stub `app/auth`, no
  `app/rbac`, older `config.py`/`router.py`). Fully superseded by
  `erp_backend_phase2.zip`, which contains everything this one has plus the
  real auth/rbac/users implementation. **Not used** in the merge — kept
  only as a reference; nothing in it was missing from the Phase 2 build.
- **`erp_backend_phase2.zip`** — the complete Phase 1 + Phase 2 application
  (auth, rbac, users, database, middleware, core, the Phase 2 Alembic
  migration). Used as the **base** for the merge.
- **`erp_phase2_5_common.zip`** and **`erp_phase2_5_common (1).zip`** — two
  identical copies of the Phase 2.5 upgrade layer (generic
  pagination/search/sort/dynamic-filter framework, a richer exception
  hierarchy, and a richer response envelope). Only one copy was merged in
  (they were byte-identical).

There was no separate frontend upload in this batch — none of the four
zips contained any `.html`/`.js`/`.css`/frontend files, so this deliverable
is backend-only.

## How the merge was done
Every Phase 2.5 common file was mapped to its real destination path (the
zip itself is flat, without the `app/...` subdirectory structure) and used
to replace/add the matching file in the Phase 2 base:

| Phase 2.5 file | Merged to |
|---|---|
| `auth_service.py` | `app/auth/service.py` (replace) |
| `base_repository.py` | `app/common/base_repository.py` (replace, **see fix below**) |
| `base_service.py` | `app/common/base_service.py` (replace — was already identical) |
| `config.py` | `app/core/config.py` (replace) |
| `constants.py` | `app/core/constants.py` (**new file**) |
| `exceptions.py` | `app/core/exceptions.py` (replace) |
| `exception_handlers.py` | `app/core/exception_handlers.py` (replace) |
| `filtering.py` | `app/common/filtering.py` (**new file**) |
| `list_query.py` | `app/common/list_query.py` (**new file**) |
| `pagination.py` | `app/common/pagination.py` (replace) |
| `responses.py` | `app/core/responses.py` (replace) |
| `search.py` | `app/common/search.py` (**new file**) |
| `sorting.py` | `app/common/sorting.py` (**new file**) |

I verified every cross-file dependency after merging:
- Every `from app.core.exceptions import ...` across the whole app resolves
  against the new exception hierarchy (added `BadRequestException`,
  `TooManyRequestsException`, etc.) — no missing names.
- Every `settings.<FIELD>` referenced by the new `pagination.py`/
  `sorting.py` (`DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `DEFAULT_SORT_ORDER`)
  exists in the new `config.py`.
- The old `PageMeta`/`PageParams` field names weren't referenced anywhere
  else in the codebase, so replacing them with the Phase 2.5 shapes
  (`total_records`, `current_page`, `as_meta_dict()`, etc.) is a safe,
  non-breaking swap.
- The whole tree passes `py_compile`/`ast.parse` with no syntax errors.

## One bug fixed during the merge
`app/common/base_repository.py`, as uploaded, already had a `TYPE_CHECKING`
import of `ListQueryParams` and a class docstring instructing callers to
"call `paginated_list()`" — but the method itself was never implemented.
Since `filtering.py`/`list_query.py`/`search.py`/`sorting.py` only make
sense together with that method, I implemented `paginated_list()` (plus its
`_apply_search`/`_apply_dynamic_filters`/`_apply_sort` helpers) so the
Phase 2.5 list-query framework is actually usable end-to-end, rather than
leaving a documented-but-missing method in the merged deliverable. This is
the only functional addition beyond a straight merge — everything else is
exactly what was in your uploads, just placed in the correct file paths.

## Not included
No frontend files were present in any of the four uploads, and no Phase 3
audit module — `app/audit/` is still the empty, reserved stub from the
Phase 1 base.

---

# Phase 5 Merge — Built-in Memory Cache

Phase 5 replaces the Phase 1 `app/cache/` stub with a full, production
in-memory cache module, merged into the Phase 4 codebase with zero
breaking changes to existing call sites.

## What changed

| File | Status |
|---|---|
| `app/cache/base.py` | Interface unchanged — `CacheBackend` keeps the exact `get/set/delete/exists/clear/build_key` contract Phase 1 had, so `app/auth/service.py` and `app/auth/dependencies.py` needed zero code changes. Added an optional `delete_namespace()` hook. |
| `app/cache/in_memory.py` | Rewritten. Adds TTL expiration, optional `max_size` with LRU eviction, statistics, namespace deletion. |
| `app/cache/statistics.py` | New. `CacheStats` dataclass: hits, misses, sets, deletes, evictions, expired_items, total_items, estimated_bytes, derived `hit_rate_pct`. |
| `app/cache/cleanup.py` | New. `BackgroundCleanupWorker`, same start/stop lifecycle shape as `app/queue/worker.py`. |
| `app/cache/manager.py` | New. `CacheManager` developer API: generic `get_or_set()` plus named helpers for permissions, roles, settings, departments, designations, dropdown data, dashboard counts, generic records. |
| `app/cache/dependency.py` | Extended: `get_cache_manager()`, `get_cleanup_worker()` added alongside the existing `get_cache()` factory. |
| `app/cache/schemas.py`, `app/cache/routes.py` | New. Admin API (`GET /cache/stats`, `/cache/keys`, `DELETE /cache/flush`, `/cache/namespace/{name}`), gated by `settings.manage`, same pattern as `app/rbac/routes.py`. |
| `app/core/config.py` | Added `CACHE_MAX_SIZE`, `CACHE_DEFAULT_TTL_SECONDS`, `CACHE_CLEANUP_INTERVAL_SECONDS`. |
| `app/main.py` | `lifespan()` starts/stops the cleanup worker alongside the queue worker. |
| `app/api/v1/router.py` | One new `include_router(cache_router)` line. |
| `.env.example` | New `CACHE_*` variables documented. |
| `tests/test_cache.py` | New. TTL, LRU, stats, namespace invalidation, manager helpers, worker lifecycle — using a fake clock so tests are instant. |

## Why the interface didn't change
`app/auth/service.py` and `app/auth/dependencies.py` already depended only
on `CacheBackend.get/set/build_key` and `Depends(get_cache)`. Since
`InMemoryCacheBackend` still implements that exact interface, those two
files required no changes at all.

## Verified after merging
- Every `from app.cache...` import across the codebase resolves against
  the new module with no missing names.
- `CacheBackend.build_key` is byte-identical to Phase 1, so existing
  `login_rate_limit:<identifier>` keys are unaffected.
- The whole tree passes `py_compile` with no syntax errors. The core cache
  logic (TTL expiry, LRU eviction, namespace deletion, stats, manager
  helpers, cleanup-worker start/stop) was exercised directly in an
  isolated sandbox, since this environment has no network access to
  install `fastapi`/`pydantic` and run the full `pytest` suite.
- Cache routes are appended after the existing four routers, so no
  existing route path or ordering changed.

## Not included
No Redis/Memcached/external cache dependency was added — this is a
zero-dependency, in-process cache, per the brief. A `redis_backend.py`
extension point is documented in `app/cache/dependency.py` for a future
phase, but is not implemented.
