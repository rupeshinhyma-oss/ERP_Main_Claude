/**
 * Generic Local-Store Patching for Live Entity Events.
 *
 * This is the actual "local data patching" logic the Phase 2 brief calls
 * for (sections 8-11): given a list of records a page already has loaded
 * (from REST) and one incoming `LiveEvent`, decide whether/how to patch
 * that list WITHOUT refetching it -- while still respecting version
 * staleness, duplicate delivery, and (for creates) whether the new record
 * even belongs in the currently-displayed view at all.
 *
 * Deliberately generic over the record shape (`T`) rather than
 * hardcoded to Buyers -- any future module's page can call
 * `applyEntityEvent` the same way; nothing here mentions "buyer"
 * anywhere.
 */

import type { LiveEvent } from "./liveEvent";
import { EventDedupeCache } from "./liveDedupe";

/**
 * Minimal shape every record this module patches must have: an `id`
 * matching `LiveEvent.entity_id` (as a string) and an OPTIONAL `version`.
 * Modules that don't track a version (most of this ERP, today -- see
 * `Buyer.version?: number`, always `undefined` until a backend module
 * actually starts sending one) still get create/update/delete patching;
 * they just skip the staleness check described below.
 */
export interface VersionedRecord {
  id: string;
  version?: number | null;
}

export interface ApplyEntityEventOptions<T extends VersionedRecord> {
  /** The current list of records this page has loaded (from its own REST-backed state). */
  records: T[];
  /** The incoming event. */
  event: LiveEvent;
  /** Bounded dedup cache (see `EventDedupeCache`) -- typically one per page/store, not per call. */
  dedupeCache: EventDedupeCache;
  /**
   * Merge an existing record with the event's `changes` payload to
   * produce the patched record, for `*.updated` events. Given a plain
   * object spread already covers the common case
   * (`{ ...existing, ...event.changes }`), this is optional and defaults
   * to exactly that; override it if a module needs field-level
   * transformation (e.g. re-deriving a computed field after a patch).
   */
  mergeChanges?: (existing: T, changes: Record<string, unknown>) => T;
  /**
   * For `*.created` events: build the new record from the event, or
   * return `null` to indicate this module doesn't have enough
   * information in the event alone to construct one (see "Handling
   * `created` events" below). Optional -- if omitted, `created` events
   * are ignored entirely (a safe default; see the module docstring).
   */
  buildFromEvent?: (event: LiveEvent) => T | null;
  /**
   * Whether a (possibly newly-created-from-the-event, or already-
   * existing-and-updated) record belongs in the CURRENTLY DISPLAYED view
   * -- i.e. matches the page's active filters/search/sort scope. Phase 2
   * brief section 9: "Do NOT blindly append every new record to the
   * current list... consider current filters, search, sort, pagination,
   * permissions." Defaults to "always true" (matches everything) if
   * omitted, which is only safe for a page with no filtering at all;
   * any filtered list should pass this.
   */
  matchesCurrentView?: (record: T) => boolean;
}

export type ApplyEntityEventResult<T extends VersionedRecord> =
  | { action: "ignored_duplicate"; records: T[] }
  | { action: "ignored_stale_version"; records: T[] }
  | { action: "ignored_not_in_view"; records: T[] }
  | { action: "ignored_no_builder"; records: T[] }
  | { action: "ignored_unknown_action"; records: T[] }
  | { action: "created"; records: T[] }
  | { action: "updated"; records: T[] }
  | { action: "deleted"; records: T[] }
  | { action: "no_matching_record"; records: T[] };

/**
 * Apply one incoming `LiveEvent` to a list of records already loaded via
 * REST, returning a NEW array (or the exact same array reference if
 * nothing changed, so callers can skip a re-render when `records` is
 * referentially unchanged -- e.g. `setRows(result.records)` is cheap for
 * React to no-op on when the reference is identical).
 *
 * Every ignore path returns the ORIGINAL `records` array by reference
 * (not a copy), which is what lets a caller safely do
 * `setRows((prev) => applyEntityEvent({ records: prev, ... }).records)`
 * without worrying about triggering a render for events that end up
 * being no-ops.
 */
