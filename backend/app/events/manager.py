"""
Generic WebSocket Connection + Subscription Manager.

Generalizes the proven design of ``app.planning.ws_manager.PlanningConnectionManager``
(one in-process dict of open sockets, best-effort broadcast, dead-socket
cleanup) from "one bucket per sheet" to "one bucket per logical channel",
so any future module can reuse the exact same connect/subscribe/broadcast
machinery instead of writing its own manager (Phase 1 brief section 4:
"Use the existing Planning WebSocket implementation if it already contains
useful functionality... instead of creating a duplicate system").

Kept intentionally in-process (a plain dict, no external broker) for the
same reason ``PlanningConnectionManager`` is: this ERP runs as a single
FastAPI process today (see ``app.queue.worker`` for the same
single-process assumption elsewhere). See the module docstring on
:class:`ConnectionManager` for how this stays swappable later without a
rewrite (Phase 1 brief section 11).

Does NOT replace ``app.planning.ws_manager`` -- Planning keeps its own
manager and its own ``/planning/sheets/{sheet_id}/live`` route, untouched,
per the brief's "do not destroy working Planning functionality". This is
new, separate infrastructure for every OTHER module to use going forward,
and a candidate for Planning to migrate onto in a later integration phase.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field

from fastapi import WebSocket

from app.core.logging import get_logger
from app.events.models import Event

logger = get_logger(__name__)


@dataclass
class _Connection:
    """One open WebSocket, the user it belongs to, and which channels it's currently subscribed to."""

    websocket: WebSocket
    user_id: uuid.UUID
    channels: set[str] = field(default_factory=set)


