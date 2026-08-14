/**
 * Live Event Wire Types.
 *
 * Mirrors the ACTUAL Phase 1 backend wire protocol byte-for-byte -- see
 * `backend/app/events/models.py` (`Event.to_dict()`) and
 * `backend/app/events/routes.py` (the `/events/live` WebSocket's control
 * messages). These are plain type definitions, not a second protocol: if
 * the backend shape ever changes, this file is where that change shows up
 * on the frontend, and nowhere else needs its own copy of these fields.
 */

/**
 * One live event, exactly as `Event.to_dict()` serializes it.
 *
 * `version` and `user_id` are nullable on the backend (not every module
 * versions its records, and system-initiated events have no acting user),
 * so both stay optional/nullable here too rather than being narrowed to
 * something the backend doesn't actually guarantee.
 */
export interface LiveEvent {
  event_id: string;
  event_type: string;
  entity: string;
  entity_id: string;
  version: number | null;
  timestamp: string;
  user_id: string | null;
  changes: Record<string, unknown>;
}

/** Server -> client acknowledgment after a successful `subscribe`/`unsubscribe`. */
export interface LiveSubscriptionAck {
  type: "subscribed" | "unsubscribed";
  channel: string;
}

/** Server -> client rejection (bad permission, malformed message, unknown action, ...). */
export interface LiveErrorMessage {
  type: "error";
  message: string;
  channel?: string;
}

export type LiveControlMessage = LiveSubscriptionAck | LiveErrorMessage;

/** True if a decoded server message is a live domain event rather than a control message (which carry `type`, events don't). */
export function isLiveEvent(message: unknown): message is LiveEvent {
  return (
    typeof message === "object" &&
    message !== null &&
    "event_id" in message &&
    "event_type" in message &&
    "entity" in message &&
    "entity_id" in message &&
    !("type" in message)
  );
}

/** Client -> server subscribe/unsubscribe frame, exactly as `app.events.routes._handle_client_message` expects. */
export interface LiveClientMessage {
  action: "subscribe" | "unsubscribe";
  channel: string;
}

/**
 * Channel-name helpers, mirroring `backend/app/events/channels.py`'s
 * `module_channel`/`user_channel`/`entity_channel` exactly, so the
 * frontend never hand-builds a channel string that could drift out of
 * sync with what the backend's permission registry actually expects.
 */
export function moduleChannel(module: string): string {
  return `module:${module}`;
}

export function userChannel(userId: string): string {
  return `user:${userId}`;
}

export function entityChannel(entity: string, entityId: string): string {
  return `${entity}:${entityId}`;
}
