/**
 * React Hooks for Live Data.
 *
 * The layer future module pages actually use. None of this talks to a
 * WebSocket directly -- it all goes through the single shared
 * `liveClient` (see `liveClient.ts`), so using these hooks can never
 * result in a second connection being opened (Phase 2 brief section 22:
 * "A new ERP module should not require a new WebSocket client").
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { liveClient, type ConnectionStatus } from "./liveClient";
import type { LiveEvent } from "./liveEvent";
import { moduleChannel } from "./liveEvent";

/**
 * Subscribes to the global connection status. Re-renders the calling
 * component on every transition (connecting/connected/disconnected/
 * reconnecting/error) -- Phase 2 brief section 6.
 */
export function useLiveConnectionStatus(): ConnectionStatus {
  const [status, setStatus] = useState<ConnectionStatus>(() => liveClient.getStatus());
  useEffect(() => liveClient.onConnectionChange(setStatus), []);
  return status;
}

/**
 * Live Event Router (Phase 2 brief section 7).
 *
 * `liveClient.onEvent()` fires for EVERY event received on ANY channel
 * this tab is subscribed to -- the client itself has no notion of "which
 * channel this particular event arrived via" (the wire event itself, per
 * `Event.to_dict()` in `backend/app/events/models.py`, carries `entity`/
 * `entity_id`, not a channel name). Routing "only events for MY channel"
 * to a specific hook's caller therefore means recovering the channel
 * from the event's own `entity` field.
 *
 * IMPORTANT -- this is NOT a mechanical `module:{entity}` transform.
 * Checked directly against `backend/app/events/channels.py`'s actual
 * `MODULE_CHANNEL_PERMISSIONS` registry: the channel names there are
 * pluralized module names (`module:buyers`, `module:suppliers`,
 * `module:inquiries`), while `Event.entity`/`event_type` use the
 * SINGULAR entity name (`entity="buyer"`, `event_type="buyer.updated"` --
 * see `Event`'s own docstring example). `module:planning` has no such
 * mismatch (the module and the entity happen to share a name), and
 * `module:inventory` maps to the entirely different word `"product"`.
 * A single pluralization rule would silently misroute every buyer/
 * supplier/inquiry event -- this map is the explicit, checked
 * entity -> channel translation instead, kept in sync BY HAND with the
 * backend registry (there is currently no single shared source of truth
 * generating both sides -- see the module docstring's TODO note below).
 *
 * TODO(module integration phase): consider having the backend include
 * the originating channel name directly on the wire event, which would
 * remove the need for this table (and the risk of it drifting out of
 * sync with `channels.py`) entirely. Not done in Phase 2 since it would
 * mean changing the Phase 1 wire format, which is out of this phase's
 * frontend-only scope.
 */
const ENTITY_TO_MODULE_CHANNEL: Record<string, string> = {
  buyer: moduleChannel("buyers"),
  supplier: moduleChannel("suppliers"),
  planning: moduleChannel("planning"),
  product: moduleChannel("inventory"),
  inquiry: moduleChannel("inquiries"),
  // Phase 9: master-data entities. All of these happen to share their
  // name with their module channel (entity="brand" -> module:brand is
  // what the naive fallback below would ALSO produce), but they are
  // listed explicitly rather than left to the fallback -- this table is
  // the single audited source of truth for entity->channel routing, and
  // a future rename on either side (backend channel or entity string)
  // should be forced to touch this file rather than silently keep
  // "working" via the fallback's coincidental match.
  category: moduleChannel("categories"),
  subcategory: moduleChannel("subcategories"),
  brand: moduleChannel("brands"),
  country: moduleChannel("countries"),
  state: moduleChannel("states"),
  city: moduleChannel("cities"),
  currency: moduleChannel("currencies"),
  uom: moduleChannel("uom"),
  hsn: moduleChannel("hsn"),
};

function eventBelongsToChannel(event: LiveEvent, channel: string): boolean {
  if (!event.entity) return false;
  const mappedChannel = ENTITY_TO_MODULE_CHANNEL[event.entity];
  if (mappedChannel) return mappedChannel === channel;
  // Unrecognized entity -- fall back to the naive (entity itself IS the
  // module name) case rather than silently dropping every event from a
  // future module that hasn't been added to the table above yet.
  return moduleChannel(event.entity) === channel;
}

// --- Refcounted channel subscription ---------------------------------------
//
// Two components subscribing to the SAME channel (e.g. a list page and a
// detail side-panel both wanting module:buyers at once) must not tear the
// subscription down when only ONE of them unmounts -- the other would
// silently stop receiving live updates. A plain module-level refcount map,
// keyed by channel name, tracks how many mounted components currently want
// each channel; the real liveClient.unsubscribe() only fires once the
// count reaches zero, so cleanup (Phase 2 brief section 26) stays correct
// regardless of how many components share a channel.
const channelRefCounts = new Map<string, number>();

/**
 * Test-only escape hatch to reset the module-level refcount map between
 * test cases, so one test's leftover subscriptions can't leak into the
 * next. Not used anywhere in application code.
 */
export function __resetChannelRefCountsForTests(): void {
  channelRefCounts.clear();
}

function useChannelRefcount(channel: string | null | undefined): void {
  useEffect(() => {
    if (!channel) return;
    channelRefCounts.set(channel, (channelRefCounts.get(channel) ?? 0) + 1);

    return () => {
      const currentCount = channelRefCounts.get(channel) ?? 0;
      if (currentCount <= 1) {
        channelRefCounts.delete(channel);
        liveClient.unsubscribe(channel);
      } else {
        channelRefCounts.set(channel, currentCount - 1);
      }
    };
  }, [channel]);
}

/**
 * Subscribe to one channel for the lifetime of the calling component,
 * routing every event that belongs to it (see `eventBelongsToChannel`
 * above) to `onEvent`.
 *
 * Automatically re-subscribes if `channel` itself changes, and always
 * unsubscribes on unmount -- UNLESS another still-mounted component is
 * also currently subscribed to the same channel (see the refcounting
 * note above), in which case only THIS component's own listener is
 * removed and the shared subscription is left running for the other one.
 */
export function useLiveChannel(channel: string | null | undefined, onEvent: (event: LiveEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!channel) return;
    liveClient.subscribe(channel);
    // Deliberately does not call liveClient.unsubscribe(channel) in this
    // effect's cleanup -- see useChannelRefcount below, which owns the
    // actual "count down to zero, then unsubscribe" behavior for this
    // same channel value as a sibling effect.
  }, [channel]);

  useEffect(() => {
    if (!channel) return;
    return liveClient.onEvent((event) => {
      if (eventBelongsToChannel(event, channel)) {
        onEventRef.current(event);
      }
    });
  }, [channel]);

  useChannelRefcount(channel);
}

/**
 * The module-agnostic sugar the Phase 2 brief asks for by name (section
 * 22): `useLiveModule("buyers")` subscribes to that module's channel and
 * routes matching events to `onEvent`, with the exact same cleanup
 * guarantees as `useLiveChannel` (which this is a thin convenience
 * wrapper around -- there is no second implementation here).
 *
 * A future module needs nothing more than this one call to participate
 * in live updates; it never touches `liveClient` directly.
 */
export function useLiveModule(moduleName: string | null | undefined, onEvent: (event: LiveEvent) => void): void {
  const channel = useMemo(() => (moduleName ? moduleChannel(moduleName) : null), [moduleName]);
  useLiveChannel(channel, onEvent);
}