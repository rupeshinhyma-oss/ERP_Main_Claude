/**
 * Bounded Event Deduplication Cache.
 *
 * Tracks which `event_id`s have already been applied, so a duplicate
 * delivery (e.g. a reconnect replaying something already processed, or --
 * per the Phase 2 brief section 12 -- a genuine double-send) is applied
 * once, not twice.
 *
 * Deliberately NOT an ever-growing array/Set of every event this tab has
 * ever seen (explicitly forbidden by section 12: "Do not create an
 * unbounded array of every event ever received"). Backed by a `Map`
 * insertion-ordered by nature, so the oldest entry is always the first
 * one evicted once the cache is full -- a simple, dependency-free LRU-ish
 * bound that needs no extra library for what is, realistically, a few
 * hundred recent event IDs at most.
 */

const DEFAULT_MAX_SIZE = 500;

export class EventDedupeCache {
  private readonly maxSize: number;
  private readonly seen = new Map<string, true>();

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Records `eventId` as seen and returns `true` if it was ALREADY
   * present (i.e. this is a duplicate the caller should skip applying).
   * Returns `false` for a genuinely new event ID (and records it).
   */
  isDuplicate(eventId: string): boolean {
    if (this.seen.has(eventId)) {
      return true;
    }
    this.seen.set(eventId, true);
    if (this.seen.size > this.maxSize) {
      // Map iteration order is insertion order, so the first key is
      // always the oldest -- evict it to keep the cache's size bounded.
      const oldestKey = this.seen.keys().next().value;
      if (oldestKey !== undefined) this.seen.delete(oldestKey);
    }
    return false;
  }

  /** Current number of tracked event IDs. Mainly for tests/diagnostics. */
  get size(): number {
    return this.seen.size;
  }

  clear(): void {
    this.seen.clear();
  }
}
