# ERP Backend — Phase 1: Project Foundation

A production-grade foundation for a modular-monolith ERP backend, built with
FastAPI, SQLAlchemy 2.x (async), Alembic, and PostgreSQL.

**Phase 1 scope:** foundation only. No authentication, no users, no ERP
business modules. Every architectural seam needed for those (config,
database, DI, base repository/service, middleware, standard responses,
exception handling, migrations, cache/queue abstractions) is in place so
Phase 2+ can add features without touching this layer.

---

## 1. Why this folder structure

```
erp_backend/
├── app/
│   ├── main.py              # composition root: app factory, lifespan, middleware wiring
│   ├── core/                # framework-level concerns, no feature-module dependencies
│   │   ├── config.py            # env-driven Settings (single source of truth)
│   │   ├── logging.py            # structured JSON logging + request-ID correlation
│   │   ├── exceptions.py         # domain exception hierarchy (framework-agnostic)
│   │   ├── exception_handlers.py # translates exceptions -> standard HTTP envelope
│   │   ├── responses.py          # standard success/error response envelope
│   │   └── health.py             # liveness/readiness business logic
│   ├── database/             # SQLAlchemy engine, session, declarative base
│   │   ├── engine.py             # process-wide async engine + pool
│   │   ├── session.py            # per-request AsyncSession dependency
│   │   └── base.py               # DeclarativeBase + UUID/timestamp/soft-delete mixins
│   ├── middleware/            # ASGI middleware, one responsibility each
│   │   ├── request_id.py         # correlation ID generation/propagation
│   │   └── logging_middleware.py # structured access logging
│   ├── common/                 # generic, reusable base classes (DRY across modules)
│   │   ├── base_repository.py    # generic async CRUD repository
│   │   ├── base_service.py       # generic service layer
│   │   └── pagination.py         # shared paging request/response schemas
│   ├── cache/                  # cache abstraction — swap to Redis with 1 file change
│   ├── queue/                  # background-task abstraction — swap to Celery later
│   ├── api/v1/                 # versioned route wiring only (no business logic)
│   ├── auth/ users/ departments/ organizations/
│   │   notifications/ reports/         # RESERVED empty modules for Phase 6+
│   │   audit/                          # Phase 3: audit trail (model, service, middleware, admin API)
│   └── __init__.py
├── alembic/                  # migration environment, wired to app.core.config + Base.metadata
├── tests/                    # pytest + httpx ASGI smoke tests
├── requirements.txt
├── alembic.ini
├── pytest.ini
├── .env.example
└── .gitignore
```

**Why isolate feature modules like this?** Each future module
(`app.departments`, `app.users`, ...) will own its own `models.py`,
`schemas.py`, `repository.py`, `service.py`, `routes.py`. Modules depend
downward on `app.core` / `app.database` / `app.common`, never sideways on
each other directly — this is what keeps a "modular monolith" actually
modular instead of a ball of mud, while still deploying as one process.

**Why separate `core` from `common`?** `core` is *framework/application*
plumbing (config, logging, the exception hierarchy) that has no notion of
"a database model." `common` is *data-layer* plumbing (base repository/
service) that is generic over ORM models. Both are dependency-free of
feature modules, but they solve different problems and would otherwise
become a dumping ground if merged.

**Why does `main.py` do so little?** It is the *composition root* — the one
place allowed to know about every other piece and wire them together. Every
other file has a narrow, single responsibility. If you need to understand
"how does this app start up," `main.py` is the only file you need to read.

---

## 2. Key architectural decisions

- **Standard response envelope** (`app/core/responses.py`): every endpoint
  returns `{success, data, meta, error}`, so API clients write one response
  parser instead of one per endpoint. Errors return the same shape via the
  global exception handlers — a client never has to special-case error
  parsing.

- **Domain exceptions vs. HTTPException**: services/repositories raise
  framework-agnostic exceptions (`NotFoundException`, `ConflictException`,
  ...) rather than `fastapi.HTTPException`. This keeps business logic
  reusable outside of HTTP (a future CLI, a queue worker) and centralizes
  "how does an error become an HTTP response" in exactly one file
  (`exception_handlers.py`).

