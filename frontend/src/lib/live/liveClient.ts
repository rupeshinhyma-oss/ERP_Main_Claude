/**
 * ERP Live Client.
 *
 * THE one reusable WebSocket client for the whole app -- every module
 * subscribes through this same instance/class rather than opening its own
 * socket (Phase 2 brief section 3: "Do NOT create BuyerWebSocket,
 * SupplierWebSocket, ... Prefer: ERP WebSocket Client -- Buyers
 * subscription, Planning subscription, ...").
 *
 * Talks the ACTUAL Phase 1 protocol (`backend/app/events/routes.py`):
 *   - Connect: `wss://.../api/v1/events/live?token=<access_token>`
 *     (mirrors the exact URL-building the existing Shipment Planning
 *     WebSocket already does in `Planning.tsx` -- resolve a possibly-
 *     relative API_BASE to an absolute URL first, THEN swap the
 *     http(s):// scheme for ws(s)://, since `new WebSocket()` throws
 *     immediately on a bare relative path).
 *   - Client -> server: `{"action": "subscribe"|"unsubscribe", "channel": "..."}`
 *   - Server -> client: either a control message (`{"type": "subscribed"|
 *     "unsubscribed"|"error", ...}`) or a live event (`Event.to_dict()`'s
 *     shape -- see `liveEvent.ts`).
 *
 * Does NOT replace the existing Shipment Planning WebSocket in
 * `Planning.tsx` (`/planning/sheets/{sheet_id}/live`) -- that connection,
 * and its own reconnect loop, are untouched. This is new, separate,
 * general-purpose infrastructure that future modules (and, on an opt-in
 * basis, Planning itself in a later phase) build on instead of each
 * hand-rolling their own socket.
 */

import { Auth } from "@/lib/auth";
import { API_BASE, handleSessionExpired } from "@/lib/api";
import type { LiveClientMessage, LiveControlMessage, LiveEvent } from "./liveEvent";
import { isLiveEvent } from "./liveEvent";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "reconnecting" | "error";

type EventListener = (event: LiveEvent) => void;
type ConnectionListener = (status: ConnectionStatus) => void;
type ControlListener = (message: LiveControlMessage) => void;

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
// Caps how many consecutive failed attempts count toward the backoff
// exponent -- without this, `2 ** attempts` would eventually overflow
// into a nonsensical delay after enough failures (e.g. a laptop left
// asleep for a day). The delay is already clamped to
// MAX_RECONNECT_DELAY_MS regardless, but capping the exponent itself
// keeps the underlying math sane rather than relying only on the clamp.
const MAX_BACKOFF_EXPONENT = 6; // 2**6 * 1000ms = 64s, already above the 30s clamp

function computeBackoffDelay(attempt: number): number {
  const exponent = Math.min(attempt, MAX_BACKOFF_EXPONENT);
  const raw = INITIAL_RECONNECT_DELAY_MS * 2 ** exponent;
  // +/- 20% jitter so many tabs/users reconnecting after the same brief
  // outage don't all hammer the backend in the same instant (a basic
  // "reconnect storm" guard -- Phase 2 brief section 25).
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.min(MAX_RECONNECT_DELAY_MS, Math.round(raw + jitter));
}

/**
 * Build the absolute `wss://`/`ws://` URL for the given path, resolving a
 * possibly-relative `API_BASE` against the current page first. Extracted
 * from the exact logic `Planning.tsx`'s existing WebSocket effect already
 * uses, so both connections build their URL identically.
 */
function buildWebSocketUrl(path: string, token: string): string {
  const absoluteApiBase = new URL(`${API_BASE}${path}`, window.location.href).toString();
  const wsBase = absoluteApiBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  return `${wsBase}?token=${encodeURIComponent(token)}`;
}

export class LiveClient {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "disconnected";
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = true;
  /** Channels the caller wants active. Restored automatically after every (re)connect -- see `_flushSubscriptions`. */
  private desiredChannels = new Set<string>();
  /** Channels the SERVER has actually acknowledged for the CURRENT socket. Reset to empty on every new connection. */
  private confirmedChannels = new Set<string>();

  private readonly eventListeners = new Set<EventListener>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly controlListeners = new Set<ControlListener>();

