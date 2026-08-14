"""
Generic Live Event Model.

Defines :class:`Event`, the single event shape every current and future
module uses to describe "something changed" over the WebSocket
infrastructure (see ``app.events.manager``/``app.events.dispatcher``).

This is intentionally the ONLY event type in the system. There is no
``BuyerEvent``, ``SupplierEvent``, ``PlanningEvent``, etc. -- a module
identifies itself via the plain ``entity`` string field (e.g. ``"buyer"``),
not via a subclass. This is what keeps the dispatcher/connection-manager
below completely module-agnostic (per the Phase 1 brief: "The dispatcher
must NOT contain Buyers-specific or Planning-specific business logic").

Deliberately NOT used by the existing Shipment Planning WebSocket
(``app.planning.ws_manager``) yet -- that module already has its own
proven, working event shape (``{"type": ..., "payload": ...}``) that its
frontend already parses. Migrating Planning onto this generic model is
module-integration work for a later phase, not Phase 1.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


def new_event_id() -> str:
    """
    Generate a new unique event ID.

    A plain ``uuid4`` hex string prefixed ``evt_`` (matching the
    ``evt_unique_id`` shape from the Phase 1 brief) rather than a bare
    UUID, so an event ID is visually distinguishable from an entity ID
    in logs -- e.g. ``entity_id`` and ``event_id`` next to each other
    in a log line would otherwise both just look like random UUIDs.
    """
    return f"evt_{uuid.uuid4().hex}"


@dataclass(frozen=True, slots=True)
class Event:
    """
    A single, self-contained description of "something changed", ready to
    hand to :class:`app.events.dispatcher.EventDispatcher`.

    Fields
    ------
    event_id:
        Globally unique ID for this specific event occurrence (NOT the
        entity's ID). Lets a future frontend deduplicate an event it may
        have already processed (e.g. received once over the WebSocket and
        once via an optimistic REST response) -- see Phase 1 brief
        section 9. Defaults to a fresh :func:`new_event_id` if omitted, so
        most callers never need to construct one manually.
    event_type:
        Dotted ``"{entity}.{action}"`` string, e.g. ``"buyer.updated"``,
        matching this codebase's existing permission-code convention
        (``"buyer.read"``, ``"planning.sheet.manage"``, ...) so the two
        stay easy to reason about side by side. Not machine-validated
        against a fixed enum on purpose -- Phase 1 is infrastructure, not
        a registry of every event every future module will ever emit;
        keeping this a plain string is what lets a brand-new module start
        publishing events without editing this file.
    entity:
        The module/domain the event belongs to, e.g. ``"buyer"``,
        ``"supplier"``, ``"planning"``. Matches the module segment of
        ``event_type`` by convention (not enforced) and is what
        :mod:`app.events.channels` uses to route the event to
        ``module:{entity}`` subscribers.
    entity_id:
        The specific record the event is about, as a string (not a
        ``uuid.UUID``) since not every future module necessarily keys its
        records by UUID, and the frontend only ever needs to compare it
        against another string it already has -- narrowing the type here
        would be a module-specific assumption leaking into shared
        infrastructure.
    version:
        The entity's version/revision number AFTER this change, if the
        owning module tracks one (see Phase 1 brief section 8). ``None``
        for modules that don't version their records; the frontend
        (Phase 2) is expected to treat "no version" as "always apply this
        event" rather than attempting stale-event comparison.
    timestamp:
        When the event was created, always UTC. Defaults to "now" so most
        callers never set this manually.
    user_id:
        The user whose action caused this event, as a string, or ``None``
        for system-initiated changes (e.g. a scheduled job). Kept as
        ``str`` for the same cross-module-flexibility reason as
        ``entity_id``.
    changes:
        A small, module-defined payload -- typically just the fields that
        changed (e.g. ``{"buyer_grade": "A"}``), NOT a full re-serialization
        of the entire record. Keeping this intentionally free-form (rather
        than a typed schema) is what lets every future module describe its
        own changes without this core model needing a per-module variant;
        see the Phase 1 brief's "no module-specific implementation inside
        the core event model" and "do not send huge payloads unnecessarily".
    """

    event_type: str
    entity: str
    entity_id: str
    event_id: str = field(default_factory=new_event_id)
    version: int | None = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    user_id: str | None = None
    changes: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        """
        Serialize to a plain JSON-ready dict, e.g. for ``WebSocket.send_json``
        or a queue payload.

        ``timestamp`` is rendered as an ISO-8601 string (with explicit UTC
        offset) rather than left as a ``datetime`` -- ``json.dumps``/
        Starlette's ``send_json`` cannot serialize a raw ``datetime`` on
        their own, and every other timestamp already crossing an API
        boundary in this codebase (e.g. ``PlanningChangeLogRead``) is
        serialized the same way via Pydantic's ``mode="json"``.
        """
        return {
            "event_id": self.event_id,
            "event_type": self.event_type,
            "entity": self.entity,
            "entity_id": self.entity_id,
            "version": self.version,
            "timestamp": self.timestamp.isoformat(),
            "user_id": self.user_id,
            "changes": self.changes,
        }