- **Repository + Service base classes**: `BaseRepository[ModelT]` is the
  only layer allowed to build SQLAlchemy queries. `BaseService[ModelT]`
  contains orchestration/business-rule logic and depends on a repository,
  never on the ORM directly. Routes depend on services, never on
  repositories directly. This is a strict onion: `routes -> services ->
  repositories -> database`.

- **UUID primary keys + soft delete + UTC timestamps** (`app/database/base.py`):
  every model gets these via mixins, not by hand, so every table is
  consistent without repeated boilerplate. `deleted_at` is respected
  automatically by `BaseRepository` — soft-deleted rows never leak into
  normal queries.

- **Async session lifecycle** (`app/database/session.py`): a request's
  `AsyncSession` auto-commits on success, auto-rolls-back on any exception,
  and always closes — this policy exists in exactly one place.

- **Request correlation** (`app/middleware/request_id.py` +
  `app/core/logging.py`): a `ContextVar` carries the current request's ID
  into every log line without threading it through function signatures,
  and the same ID is echoed on the `X-Request-ID` response header and
  embedded in the response envelope's `meta`.

- **Cache/Queue abstractions ready for Redis/Celery**
  (`app/cache/`, `app/queue/`): Phase 1 ships an in-memory cache and an
  in-process (asyncio) task queue behind small abstract interfaces
  (`CacheBackend`, `TaskQueue`). Adding Redis or Celery later means adding
  one new backend file and one branch in the corresponding `dependency.py`
  factory — no call site anywhere else in the codebase changes.

- **API versioning**: all routes mount under `settings.API_V1_PREFIX`
  (`/api/v1`). Adding `/api/v2` later means adding an `app/api/v2/` package
  and mounting it in `main.py` — v1 contracts never change underneath
  existing clients.

- **UTC internally, always**: every timestamp column uses
  `DateTime(timezone=True)` and Python's timezone-aware `datetime.now(timezone.utc)`.
  The application never stores or compares naive datetimes.

- **Fail-fast startup**: the database engine is created eagerly during
  the `lifespan` startup hook (not lazily on first request), so a
  misconfigured `DATABASE_URL` or unreachable database surfaces
  immediately in the deploy logs, not on a random user's first request.

---

## 3. Running locally

### Prerequisites
- Python 3.13+ (developed/tested against 3.12 as well)
- A running PostgreSQL 14+ instance

### Setup

```bash
# 1. Create and activate a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
cp .env.example .env
# edit .env -> set DATABASE_URL to point at your Postgres instance

# 4. Create the database + user (example, adjust to your setup)
psql -c "CREATE USER erp_user WITH PASSWORD 'erp_password';"
psql -c "CREATE DATABASE erp_db OWNER erp_user;"

# 5. Run migrations (currently a no-op baseline — no tables yet in Phase 1)
alembic upgrade head

# 6. Start the app
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Verify it's running

```bash
curl http://localhost:8000/api/v1/health/live
curl http://localhost:8000/api/v1/health/ready   # includes a real DB round-trip
```

Interactive API docs: http://localhost:8000/docs

### Running tests

```bash
pytest -v
```

Tests spin up the FastAPI app in-process via `httpx.ASGITransport` (no real
socket) and exercise the health endpoints, including a real database
round-trip through `/health/ready` — a reachable Postgres instance matching
`DATABASE_URL` is required.

### Creating a new migration (Phase 2+)

Once feature modules add ORM models, import their `models` module in
`alembic/env.py` (see the comment block there), then:

```bash
alembic revision --autogenerate -m "add departments table"
alembic upgrade head
```

---

## 4. What's intentionally NOT here yet

Per Phase 1 scope: authentication, JWT, users, and all ERP business modules
(departments, organizations, audit, notifications, reports) are **reserved,
empty packages** with docstrings describing their planned structure. This
was verified by actually running the application end-to-end against a real
PostgreSQL instance — startup, health checks (including live DB
connectivity), structured logging, the global error envelope, and Alembic
upgrade/downgrade all confirmed working — before considering Phase 1 done.

---

## Phase 4 — Built-in Queue System

### Overview

Phase 4 adds a **database-backed background job queue** that executes work
asynchronously without blocking API requests. No external broker (Redis,
RabbitMQ, Celery) is required — everything runs inside this single ERP
process.

```
FastAPI request
     ↓