  /**
   * @param path The WebSocket route's path under `API_BASE`, e.g. `/events/live`.
   *             Overridable mainly for tests; production code should
   *             always use the default.
   */
  constructor(private readonly path: string = "/events/live") {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Open the connection using the current session's access token. A no-op
   * if already connected or in the middle of connecting -- callers (e.g.
   * the app-level provider reacting to login) can call this freely
   * without checking state themselves first.
   */
  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const token = Auth.getAccessToken();
    if (!token) {
      // No session -- nothing to connect with. The app-level provider is
      // expected to call connect() again once Auth reports a login (see
      // liveConnectionProvider.ts), so this quietly does nothing rather
      // than treating "not logged in yet" as a connection error.
      return;
    }
    this.intentionallyClosed = false;
    this.clearReconnectTimer();
    this._setStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

    let socket: WebSocket;
    try {
      socket = new WebSocket(buildWebSocketUrl(this.path, token));
    } catch {
      this._setStatus("error");
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.confirmedChannels.clear();
      this._setStatus("connected");
      // Phase 2 brief section 17 (reconnect synchronization): restore
      // every channel the app still wants, since the server has no
      // memory of this connection's previous subscriptions -- a brand
      // new socket starts with zero subscriptions every time.
      this.flushSubscriptions();
    };

    socket.onmessage = (rawMessage) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMessage.data);
      } catch {
        // Malformed frame from the server -- log and ignore (Phase 2
        // brief section 24: "malformed event" must not crash the app).
        console.warn("[LiveClient] Received malformed WebSocket message; ignoring.");
        return;
      }
      this.handleMessage(parsed);
    };

    socket.onclose = (ev) => {
      this.socket = null;
      this.confirmedChannels.clear();
      if (ev.code === 4001 || ev.reason === "force_logout") {
        this.intentionallyClosed = true;
        this._setStatus("disconnected");
        handleSessionExpired();
        return;
      }
      if (this.intentionallyClosed) {
        this._setStatus("disconnected");
        return;
      }
      this._setStatus("reconnecting");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // The browser fires a subsequent `close` right after `error` for a
      // WebSocket, so reconnect scheduling happens there, not here --
      // this only needs to reflect the status and let onclose do the
      // actual cleanup/retry, avoiding a double-scheduled reconnect.
      this._setStatus("error");
    };
  }

  /**
   * Close the connection intentionally (e.g. on logout). Clears every
   * desired/confirmed subscription -- Phase 2 brief section 4: "If the
   * user logs out: disconnect -> clear subscriptions."
   */
  disconnect(): void {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.desiredChannels.clear();
    this.confirmedChannels.clear();
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this._setStatus("disconnected");
  }

  /**
   * Subscribe to `channel`. Safe to call before the socket is open (or
   * while reconnecting) -- the channel is remembered and sent as soon as
   * a connection becomes available (see `flushSubscriptions`), so callers
   * never need to check connection state before subscribing.
   */
  subscribe(channel: string): void {
    this.desiredChannels.add(channel);
    this.sendIfOpen({ action: "subscribe", channel });
  }

  /** Unsubscribe from `channel`. Safe to call even if never subscribed, or while disconnected. */
  unsubscribe(channel: string): void {
    this.desiredChannels.delete(channel);
    this.confirmedChannels.delete(channel);
    this.sendIfOpen({ action: "unsubscribe", channel });
  }

  /** Register a callback for every live domain event received (across ALL channels -- see `useLiveChannel` for per-channel filtering). Returns an unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** Register a callback for connection-status transitions. Returns an unsubscribe function. */
  onConnectionChange(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  /** Register a callback for server control messages (subscribed/unsubscribed/error) -- mainly useful for surfacing a permission rejection to the caller that asked to subscribe. Returns an unsubscribe function. */
  onControlMessage(listener: ControlListener): () => void {
    this.controlListeners.add(listener);
    return () => this.controlListeners.delete(listener);
  }

  /** True if `channel` is both desired AND has been acknowledged by the current connection. */
  isSubscribed(channel: string): boolean {
    return this.confirmedChannels.has(channel);
  }

  // --- internals -----------------------------------------------------------

  private handleMessage(parsed: unknown): void {
    if (isLiveEvent(parsed)) {
      for (const listener of this.eventListeners) listener(parsed);
      return;
    }
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      const msg = parsed as Record<string, unknown>;
      if (msg.type === "FORCE_LOGOUT") {
        this.disconnect();
        handleSessionExpired();
        return;
      }
      const control = parsed as LiveControlMessage;
      if (control.type === "subscribed") this.confirmedChannels.add(control.channel);
      if (control.type === "unsubscribed") this.confirmedChannels.delete(control.channel);
      for (const listener of this.controlListeners) listener(control);
      return;
    }
    // Neither a recognizable event nor a recognizable control message --
    // an entirely unknown shape. Log and ignore rather than throwing;
    // matches Phase 2 brief section 24's "unknown event type" case.
    console.warn("[LiveClient] Received an unrecognized message shape; ignoring.", parsed);
  }

  private flushSubscriptions(): void {
    for (const channel of this.desiredChannels) {
      this.sendIfOpen({ action: "subscribe", channel });
    }
  }

  private sendIfOpen(message: LiveClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
    // If not open yet, `desiredChannels` (already updated by the caller
    // before this runs) is the source of truth and gets flushed once
    // `onopen` fires -- no queue/buffer needed here beyond that set.
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    this.clearReconnectTimer();
    const delay = computeBackoffDelay(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private _setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.connectionListeners) listener(status);
  }
}

/**
 * Single process-wide (well, tab-wide) instance. Every module imports
 * THIS, rather than constructing its own `LiveClient` -- the same
 * "one client, many subscriptions" model as the backend's own
 * `connection_manager` singleton (see `backend/app/events/manager.py`).
 */
export const liveClient = new LiveClient();
