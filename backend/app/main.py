"""
Application Entry Point.

Defines :func:`create_application`, the single FastAPI app factory used by
both the ASGI server (``uvicorn app.main:app``) and the test suite (which
can call ``create_application()`` directly to get a fresh app instance with
overridden settings/dependencies).

Startup/shutdown behavior, middleware order, CORS, exception handlers, and
router mounting are all wired together here and ONLY here, so the
composition root of the application is easy to find and reason about.
"""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.v1.router import api_router
from app.cache.dependency import get_cleanup_worker
from app.core.config import settings
from app.core.exception_handlers import register_exception_handlers
from app.core.logging import configure_logging, get_logger
from app.database.engine import dispose_engine, get_engine
from app.middleware.audit_middleware import AuditMiddleware
from app.middleware.logging_middleware import AccessLogMiddleware
from app.middleware.request_id import RequestIdMiddleware
from app.queue.worker import get_worker

logger = get_logger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    Manage application startup and shutdown.

    Startup:
        - Configure structured logging before anything else logs.
        - Refuse to boot in production with a placeholder JWT secret.
        - Eagerly create the database engine (rather than lazily on first
          request) so connectivity problems surface immediately at boot,
          not on a random user's first request.
        - Start the background queue worker so jobs are processed immediately.
        - Start the background cache cleanup worker so expired cache
          entries are reclaimed even if nothing ever reads them again.

    Shutdown:
        - Gracefully stop the background queue worker (waits for the
          currently-executing job to finish before stopping).
        - Stop the background cache cleanup worker.
        - Dispose of the database engine's connection pool cleanly.

    This is the correct, modern replacement for FastAPI's deprecated
    ``@app.on_event("startup")`` / ``@app.on_event("shutdown")`` decorators.
    """
    configure_logging()
    logger.info(
        "Application starting up.",
        extra={"environment": settings.ENVIRONMENT.value, "version": settings.APP_VERSION},
    )

    # Refuse to boot in production with a placeholder JWT secret. This was
    # previously defined but never invoked anywhere -- a real security gap,
    # since it meant a production deployment could silently run with the
    # well-known default signing key.
    settings.validate_production_secrets()

    # Eagerly initialize the engine to fail fast on misconfiguration.
    get_engine()

    # Start the background queue worker (Phase 4).
    worker = get_worker()
    await worker.start()

    # Start the background cache cleanup worker (Phase 5).
    cleanup_worker = get_cleanup_worker()
    await cleanup_worker.start()

    yield

    logger.info("Application shutting down.")

    # Gracefully drain the queue worker before closing the DB pool.
    await worker.stop()

    # Stop the cache cleanup worker.
    await cleanup_worker.stop()

    await dispose_engine()


def create_application() -> FastAPI:
    """
    Build and configure the FastAPI application instance.

    Kept as a factory function (rather than a bare module-level ``app =
    FastAPI()``) so tests and future entry points (e.g. a management CLI)
    can construct isolated app instances on demand.
    """
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        docs_url=settings.DOCS_URL,
        redoc_url=settings.REDOC_URL,
        openapi_url=settings.OPENAPI_URL,
        lifespan=lifespan,
    )

    # ---------------------------------------------------------------
    # Middleware registration.
    #
    # Starlette wraps middleware in the order added, so the LAST one
    # added runs FIRST on the way in (and last on the way out). We add
    # CORS last so it is the outermost layer, correctly handling
    # preflight requests before anything else executes. AuditMiddleware
    # is added before RequestIdMiddleware so the request ID is already
    # set on request.state by the time the audit entry is written.
    # ---------------------------------------------------------------
    app.add_middleware(AccessLogMiddleware)
    app.add_middleware(AuditMiddleware)
    app.add_middleware(RequestIdMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_allowed_origins_list,
        allow_credentials=settings.CORS_ALLOW_CREDENTIALS,
        allow_methods=settings.cors_allowed_methods_list,
        allow_headers=settings.cors_allowed_headers_list,
    )

    register_exception_handlers(app)

    app.include_router(api_router, prefix=settings.API_V1_PREFIX)

    uploads_dir = Path("uploads")
    uploads_dir.mkdir(exist_ok=True)
    (uploads_dir / "products").mkdir(exist_ok=True)
    app.mount("/uploads", StaticFiles(directory=uploads_dir), name="uploads")

    # ---------------------------------------------------------------
    # Optional same-origin frontend serving.
    #
    # Off unless FRONTEND_DIST_DIR is set, so local development (API and
    # Vite dev server as two separate processes, see
    # frontend/vite.config.ts's proxy) is completely unaffected. Registered
    # last, after every API route, so a same-origin deploy still can't have
    # the SPA fallback shadow an API path -- FastAPI resolves routes in
    # registration order, and the mount below only ever answers requests
    # that fell through everything above it.
    # ---------------------------------------------------------------
    _mount_frontend(app)

    return app


def _mount_frontend(app: FastAPI) -> None:
    """
    Serve the built React app from the same origin as the API, if configured.

    Two pieces:
      - `/assets` (Vite's hashed JS/CSS output) mounted as plain static files,
        so the browser can cache them aggressively.
      - a catch-all GET route that returns `index.html` for any other
        unmatched path, which is what makes client-side routes like
        `/masters/products` survive a hard refresh -- without this, the
        browser asks the server for that exact path, the server has no such
        route, and the SPA never gets a chance to load and take over routing.

    Silently does nothing if `FRONTEND_DIST_DIR` is unset or the directory
    doesn't exist, so a misconfigured path fails at first request (a clear
    404) rather than at import time.
    """
    if not settings.FRONTEND_DIST_DIR:
        return

    dist_dir = Path(settings.FRONTEND_DIST_DIR)
    index_file = dist_dir / "index.html"
    assets_dir = dist_dir / "assets"

    if not dist_dir.is_dir() or not index_file.is_file():
        logger.warning(
            "FRONTEND_DIST_DIR is set but no built frontend was found there; "
            "the API will run without serving the SPA.",
            extra={"frontend_dist_dir": str(dist_dir)},
        )
        return

    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(request: Request, full_path: str) -> FileResponse:
        """
        Serve a specific static file if one exists at this path (favicon,
        manifest, etc.), otherwise fall back to `index.html` so the SPA's own
        router can resolve the URL client-side. Never intercepts `/api/*`,
        `/docs`, `/redoc`, `/openapi.json`, or `/health/*` -- those are all
        registered above and matched first.
        """
        candidate = dist_dir / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)

        if not index_file.is_file():
            raise HTTPException(status_code=404, detail="Not Found")

        return FileResponse(index_file)


app = create_application()