export function applyEntityEvent<T extends VersionedRecord>(
  options: ApplyEntityEventOptions<T>
): ApplyEntityEventResult<T> {
  const { records, event, dedupeCache, mergeChanges, buildFromEvent, matchesCurrentView } = options;

  // --- Phase 2 brief section 12: duplicate event protection -----------------
  if (dedupeCache.isDuplicate(event.event_id)) {
    return { action: "ignored_duplicate", records };
  }

  const existingIndex = records.findIndex((r) => r.id === event.entity_id);
  const existing = existingIndex === -1 ? undefined : records[existingIndex];

  // --- Phase 2 brief section 11: version protection --------------------------
  // Only meaningful when BOTH sides carry a version -- an event with no
  // version (module doesn't track one) always applies; an existing
  // record with no version (never patched by a versioned event before)
  // also always accepts the first versioned event it sees.
  if (
    existing &&
    typeof existing.version === "number" &&
    typeof event.version === "number" &&
    event.version <= existing.version
  ) {
    return { action: "ignored_stale_version", records };
  }

  const isDelete = event.event_type.endsWith(".deleted");
  const isCreate = event.event_type.endsWith(".created");
  const isUpdate = !isDelete && !isCreate; // treat any other suffix (".updated", ".status_changed", ...) as an update-shaped patch

  if (isDelete) {
    if (!existing) return { action: "no_matching_record", records };
    const next = records.slice();
    next.splice(existingIndex, 1);
    return { action: "deleted", records: next };
  }

  if (isCreate) {
    if (existing) {
      // Some backends may follow a `.created` with a redundant
      // `.updated`-shaped event, or the create event could legitimately
      // arrive twice under retry semantics -- either way, if we already
      // have this record, treat it as an update instead of inserting a
      // second copy.
      const patched = mergeChanges ? mergeChanges(existing, event.changes) : ({ ...existing, ...event.changes } as T);
      const withVersion = typeof event.version === "number" ? { ...patched, version: event.version } : patched;
      if (matchesCurrentView && !matchesCurrentView(withVersion)) {
        // The record used to be in view but no longer matches (e.g. its
        // status changed via this same payload) -- remove it rather than
        // leaving a stale, filtered-out row visible.
        const next = records.slice();
        next.splice(existingIndex, 1);
        return { action: "updated", records: next };
      }
      const next = records.slice();
      next[existingIndex] = withVersion;
      return { action: "updated", records: next };
    }

    if (!buildFromEvent) {
      // No way to construct a full record from the event's (deliberately
      // small -- see `Event.changes`'s docstring) payload alone. Silently
      // ignoring is the correct, safe default here (Phase 2 brief section
      // 9 warns against blindly inserting incomplete data): a page that
      // wants live create support supplies `buildFromEvent`; a page that
      // doesn't is unaffected, exactly as before this event even existed.
      return { action: "ignored_no_builder", records };
    }
    const built = buildFromEvent(event);
    if (!built) return { action: "ignored_no_builder", records };
    if (matchesCurrentView && !matchesCurrentView(built)) {
      return { action: "ignored_not_in_view", records };
    }
    return { action: "created", records: [built, ...records] };
  }

  if (isUpdate) {
    if (!existing) {
      // An update for a record this page never loaded (e.g. it's on a
      // different page of a paginated list) -- nothing to patch, and
      // nothing to insert either (Phase 2 brief's create-event filtering
      // logic doesn't apply to plain updates; an update event for a
      // record outside the current page/view is simply not this view's
      // concern).
      return { action: "no_matching_record", records };
    }
    const patched = mergeChanges ? mergeChanges(existing, event.changes) : ({ ...existing, ...event.changes } as T);
    const withVersion = typeof event.version === "number" ? { ...patched, version: event.version } : patched;
    if (matchesCurrentView && !matchesCurrentView(withVersion)) {
      // The patched record no longer matches the active filter/search --
      // e.g. Status=Active filter, and this update just set it Inactive.
      // Remove it from view rather than leaving a now-mismatched row.
      const next = records.slice();
      next.splice(existingIndex, 1);
      return { action: "updated", records: next };
    }
    const next = records.slice();
    next[existingIndex] = withVersion;
    return { action: "updated", records: next };
  }

  return { action: "ignored_unknown_action", records };
}