class ConnectionManager:
    """
    Tracks open WebSocket connections and their channel subscriptions,
    and fans out events to whichever connections are subscribed to a
    given channel.

    Swappability (Phase 1 brief section 11): every method here is a
    plain async function operating on in-process state. A future
    multi-process deployment could replace this class's internals with a
    thin wrapper around a shared pub/sub (Redis, etc.) -- publish here
    would push to the shared bus instead of iterating a local dict, and a
    per-process subscriber task would call the same ``_send`` path for
    events arriving from OTHER processes -- WITHOUT changing this class's
    public method signatures, and therefore without changing
    :mod:`app.events.dispatcher` or any route/service that calls it. That
    replacement is explicitly not built now (no Redis/Kafka/etc. added in
    Phase 1); this paragraph documents the seam where it would go.
    """

    def __init__(self) -> None:
        self._connections: dict[WebSocket, _Connection] = {}
        # channel -> set of websockets currently subscribed to it. Kept as
        # a separate reverse index (rather than scanning every connection
        # on every broadcast) so broadcasting to a channel with many
        # connections stays O(subscribers to that channel), not
        # O(every connection the process has ever seen).
        self._channel_subscribers: dict[str, set[WebSocket]] = {}

    # --- connection lifecycle ------------------------------------------------

    async def connect(self, websocket: WebSocket, user_id: uuid.UUID) -> None:
        """
        Accept a new WebSocket connection and register it (with no channel
        subscriptions yet -- see :meth:`subscribe`).

        Safe to call once per socket. A user opening a second tab (or a
        second browser) gets a second, independent entry here -- exactly
        like ``PlanningConnectionManager``, connections are keyed by socket
        object, never by user, so "duplicate connections from the same
        user" (Phase 1 brief section 12) are simply two ordinary entries
        rather than a special case to detect/reject.
        """
        await websocket.accept()
        self._connections[websocket] = _Connection(websocket=websocket, user_id=user_id)
        logger.info("WebSocket connected.", extra={"user_id": str(user_id)})

    def disconnect(self, websocket: WebSocket) -> None:
        """
        Remove a closed/dropped connection and every channel subscription
        it held.

        Safe to call multiple times for the same socket (e.g. once from
        the route's ``finally`` block and once from dead-socket cleanup
        inside :meth:`broadcast_to_channel`) -- a second call is simply a
        no-op, so cleanup code never needs to track "did I already remove
        this one" itself (Phase 1 brief section 12: "must not leak
        WebSocket connections or subscriptions after disconnect").
        """
        connection = self._connections.pop(websocket, None)
        if connection is None:
            return
        for channel in connection.channels:
            subscribers = self._channel_subscribers.get(channel)
            if subscribers is None:
                continue
            subscribers.discard(websocket)
            if not subscribers:
                self._channel_subscribers.pop(channel, None)
        logger.info(
            "WebSocket disconnected.",
            extra={"user_id": str(connection.user_id), "channels": sorted(connection.channels)},
        )

    def is_connected(self, websocket: WebSocket) -> bool:
        """True if this socket is still tracked as open."""
        return websocket in self._connections

    # --- subscriptions --------------------------------------------------------

    def subscribe(self, websocket: WebSocket, channel: str) -> None:
        """
        Subscribe an already-connected socket to ``channel``.

        Idempotent (subscribing twice to the same channel is a no-op, not
        an error) and raises :class:`KeyError` if ``websocket`` was never
        registered via :meth:`connect` -- callers (see
        ``app.events.routes``) are expected to have already run the
        channel's permission check (see
        ``app.events.channels.permission_required_for_channel``) before
        calling this; this method itself only manages bookkeeping, not
        authorization, so it stays reusable regardless of what a future
        permission model looks like.
        """
        connection = self._connections[websocket]
        connection.channels.add(channel)
        self._channel_subscribers.setdefault(channel, set()).add(websocket)

    def unsubscribe(self, websocket: WebSocket, channel: str) -> None:
        """Unsubscribe a socket from ``channel``. Safe to call even if it wasn't subscribed."""
        connection = self._connections.get(websocket)
        if connection is not None:
            connection.channels.discard(channel)
        subscribers = self._channel_subscribers.get(channel)
        if subscribers is not None:
            subscribers.discard(websocket)
            if not subscribers:
                self._channel_subscribers.pop(channel, None)

    def channels_for(self, websocket: WebSocket) -> set[str]:
        """Every channel ``websocket`` is currently subscribed to (empty set if not connected)."""
        connection = self._connections.get(websocket)
        return set(connection.channels) if connection is not None else set()

    def subscriber_count(self, channel: str) -> int:
        """How many open connections are currently subscribed to ``channel``."""
        return len(self._channel_subscribers.get(channel, ()))

    # --- broadcasting --------------------------------------------------------

    async def broadcast_to_channel(
        self, channel: str, event: Event, *, exclude_user_id: uuid.UUID | None = None
    ) -> int:
        """
        Send ``event`` to every connection currently subscribed to ``channel``.

        ``exclude_user_id`` (optional) skips connections belonging to that
        user -- the same "don't echo a change back to the tab that made
        it" pattern ``PlanningConnectionManager.broadcast`` uses, since
        that tab's own REST response already reflects the change. Every
        OTHER connection of that same user (e.g. a second browser tab)
        still receives the event, matching Planning's existing behavior.

        A send failure on one socket (Phase 1 brief section 13: "one
        broken WebSocket client to break broadcasting to other clients")
        is caught, that socket is torn down via :meth:`disconnect`, and
        every other subscriber is still attempted -- mirroring
        ``PlanningConnectionManager.broadcast``'s dead-socket handling
        exactly.

        Returns the number of connections the event was actually sent to
        (post-failure), mainly useful for tests/diagnostics.
        """
        subscribers = self._channel_subscribers.get(channel)
        if not subscribers:
            return 0

        payload = event.to_dict()
        sent = 0
        dead: list[WebSocket] = []
        for websocket in list(subscribers):
            connection = self._connections.get(websocket)
            if connection is None:
                # Stale entry (shouldn't normally happen -- disconnect()
                # clears both structures together -- but treat it as dead
                # rather than trusting an inconsistent index).
                dead.append(websocket)
                continue
            if exclude_user_id is not None and connection.user_id == exclude_user_id:
                continue
            try:
                await websocket.send_json(payload)
                sent += 1
            except Exception:  # noqa: BLE001 - a broken socket must not break delivery to any other subscriber
                logger.warning(
                    "Failed to deliver event to a WebSocket subscriber; disconnecting it.",
                    extra={"channel": channel, "event_type": event.event_type},
                )
                dead.append(websocket)

        for websocket in dead:
            self.disconnect(websocket)

        return sent

    async def send_to_websocket(self, websocket: WebSocket, message: dict) -> bool:
        """
        Send an arbitrary JSON-serializable control message (e.g. a
        subscribe/unsubscribe acknowledgment, or an error) directly to one
        socket, bypassing channels entirely.

        Returns ``False`` (rather than raising) if the send fails, so a
        route handler can decide whether that means the connection should
        be torn down without every call site needing its own try/except.
        """
        try:
            await websocket.send_json(message)
            return True
        except Exception:  # noqa: BLE001
            return False


# Single process-wide instance. Every route/service that needs to publish
# or manage connections imports this same object -- exactly the pattern
# ``app.planning.ws_manager.connection_manager`` already establishes, kept
# consistent here rather than introducing dependency-injected app state
# for what is, in both cases, genuinely process-wide singleton state.
connection_manager = ConnectionManager()
