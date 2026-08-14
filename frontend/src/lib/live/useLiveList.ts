/**
 * Standard Frontend Live-List Pattern (Phase 6).
 *
 * Extracts the ONE wiring pattern both `Buyers.tsx` (Phase 2/4) and
 * `Planning.tsx`'s sheet tab-list (Phase 5) had independently
 * hand-written, byte-for-byte identical except for which module/state
 * they targeted:
 *
 *     const cache = useMemo(() => new EventDedupeCache(), []);
 *     useLiveModule(moduleName, (event) => {
 *       if (someGate) return;
 *       setRecords((prev) => {
 *         const result = applyEntityEvent({ records: prev, event, dedupeCache: cache, ...options });
 *         onApplied?.(result);
 *         return result.records;
 *       });
 *     });
 *
 * `useLiveList` IS that pattern, written once. A future module (e.g.
 * Inventory) needing the exact same "subscribe, patch this list" shape
 * calls this ONE hook instead of re-deriving it -- see
 * `LIVE_MODULE_GUIDE.md` for the full walkthrough.
 *
 * Deliberately thin: this owns ONLY the wiring (dedupe cache lifecycle +
 * subscribing + calling setState), never any module-specific business
 * rule. Every actual decision --which fields to build a `created` record
 * from, whether a record matches the current filter, what to do with a
 * total-record counter -- stays exactly where Phase 2's brief says it
 * belongs: inside the calling module, passed in as plain options/
 * callbacks. This file has no knowledge of "buyer" or "planning" or any
 * other module name anywhere in it.
 *
 * A module that needs something this hook doesn't cover (e.g. Planning's
 * OWN per-sheet grid-internals socket, which patches a nested
 * rows/columns/cells structure, not a flat list) is simply not a good
 * fit for `useLiveList` and keeps using `useLiveChannel`/`useLiveModule`
 * directly, or its own state-patching logic -- this hook does not
 * attempt to cover every possible live-data shape, only the common
 * "flat list of records" one both existing integrations actually needed.
 */

import { useMemo } from "react";
import { useLiveModule } from "./useLive";
import { EventDedupeCache } from "./liveDedupe";
import {
  applyEntityEvent,
  type ApplyEntityEventOptions,
  type ApplyEntityEventResult,
  type VersionedRecord,
} from "./liveEntityStore";
import type { LiveEvent } from "./liveEvent";

export interface UseLiveListOptions<T extends VersionedRecord>
  extends Omit<ApplyEntityEventOptions<T>, "records" | "event" | "dedupeCache"> {
  /**
   * The module name to subscribe to, e.g. `"buyers"`, `"planning"`,
   * a future `"inventory"`. Passed straight through to `useLiveModule`
   * -- see that hook for how `module:{name}` is derived and how events
   * are routed back to it by `entity`.
   */
  moduleName: string | null | undefined;
  /**
   * The list's own React state setter, e.g. `setRows`/`setSheets`.
   * Called with an updater function, same as calling `setRecords(prev => ...)`
   * directly -- `useLiveList` never reads the CURRENT records itself, it
   * always goes through the setter's own `prev` argument, so it works
   * correctly no matter how often the underlying list identity changes
   * between renders.
   */
  setRecords: (updater: (prev: T[]) => T[]) => void;
  /**
   * Optional gate, checked BEFORE `applyEntityEvent` runs at all. Return
   * `true` to skip this event entirely (e.g. Buyers' "only live-patch an
   * entirely unfiltered page 1 view" rule, or Planning's equivalent for
   * its own list). Re-evaluated on every event, so it can safely close
   * over other state (filters, current page, ...) the calling
   * component's render already has in scope.
   */
  shouldSkip?: () => boolean;
  /**
   * Optional callback fired AFTER a successful `applyEntityEvent` call,
   * with its full result -- e.g. to bump a separate `totalRecords`
   * counter when `result.action` is `"created"`/`"deleted"`, the way
   * `Buyers.tsx` already does. Never called for a skipped (via
   * `shouldSkip`) or no-op event, since nothing changed.
   */
  onApplied?: (result: ApplyEntityEventResult<T>) => void;
}

/**
 * Subscribe `moduleName`'s live events and keep a flat list of records
 * (already loaded via REST, e.g. `rows`/`sheets`) in sync -- the
 * complete "created/updated/deleted -> patch local state" pattern from
 * Phase 2's brief, wired up in one call.
 *
 * Example (mirrors what `Buyers.tsx` already does, just consolidated):
 *
 *     useLiveList({
 *       moduleName: "buyers",
 *       setRecords: setRows,
 *       shouldSkip: () => hasActiveFilterOrSearch || currentPage !== 1,
 *       onApplied: (result) => {
 *         if (result.action === "created") setTotalRecords((n) => n + 1);
 *         if (result.action === "deleted") setTotalRecords((n) => Math.max(0, n - 1));
 *       },
 *     });
 *
 * Owns its own bounded dedup cache internally (one per hook instance,
 * i.e. one per calling component) -- callers never construct or manage
 * an `EventDedupeCache` themselves.
 */
export function useLiveList<T extends VersionedRecord>(options: UseLiveListOptions<T>): void {
  const { moduleName, setRecords, shouldSkip, onApplied, ...applyOptions } = options;
  const dedupeCache = useMemo(() => new EventDedupeCache(), []);

  useLiveModule(moduleName, (event: LiveEvent) => {
    if (shouldSkip?.()) return;

    setRecords((prev) => {
      const result = applyEntityEvent<T>({
        records: prev,
        event,
        dedupeCache,
        ...applyOptions,
      });
      onApplied?.(result);
      return result.records;
    });
  });
}