QueueService.create_job()    — stores job row in queue_jobs table
     ↓
BackgroundWorker (asyncio)   — polls table, claims job atomically
     ↓
JobHandler (registered fn)   — executes the actual work
     ↓
QueueRepository              — writes COMPLETED / FAILED / retry
```

### New Files

| File | Purpose |
|------|---------|
| `app/queue/constants.py` | `JobStatus` and `JobPriority` enums |
| `app/queue/models.py` | `QueueJob` ORM model (`queue_jobs` table) |
| `app/queue/repository.py` | `QueueRepository` — DB access only |
| `app/queue/service.py` | `QueueService` — all business logic |
| `app/queue/worker.py` | `BackgroundWorker` — asyncio poll loop |
| `app/queue/registry.py` | Job handler registry (`@register` decorator) |
| `app/queue/schemas.py` | Pydantic request/response schemas |
| `app/queue/routes.py` | REST API for job management |
| `app/queue/dependencies.py` | FastAPI DI wiring |
| `alembic/versions/a1b2c3d4e5f6_phase4_queue_jobs.py` | Migration |

### Database Table: `queue_jobs`

| Column | Type | Description |
|--------|------|-------------|
| `id` | UUID | Primary key |
| `job_name` | string | Handler name (matched to registry) |
| `module` | string | Owning feature module |
| `payload` | text (JSON) | Arguments passed to the handler |
| `priority` | int | LOW=1, NORMAL=5, HIGH=10 |
| `status` | enum | PENDING → RUNNING → COMPLETED / FAILED / CANCELLED |
| `retry_count` | int | Attempts so far |
| `max_retries` | int | Max attempts before permanent failure |
| `run_at` | datetime | Earliest execution time (supports scheduling) |
| `started_at` | datetime | When worker claimed the job |
| `completed_at` | datetime | When execution finished |
| `error_message` | text | Last error / traceback |
| `created_by` | UUID FK | User who enqueued (null = system) |
| `created_at` | datetime | Row creation time |
| `updated_at` | datetime | Last update time |

### API Endpoints

All endpoints require the `settings.manage` permission.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/queue/jobs` | Enqueue a new job |
| `GET` | `/api/v1/queue/jobs` | List jobs (filter by status/module) |
| `GET` | `/api/v1/queue/jobs/{id}` | Get a single job |
| `POST` | `/api/v1/queue/jobs/{id}/cancel` | Cancel a PENDING job |
| `POST` | `/api/v1/queue/jobs/{id}/retry` | Re-queue a FAILED/CANCELLED job |
| `GET` | `/api/v1/queue/stats` | Status counts |
| `GET` | `/api/v1/queue/registered-jobs` | List registered handler names |
| `GET` | `/api/v1/queue/worker/status` | Worker heartbeat |

### Retry Strategy

Failed jobs are retried with **exponential backoff**:

```
delay = 30s × 2^(retry_count)
# retry 1 → 30 s
# retry 2 → 60 s
# retry 3 → 120 s
```

After `max_retries` attempts the job is permanently marked `FAILED`.

### Registering a Job Handler (Phase 5+)

```python
# In app/notifications/jobs.py
from app.queue.registry import register

@register("send_welcome_email")
async def send_welcome_email(payload: dict) -> None:
    user_id = payload["user_id"]
    # ... send the email ...
```

Then enqueue it from any service:

```python
await queue_service.create_job(
    job_name="send_welcome_email",
    module="notifications",
    payload={"user_id": str(user.id)},
    priority=JobPriority.HIGH,
)
```

### Run the Migration

```bash
alembic upgrade head
```

### Worker Lifecycle

The worker is started automatically in `app.main.lifespan` on application
startup and stopped gracefully on shutdown. It polls the database every
0.5 s when jobs are flowing, backing off to 30 s max when idle.

---

## Phase 5 — Built-in Memory Cache

### Overview

Phase 5 adds a **lightweight, in-process memory cache** for frequently
accessed data — user permissions, roles, application settings,
departments, designations, dropdown/lookup data, dashboard counts, and
other frequently-read records. No external cache service (Redis,
Memcached) is used or required; everything runs inside the same Python
process as the web server, in a plain dictionary guarded by an
`asyncio.Lock`.

