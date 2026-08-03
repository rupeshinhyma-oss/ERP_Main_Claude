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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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

    return app


app = create_application()
