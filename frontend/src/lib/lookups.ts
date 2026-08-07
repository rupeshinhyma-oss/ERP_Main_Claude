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

export function useLookup<T>(apiBase: string, pageSize = 250): LookupResult<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await apiGet<T[]>(
          apiBase +
            toQueryString({ page: 1, page_size: pageSize, sort_order: "asc", status: "active" })
        );
        if (!cancelled) setItems(data || []);
      } catch {
        /* filters and dropdowns degrade gracefully without lookups */
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, pageSize]);

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
