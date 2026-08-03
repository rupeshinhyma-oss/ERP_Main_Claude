"""
Logging Configuration.

Provides a single ``configure_logging()`` entry point, called once at
application startup, that sets up structured (JSON) logging suitable for
ingestion by log aggregators (ELK, Datadog, CloudWatch, etc.) in production,
while remaining human-readable in local development.

Design notes
------------
- We configure the *root* logger so that both our own loggers and
  third-party library loggers (uvicorn, sqlalchemy, etc.) share the same
  format and destination.
- A ``request_id`` field is included in every log record. It defaults to
  ``"-"`` and is populated per-request by :mod:`app.middleware.request_id`
  via a ``contextvars.ContextVar``, so that every log line emitted while
  handling a request can be correlated back to that request without having
  to thread the request ID through every function call manually.
"""

from __future__ import annotations

import logging
import sys
from contextvars import ContextVar
from datetime import datetime, timezone

from pythonjsonlogger import json as jsonlogger

from app.core.config import settings

# ContextVar holding the current request's correlation ID. Populated by the
# RequestIdMiddleware and read here by the logging filter below. Using a
# ContextVar (rather than a global) makes this safe under asyncio, where
# many requests are interleaved on the same thread.
request_id_ctx_var: ContextVar[str] = ContextVar("request_id", default="-")


class RequestIdLogFilter(logging.Filter):
    """Inject the current request's correlation ID into every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        """Attach ``request_id`` to the record; always allow the record through."""
        record.request_id = request_id_ctx_var.get()
        return True


class _JsonFormatter(jsonlogger.JsonFormatter):
    """JSON log formatter with a consistent, production-friendly field set."""

    def add_fields(self, log_record: dict, record: logging.LogRecord, message_dict: dict) -> None:
        """
        Ensure standard fields are always present, correctly populated, and
        consistently named.

        We assign these unconditionally (rather than via ``setdefault``)
        because the base formatter may already have inserted the same keys
        with a ``None`` value when they were referenced in the format
        string but aren't native ``LogRecord`` attributes -- ``setdefault``
        would then never override that ``None``.
        """
        super().add_fields(log_record, record, message_dict)
        log_record["timestamp"] = datetime.fromtimestamp(record.created, tz=timezone.utc).isoformat()
        log_record["level"] = record.levelname
        log_record["logger"] = record.name
        log_record["request_id"] = getattr(record, "request_id", "-")
        log_record["app"] = settings.APP_NAME
        log_record["environment"] = settings.ENVIRONMENT.value


def configure_logging() -> None:
    """
    Configure the root logger for the entire process.

    Idempotent: safe to call more than once (e.g. under test-suite
    re-imports) because it clears existing handlers before adding new ones.
    """
    root_logger = logging.getLogger()
    root_logger.setLevel(settings.LOG_LEVEL.upper())

    # Remove any handlers configured by earlier imports (e.g. uvicorn's
    # default handlers) so we have exactly one, well-defined output format.
    root_logger.handlers.clear()

    handler = logging.StreamHandler(stream=sys.stdout)
    handler.addFilter(RequestIdLogFilter())

    if settings.LOG_JSON:
        formatter: logging.Formatter = _JsonFormatter("%(message)s")
    else:
        formatter = logging.Formatter(
            fmt="%(asctime)s | %(levelname)-8s | req_id=%(request_id)s | %(name)s | %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S%z",
        )

    handler.setFormatter(formatter)
    root_logger.addHandler(handler)

    # Tame noisy third-party loggers while keeping our own at LOG_LEVEL.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(
        logging.INFO if settings.DATABASE_ECHO else logging.WARNING
    )


def get_logger(name: str) -> logging.Logger:
    """
    Return a module-scoped logger.

    Convenience wrapper so call sites write ``get_logger(__name__)`` instead
    of importing ``logging`` directly everywhere, keeping a single point of
    control if the logging backend ever changes.
    """
    return logging.getLogger(name)
