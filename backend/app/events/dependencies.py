"""
Events Module Dependencies.

FastAPI dependency-injection wiring for :mod:`app.events`. Kept separate
from :mod:`app.events.routes` for the same reason every other module in
this codebase separates the two (see e.g. ``app.rbac.dependencies`` vs.
``app.rbac.routes``): dependencies are reusable by other modules without
them needing to import route-handling code.
"""

from __future__ import annotations

from app.events.dispatcher import EventDispatcher, event_dispatcher


def get_event_dispatcher() -> EventDispatcher:
    """
    FastAPI dependency returning the process-wide :class:`EventDispatcher`.

    A future module's routes/services should depend on this (or accept an
    ``EventDispatcher`` constructor argument, for services that already
    receive their dependencies that way -- see ``PlanningService`` for the
    existing pattern) rather than importing ``app.events.dispatcher.event_dispatcher``
    directly, so tests can override this dependency with an isolated
    dispatcher the same way ``get_db_session``/``get_auth_service`` are
    already overridden in this codebase's test fixtures.
    """
    return event_dispatcher
