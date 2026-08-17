"""
Live-update broadcast hub for the Shipment Planning grid.

Every browser tab viewing a sheet opens one WebSocket connection to
``/planning/sheets/{sheet_id}/live``. Whenever any user changes that
sheet (cell value, cell status color, column added/renamed/configured,
row added/renamed/deleted, ...), ``PlanningService`` calls
:meth:`ConnectionManager.broadcast` after the DB write commits, and every
*other* connected tab receives a small JSON event describing exactly what
changed -- letting the frontend patch its in-memory grid instead of
re-fetching the whole sheet, so edits from other users (or other tabs)
appear immediately without a manual refresh.

Kept intentionally simple (an in-process dict of open sockets, keyed by
sheet id) rather than a message broker: this ERP runs as a single backend
process (see ``app.queue.worker`` for the same single-process assumption
elsewhere), so there is exactly one place connections could ever be and
no cross-process fan-out is needed. If the app is ever scaled to multiple
backend processes, this would need to move to a shared pub/sub (Redis,
etc.) -- noted here rather than solved speculatively.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from app.core.logging import get_logger

logger = get_logger(__name__)


@dataclass
class _SheetConnections:
    """All currently-open sockets for one sheet, plus which user/tab each belongs to."""

    sockets: dict[WebSocket, uuid.UUID] = field(default_factory=dict)  # socket -> user_id


class PlanningConnectionManager:
    """Tracks open WebSocket connections per sheet and fans out change events to them."""

    def __init__(self) -> None:
        self._sheets: dict[uuid.UUID, _SheetConnections] = {}

    async def connect(self, sheet_id: uuid.UUID, user_id: uuid.UUID, websocket: WebSocket) -> None:
        """Accept and register a new connection for a sheet."""
        await websocket.accept()
        bucket = self._sheets.setdefault(sheet_id, _SheetConnections())
        bucket.sockets[websocket] = user_id

    def disconnect(self, sheet_id: uuid.UUID, websocket: WebSocket) -> None:
        """Remove a closed/dropped connection. Safe to call even if already removed."""
        bucket = self._sheets.get(sheet_id)
        if bucket is None:
            return
        bucket.sockets.pop(websocket, None)
        if not bucket.sockets:
            self._sheets.pop(sheet_id, None)

    async def broadcast(
        self, sheet_id: uuid.UUID, event: dict, *, exclude_user_id: uuid.UUID | None = None
    ) -> None:
        """
        Send ``event`` (already JSON-serializable) to every open connection on this sheet.

        ``exclude_user_id`` skips the sockets belonging to the user who
        made the change -- their own tab already applied the change
        optimistically via the normal REST response, so echoing it back
        would be redundant (though harmless if it does arrive, since the
        frontend's patch functions are idempotent for the same value).
        Every OTHER tab of that same user (e.g. two browser windows) still
        receives the event, since it's keyed by connection, not by user.
        """
        bucket = self._sheets.get(sheet_id)
        if bucket is None:
            return
        dead: list[WebSocket] = []
        for websocket, owner_id in list(bucket.sockets.items()):
            if exclude_user_id is not None and owner_id == exclude_user_id:
                continue
            try:
                await websocket.send_json(event)
            except Exception:  # noqa: BLE001 - a broken socket must not break the request that triggered the broadcast
                dead.append(websocket)
        for websocket in dead:
            self.disconnect(sheet_id, websocket)

    def connection_count(self, sheet_id: uuid.UUID) -> int:
        """Number of currently-open connections for a sheet (used for a lightweight presence indicator)."""
        bucket = self._sheets.get(sheet_id)
        return len(bucket.sockets) if bucket else 0

    async def broadcast_all(self, event: dict) -> None:
        """
        Send ``event`` to every open connection across every sheet, no matter which sheet it's for.

        Used for events that aren't scoped to one specific sheet -- e.g. "a
        Product Master record changed" needs to reach every open Planning
        tab, because any sheet's ITEM column (or any LINKED_LOOKUP/
        AGGREGATE column) might be pulling from that exact record, and this
        module has no efficient way to know in advance which sheets those
        are without duplicating the source-module wiring here. Each
        connected tab decides for itself (client-side, cheaply) whether the
        event is relevant to what it's currently displaying, and just
        no-ops if not -- see PlanningPage's `applyLiveEvent`'s
        "source_record_changed" case in the frontend.
        """
        for sheet_id, bucket in list(self._sheets.items()):
            dead: list[WebSocket] = []
            for websocket in list(bucket.sockets.keys()):
                try:
                    await websocket.send_json(event)
                except Exception:  # noqa: BLE001
                    dead.append(websocket)
            for websocket in dead:
                self.disconnect(sheet_id, websocket)


# Single process-wide instance -- every request handler and the WS route
# itself import this same object, so a broadcast from a REST call reaches
# sockets registered by the WS route.
connection_manager = PlanningConnectionManager()


async def notify_source_record_changed(module_key: str, record_id: uuid.UUID) -> None:
    """
    Tell every open Planning tab that a record in ``module_key`` (e.g.
    "product") changed, so any sheet displaying it via a LINKED_LOOKUP/
    AGGREGATE column (including the built-in ITEM column) can refresh
    that record's cells live -- e.g. renaming a product in Product Master
    updates the ITEM column in an already-open Shipment Planning tab
    instantly, no reload needed.

    Deliberately decoupled from any particular source module's service:
    this function is imported and called directly by e.g.
    ``app.masters.products.service.ProductService.update`` (see that
    module for the call site) rather than Planning depending on Products,
    or Products depending on Planning's full service -- only this one
    small notification function crosses the module boundary, and it's
    optional/best-effort (never raises) so a WebSocket hiccup can never
    break a product update.
    """
    try:
        await connection_manager.broadcast_all(
            {"type": "source_record_changed", "payload": {"module": module_key, "record_id": str(record_id)}}
        )
    except Exception:  # noqa: BLE001
        logger.exception(
            "Failed to broadcast source-record-changed event.", extra={"source_module": module_key, "record_id": str(record_id)}
        )


async def refresh_planning_cells_for_record(session: Any, module_key: str, record_id: uuid.UUID) -> None:
    """
    Recompute and PERSIST every Planning cell that could be affected by a
    change to one record in ``module_key`` (e.g. a Product being edited)
    -- the store-on-write counterpart to ``notify_source_record_changed``
    above, which only broadcasts a live-refresh hint to already-open
    browser tabs and never touches the database.

    Call this from the SAME source-module service method that calls
    ``notify_source_record_changed`` (e.g.
    ``app.masters.products.service.ProductService.update``, right after
    it), passing that method's own already-open ``AsyncSession`` --
    reusing the caller's session/transaction rather than opening a new
    one keeps this part of the same commit as the record edit itself, so
    a Planning cell's stored value and the record it was computed from
    can never end up out of sync even if the process crashes between the
    two writes.

    Deliberately decoupled from any particular source module's service,
    mirroring ``notify_source_record_changed``'s own docstring: only this
    one small function (plus that one) crosses the module boundary
    between Products/Suppliers/Buyers and Planning.

    Best-effort, never raises -- a background recompute failing must
    never turn a successful product/supplier/buyer save into a failed
    HTTP response for the user who made it. Failures are logged so they
    can be investigated, and the affected cells simply keep showing
    their last-known value until the next successful recompute (the next
    edit to the same record, or a future manual "refresh this cell"
    action) rather than the request failing outright.
    """
    try:
        from app.audit.repository import AuditRepository
        from app.audit.service import AuditService
        from app.planning.repository import (
            PlanningCellRepository,
            PlanningChangeLogRepository,
            PlanningColumnRepository,
            PlanningColumnRoleLockRepository,
            PlanningRowRepository,
            PlanningSheetRepository,
            PlanningStatusTagRepository,
        )
        from app.planning.service import PlanningService

        service = PlanningService(
            PlanningSheetRepository(session),
            PlanningRowRepository(session),
            PlanningColumnRepository(session),
            PlanningCellRepository(session),
            PlanningStatusTagRepository(session),
            PlanningChangeLogRepository(session),
            AuditService(AuditRepository(session)),
            PlanningColumnRoleLockRepository(session),
        )
        touched = await service.recompute_and_store_cells_referencing_record(module_key, record_id)
        if touched:
            logger.info(
                "Refreshed Planning cells after source-module record change.",
                extra={"source_module": module_key, "record_id": str(record_id), "cells_touched": touched},
            )
    except Exception:  # noqa: BLE001
        logger.exception(
            "Failed to refresh Planning cells for changed source record.",
            extra={"source_module": module_key, "record_id": str(record_id)},
        )