```
Application
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
```

### Features

- **TTL expiration** — every `set()` accepts an optional `ttl_seconds`;
  expired entries are removed both lazily (on the next `get()`) and
  proactively by a background cleanup worker.
- **Configurable, optional LRU eviction** — set `CACHE_MAX_SIZE` to cap
  the number of entries; the least-recently-used entry is evicted first
  when the cap is hit. `0` (the default) disables the cap.
- **Automatic cleanup worker** — `BackgroundCleanupWorker` sweeps expired
  entries every `CACHE_CLEANUP_INTERVAL_SECONDS` (default 60s), started
  and stopped in `app.main.lifespan` alongside the Phase 4 queue worker.
- **Statistics** — hits, misses, sets, deletes, evictions, expired items,
  current item count, and estimated memory usage, all tracked in
  `CacheStats` and exposed via the admin API.
- **Namespace invalidation** — `cache.delete_namespace("permissions")`
  clears every key under a prefix in one call, so a role/permission
  change can invalidate every affected user's cache without tracking
  individual keys.

### Developer API

Business modules should depend on `CacheManager` (not a concrete backend)
via `Depends(get_cache_manager)`:

```python
from app.cache.dependency import get_cache_manager
from app.cache.manager import CacheManager

async def list_departments(
    cache_manager: CacheManager = Depends(get_cache_manager),
    department_repo: DepartmentRepository = Depends(get_department_repository),
):
    return await cache_manager.get_or_set(
        "departments:all",
        loader=lambda: department_repo.list_all(),
        ttl_seconds=600,
    )
```

Named helpers are available for every use case out of the box:

```python
await cache_manager.set_user_permissions(user_id, permission_codes)
await cache_manager.get_user_permissions(user_id)
await cache_manager.invalidate_user_permissions(user_id)   # or omit user_id to clear everyone

await cache_manager.set_departments(departments)
await cache_manager.get_departments()
await cache_manager.invalidate_departments()

await cache_manager.set_dropdown("countries", options)
await cache_manager.set_dashboard_count("active_users", 42)
await cache_manager.set_record("user", user_id, user_dict)
```

For bespoke key patterns (as `app.auth.service` already does for login
rate limiting), depend on the raw `CacheBackend` interface instead:

```python
from app.cache.base import CacheBackend
from app.cache.dependency import get_cache

async def foo(cache: CacheBackend = Depends(get_cache)):
    key = CacheBackend.build_key("my_namespace", some_id)
    await cache.set(key, value, ttl_seconds=300)
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `CACHE_BACKEND` | `in_memory` | Active backend. Only `in_memory` is implemented; `redis` is a documented future extension point. |
| `CACHE_MAX_SIZE` | `10000` | Max entries before LRU eviction. `0` disables the cap. |
| `CACHE_DEFAULT_TTL_SECONDS` | *(none)* | TTL applied when `set()` doesn't specify its own. Blank/unset = entries live forever unless a TTL is given explicitly. |
| `CACHE_CLEANUP_INTERVAL_SECONDS` | `60` | How often the background worker sweeps expired entries. |

### Admin / Monitoring API

All routes require the `settings.manage` permission:

```
GET    /api/v1/cache/stats              # hits, misses, hit rate, item count, estimated memory
GET    /api/v1/cache/keys               # list every currently cached key
GET    /api/v1/cache/keys/{key}         # inspect one key's TTL/size without its value
DELETE /api/v1/cache/flush              # clear the entire cache
DELETE /api/v1/cache/namespace/{name}   # clear one namespace (e.g. "permissions")
```

### Non-goals (by design)

No persistence (cache is lost on restart), no replication, no clustering,
no pub/sub, no distributed invalidation across processes. If a
multi-instance deployment later needs a shared cache, swap in Redis by
implementing `RedisCacheBackend(CacheBackend)` in
`app/cache/redis_backend.py` and adding one branch to the factory in
`app/cache/dependency.py` — no other file in the codebase needs to change.

### Run the Tests

```bash
pytest tests/test_cache.py -v
```
