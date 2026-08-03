"""
Job Handler Registry.

The single place every job handler is registered. A "handler" is an async
function that accepts a payload dict and does the actual work (send an email,
generate a report, sync inventory, etc.).

Future modules register their handlers here by calling ``register()``:

    # In app/notifications/jobs.py (Phase 5+):
    from app.queue.registry import register

    @register("send_welcome_email")
    async def send_welcome_email(payload: dict) -> None:
        user_id = payload["user_id"]
        ...

The worker calls ``get_handler(job_name)`` to look up the function before
executing a job. If no handler is registered for a job_name, the worker
marks the job FAILED immediately with a clear error message, rather than
silently swallowing it.

Design notes:
- Global dict, populated at import time. This is intentional: simple, no
  framework, easy to grep for all registered jobs.
- No class hierarchy, decorators-as-magic, or dynamic imports. Modules
  explicitly import and call ``register()``.
- Thread/async safe for reads (dict lookups are GIL-protected); all
  ``register()`` calls happen at startup before the worker starts.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

# Type alias for a job handler: an async function that receives the payload dict.
JobHandler = Callable[[dict[str, Any]], Awaitable[None]]

_registry: dict[str, JobHandler] = {}


def register(job_name: str) -> Callable[[JobHandler], JobHandler]:
    """
    Decorator that registers an async function as the handler for ``job_name``.

    Usage::

        @register("send_welcome_email")
        async def send_welcome_email(payload: dict) -> None:
            ...
    """
    def decorator(fn: JobHandler) -> JobHandler:
        if job_name in _registry:
            raise ValueError(
                f"A handler for {job_name!r} is already registered. "
                "Each job_name must have exactly one handler."
            )
        _registry[job_name] = fn
        return fn
    return decorator


def get_handler(job_name: str) -> JobHandler | None:
    """Return the handler for ``job_name``, or None if not registered."""
    return _registry.get(job_name)


def list_registered_jobs() -> list[str]:
    """Return a sorted list of every registered job name (for the admin API and docs)."""
    return sorted(_registry.keys())
