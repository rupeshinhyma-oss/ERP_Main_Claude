"""
Generic Event Dispatcher.

Defines :class:`EventDispatcher`, the ``EventPublisher`` abstraction the
Phase 1 brief calls for (section 11): the ONE thing any future module's
service layer needs to import to announce "something changed" over the
WebSocket infrastructure, without that module needing to know anything
about ``ConnectionManager``, channels, or WebSockets at all.

Contains zero module-specific logic (no mention of "buyer", "planning",
etc. anywhere in this file) -- see the Phase 1 brief section 3: "The
dispatcher must NOT contain Buyers-specific or Planning-specific business
logic." A future module decides for itself which channel(s) its own
events belong on (typically just ``module_channel(<its own name>)`` --
see ``app.events.channels``) and calls :meth:`EventDispatcher.publish`
with that channel name; this dispatcher has no built-in notion of routing
an ``entity`` to a channel automatically, so it never needs updating when
a new module is added.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.events.channels import module_channel
from app.events.manager import ConnectionManager, connection_manager
from app.events.models import Event

logger = get_logger(__name__)


class EventDispatcher:
    """
    Publishes :class:`Event` objects to one or more channels via a
    :class:`app.events.manager.ConnectionManager`.

    Constructed with an explicit ``connection_manager`` (defaulting to the
    process-wide singleton) rather than importing the singleton directly
    inside every method, so tests can construct a dispatcher against an
    isolated ``ConnectionManager`` instance without needing to monkeypatch
    module-level state.
    """

    def __init__(self, manager: ConnectionManager | None = None) -> None:
        self._manager = manager or connection_manager

    async def publish(
        self, channel: str, event: Event, *, exclude_user_id: uuid.UUID | None = None
    ) -> None:
        """
        Publish ``event`` to every connection currently subscribed to
        ``channel``.

        Never raises: a WebSocket delivery failure must never surface as
        an error to whatever business operation triggered the event (the
        REST request already succeeded and its transaction already
        committed by the time this is called -- see the module docstring
        below on ordering). Any unexpected failure is logged and
        swallowed, mirroring the same never-raise contract
        ``app.planning.ws_manager.notify_source_record_changed`` already
        follows for its own broadcast call.

        Callers are responsible for calling this AFTER their database
        transaction has committed (Phase 1 brief section 10: "Do NOT
        broadcast a successful business event before the database
        transaction has successfully committed"). This dispatcher has no
        way to enforce that itself -- it doesn't participate in the
        caller's transaction/session at all -- so it's the caller's job to
        sequence the call correctly. See ``doc/EVENTS_ARCHITECTURE.md``
        for the exact call-site pattern this expects, and this module's
        own docstring for a known existing gap where Planning's current
        broadcast helper does NOT yet follow this ordering.
        """
        try:
            await self._manager.broadcast_to_channel(channel, event, exclude_user_id=exclude_user_id)
        except Exception:  # noqa: BLE001 - publishing a live-update event must never break the request that triggered it
            logger.exception(
                "Event dispatch failed.",
                extra={"channel": channel, "event_type": event.event_type, "event_id": event.event_id},
            )

    async def publish_to_channels(
        self, channels: list[str], event: Event, *, exclude_user_id: uuid.UUID | None = None
    ) -> None:
        """
        Publish the SAME event to several channels at once, e.g. both
        ``module:buyers`` (everyone watching the Buyers list) and
        ``buyer:{id}`` (anyone specifically viewing that one buyer's
        detail page).

        Each channel is dispatched independently -- one channel's failure
        (already swallowed inside :meth:`publish`) never prevents delivery
        to the others.
        """
        for channel in channels:
            await self.publish(channel, event, exclude_user_id=exclude_user_id)

    async def publish_lifecycle_event(
        self,
        session: AsyncSession,
        *,
        module: str,
        entity: str,
        entity_id: uuid.UUID | str,
        event_type: str,
        version: int | None,
        user_id: uuid.UUID,
        changes: dict[str, Any],
    ) -> None:
        """
        Commit ``session``, THEN publish a standard created/updated/deleted
        lifecycle event on ``module_channel(module)``.

        Phase 6: the ONE reusable "commit, then publish" pattern every
        module's create/update/delete route needs -- extracted after
        Buyers (Phase 4) and Planning (Phase 5) had each independently
        hand-written an almost-identical private helper
        (``app.buyers.routes._publish_buyer_event`` and
        ``app.planning.routes._publish_planning_sheet_event``) differing
        ONLY in how each obtained a committable session and which
        hardcoded ``entity``/channel string they used. Both of those
        module-local helpers have been rewritten as thin wrappers around
        THIS method (see either module's ``routes.py``); a future
        module's write-path should call this directly rather than
        re-deriving its own copy of the same nine lines.

        Parameters mirror :class:`app.events.models.Event`'s own fields
        exactly, plus ``module`` (used only to derive the channel via
        ``app.events.channels.module_channel`` -- NOT stored on the
        event itself) and ``session`` (committed here, before publish,
        for the same reason ``Buyer``/``Planning`` needed it: the shared
        ``get_db_session`` dependency defers its own commit until AFTER
        the route handler returns, so publishing before this explicit
        commit would broadcast a change before it's durable -- see the
        Phase 1 brief section 10 and this module's own docstring on
        ordering). A second, later commit from ``get_db_session``'s own
        generator is a safe no-op once there's nothing left pending.

        Like :meth:`publish`, this never raises for a delivery failure
        -- see that method's own docstring. The ``session.commit()``
        call, however, is NOT swallowed: a failed commit is a real
        failure the caller's route needs to see (it means the write
        itself may not be durable), so it propagates normally, exactly
        as an explicit ``db.commit()`` call anywhere else in a route
        would.
        """
        await session.commit()
        event = Event(
            event_type=event_type,
            entity=entity,
            entity_id=str(entity_id),
            version=version,
            user_id=str(user_id),
            changes=changes,
        )
        await self.publish(module_channel(module), event, exclude_user_id=user_id)


# Single process-wide instance, matching every other singleton in this
# module (``connection_manager`` above, and the existing
# ``app.planning.ws_manager.connection_manager``). Application code should
# import THIS object directly (or take it as a constructor argument, for
# services that already receive their dependencies that way) rather than
# constructing its own ``EventDispatcher``.
event_dispatcher = EventDispatcher()