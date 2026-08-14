"""
Generic Live-Event WebSocket Routes.

Exposes ONE WebSocket endpoint, ``/events/live``, that any authenticated
user can connect to and then subscribe/unsubscribe from one or more
logical channels (see :mod:`app.events.channels`) over that single
connection -- Phase 1 brief section 5: "Do NOT create separate physical
WebSocket connections for every module... a single authenticated
WebSocket connection should be allowed to subscribe to multiple logical
channels."

This does NOT replace ``app.planning.routes``'s existing
``/planning/sheets/{sheet_id}/live`` endpoint, which keeps working exactly
as it does today. This is new, separate, general-purpose infrastructure.

Wire protocol
-------------
Auth (same pattern as the existing Planning WebSocket route, since
browsers cannot set an ``Authorization`` header on a WebSocket handshake)::

    wss://.../api/v1/events/live?token=<access_token>

Client -> server, once connected, as JSON text frames::

    {"action": "subscribe",   "channel": "module:buyers"}
    {"action": "unsubscribe", "channel": "module:buyers"}

Server -> client:

    Control messages (acks/errors), always shaped as::

        {"type": "subscribed",   "channel": "..."}
        {"type": "unsubscribed", "channel": "..."}
        {"type": "error", "message": "..."}

    Live events, shaped exactly as :meth:`app.events.models.Event.to_dict`
    produces (``event_id``, ``event_type``, ``entity``, ``entity_id``,
    ``version``, ``timestamp``, ``user_id``, ``changes``).
"""

from __future__ import annotations

import json

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect

from app.auth.dependencies import get_auth_service
from app.auth.service import AuthService, CurrentUser
from app.core.exceptions import UnauthorizedException
from app.core.logging import get_logger
from app.events.channels import is_any_user_channel, is_user_channel, permission_required_for_channel
from app.events.manager import connection_manager

router = APIRouter(prefix="/events", tags=["Live Events"])
logger = get_logger(__name__)

# Maximum control message size accepted from a client, to bound how much
# work a single malformed/malicious frame can force this route to do
# (Phase 1 brief section 13: "malformed event" is an explicit error case
# to handle). Generous enough for any real subscribe/unsubscribe message.
_MAX_CLIENT_MESSAGE_BYTES = 4096


def _authorize_channel(channel: str, current_user: CurrentUser) -> str | None:
    """
    Check whether ``current_user`` may subscribe to ``channel``.

    Returns ``None`` if allowed, or a human-readable rejection reason if
    not. A plain function (not a FastAPI dependency) since this needs to
    run once per client-sent "subscribe" message on an already-open
    socket, not once per HTTP request/handshake.
    """
    if is_any_user_channel(channel):
        if not is_user_channel(channel, current_user.id):
            return "You may only subscribe to your own user channel."
        return None

    required_permission = permission_required_for_channel(channel)
    if required_permission is None:
        # Either an explicitly permission-less channel (e.g.
        # "notifications") or an entity-specific channel not yet governed
        # by its own rule -- see permission_required_for_channel's
        # docstring for why this defaults open rather than closed in
        # Phase 1.
        return None
    if required_permission not in current_user.permissions:
        return f"This channel requires the {required_permission!r} permission."
    return None


@router.websocket("/live")
async def live_events(
    websocket: WebSocket,
    token: str = Query(..., description="Access token (same one used for Authorization: Bearer)."),
    auth_service: AuthService = Depends(get_auth_service),
) -> None:
    """
    General-purpose live-event WebSocket. See the module docstring above
    for the full wire protocol.

    Authentication mirrors ``app.planning.routes.sheet_live_updates``
    exactly (verify the same access token through
    ``AuthService.verify_access_token``, close with code 4401 if invalid)
    -- Phase 1 brief section 6: "The WebSocket must use the ERP's existing
    authentication mechanism... do not create a second unrelated
    authentication system."
    """
    try:
        current_user = await auth_service.verify_access_token(token)
    except UnauthorizedException:
        await websocket.close(code=4401, reason="Invalid or expired token.")
        return

    await connection_manager.connect(websocket, current_user.id)

    try:
        while True:
            raw = await websocket.receive_text()
            await _handle_client_message(websocket, raw, current_user)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001 - never let a socket-level error take down the process (section 13)
        logger.exception("Live-events socket errored.", extra={"user_id": str(current_user.id)})
    finally:
        connection_manager.disconnect(websocket)


async def _handle_client_message(websocket: WebSocket, raw: str, current_user: CurrentUser) -> None:
    """
    Parse and act on one inbound client frame.

    Isolated into its own function (rather than inlined in the route's
    ``while`` loop) so every failure mode -- oversized frame, invalid
    JSON, missing/wrong-typed fields, unknown action, permission
    rejection -- is handled the same explicit way and reported back to
    THIS client as an ``{"type": "error", ...}`` control message, instead
    of ever raising out into the route's loop and killing the connection
    over what is, from the protocol's perspective, just a bad request on
    an otherwise-healthy socket.
    """
    if len(raw.encode("utf-8", errors="ignore")) > _MAX_CLIENT_MESSAGE_BYTES:
        await connection_manager.send_to_websocket(websocket, {"type": "error", "message": "Message too large."})
        return

    try:
        message = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        await connection_manager.send_to_websocket(websocket, {"type": "error", "message": "Malformed message: expected JSON."})
        return

    if not isinstance(message, dict):
        await connection_manager.send_to_websocket(websocket, {"type": "error", "message": "Malformed message: expected a JSON object."})
        return

    action = message.get("action")
    channel = message.get("channel")

    if action not in ("subscribe", "unsubscribe"):
        await connection_manager.send_to_websocket(
            websocket, {"type": "error", "message": f"Unknown action: {action!r}. Expected 'subscribe' or 'unsubscribe'."}
        )
        return

    if not isinstance(channel, str) or not channel:
        await connection_manager.send_to_websocket(websocket, {"type": "error", "message": "'channel' must be a non-empty string."})
        return

    if action == "unsubscribe":
        connection_manager.unsubscribe(websocket, channel)
        await connection_manager.send_to_websocket(websocket, {"type": "unsubscribed", "channel": channel})
        return

    rejection_reason = _authorize_channel(channel, current_user)
    if rejection_reason is not None:
        await connection_manager.send_to_websocket(websocket, {"type": "error", "message": rejection_reason, "channel": channel})
        return

    connection_manager.subscribe(websocket, channel)
    await connection_manager.send_to_websocket(websocket, {"type": "subscribed", "channel": channel})
