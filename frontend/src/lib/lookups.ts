/**
 * Lookup-list loader for master pages whose forms/filters need another
 * master table (States needs Countries, Products needs five of them).
 *
 * Mirrors the original `loadLookups()` calls: one request per table, always
 * `status=active`, `sort_order=asc`, with the same page sizes the pages used
 * (250 for small tables, 500/1000 where the table is expected to be larger).
 */

import { useEffect, useMemo, useState } from "react";
import { apiGet, toQueryString } from "./api";

export interface LookupResult<T> {
  items: T[];
  /** Flips once the request settles; used to force a table reload. */
  loaded: boolean;
}

/**
 * Debounced, server-side search-as-you-type lookup for tables too large to
 * ever prefetch in full (e.g. Products, once it's grown past a few
 * thousand rows). Unlike `useLookup`, this does NOT fetch anything until
 * the caller has an actual search term -- an empty/short term returns an
 * empty list rather than the whole table, so it never pulls 1000+ rows
 * into browser memory just to populate a dropdown or check for a
 * duplicate code.
 *
 * Use this instead of `useLookup` for any lookup where the underlying
 * table is expected to reach large row counts. Small, bounded master
 * tables (categories, brands, UOM, etc.) should keep using `useLookup` --
 * prefetching a few hundred rows once is simpler and cheaper than
 * debounced search for those.
 */
export function useSearchableLookup<T>(
  apiBase: string,
  term: string,
  options?: { pageSize?: number; minChars?: number; debounceMs?: number }
): LookupResult<T> {
  const pageSize = options?.pageSize ?? 20;
  const minChars = options?.minChars ?? 2;
  const debounceMs = options?.debounceMs ?? 300;

  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < minChars) {
      setItems([]);
      setLoaded(true);
      return;
    }

    let cancelled = false;
    setLoaded(false);
    const timer = window.setTimeout(async () => {
      try {
        const { data } = await apiGet<T[]>(
          apiBase +
          toQueryString({
            page: 1,
            page_size: pageSize,
            sort_order: "asc",
            status: "active",
            search: trimmed,
          })
        );
        if (!cancelled) setItems(data || []);
      } catch {
        /* filters and dropdowns degrade gracefully without lookups */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }, debounceMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiBase, term, pageSize, minChars, debounceMs]);

  return useMemo(() => ({ items, loaded }), [items, loaded]);
}

const lookupCache = new Map<string, { items: any[]; timestamp: number }>();
const inFlightRequests = new Map<string, Promise<any[]>>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes in-memory cache

export function invalidateLookupCache(apiBase?: string) {
  if (apiBase) {
    for (const key of lookupCache.keys()) {
      if (key.startsWith(apiBase)) lookupCache.delete(key);
    }
  } else {
    lookupCache.clear();
  }
}

export function useLookup<T>(apiBase: string, pageSize = 250): LookupResult<T> {
  const cacheKey = `${apiBase}?page=1&page_size=${pageSize}&sort_order=asc&status=active`;
  const cached = lookupCache.get(cacheKey);
  const isFresh = cached && Date.now() - cached.timestamp < CACHE_TTL_MS;

  const [items, setItems] = useState<T[]>(isFresh ? (cached.items as T[]) : []);
  const [loaded, setLoaded] = useState<boolean>(Boolean(isFresh));

  useEffect(() => {
    if (isFresh) {
      setItems(cached.items as T[]);
      setLoaded(true);
      return;
    }

    let cancelled = false;

    // Check if an identical request is already in-flight (Promise Deduplication)
    let promise = inFlightRequests.get(cacheKey);
    if (!promise) {
      promise = apiGet<T[]>(
        apiBase +
        toQueryString({ page: 1, page_size: pageSize, sort_order: "asc", status: "active" })
      ).then(({ data }) => {
        const result = data || [];
        lookupCache.set(cacheKey, { items: result, timestamp: Date.now() });
        inFlightRequests.delete(cacheKey);
        return result;
      }).catch((err) => {
        inFlightRequests.delete(cacheKey);
        throw err;
      });
      inFlightRequests.set(cacheKey, promise);
    }

    promise
      .then((data) => {
        if (!cancelled) {
          setItems(data as T[]);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [apiBase, pageSize, cacheKey, isFresh]);

  return useMemo(() => ({ items, loaded }), [items, loaded]);
}

/** Builds an id -> label map for O(1) name lookups while rendering rows. */
export function useNameMap<T extends { id: string }>(
  items: T[],
  label: (item: T) => string
): (id?: string | null) => string {
  const map = useMemo(() => {
    const m = new Map<string, string>();
    items.forEach((item) => m.set(item.id, label(item)));
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  return (id) => (id ? map.get(id) ?? "—" : "—");
}