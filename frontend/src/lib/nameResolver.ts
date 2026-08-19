/**
 * Bounded name-resolution cache, keyed by "tableKey:id".
 *
 * Used by list tables to show a related entity's name (e.g. a supplier's
 * Category names) without preloading the entire related table. Only resolves
 * IDs it hasn't already seen this session, and only for the IDs actually
 * present in the current page of results -- so cost scales with page size, not
 * with how large the underlying master table is.
 *
 * Ported from the NameResolver IIFE in dropdown-search.js. Each fetcher turns a
 * list of ids into [id, label] pairs; a fetcher that resolves ids one-by-one
 * with Promise.all works just as well as one hitting a batch endpoint, since
 * the cache only cares about the final pairs.
 */

/**
 * Shared global in-memory name resolution cache, keyed by "tableKey:id".
 * Preserved across components and re-renders during the user session.
 */
const globalCache: Record<string, Record<string, string>> = {};

export type NameFetcher = (ids: string[]) => Promise<[string, string][]>;

export interface NameResolverInstance {
  get(tableKey: string, id?: string | null): string | undefined;
  resolve(tableKey: string, ids: (string | null | undefined)[]): Promise<void>;
  set(tableKey: string, id: string, name: string): void;
  clear(tableKey?: string): void;
}

export function createNameResolver(
  fetchers: Record<string, NameFetcher>
): NameResolverInstance {
  return {
    get(tableKey, id) {
      if (!id) return undefined;
      return globalCache[tableKey]?.[id];
    },

    set(tableKey, id, name) {
      if (!id || !name) return;
      globalCache[tableKey] = globalCache[tableKey] || {};
      globalCache[tableKey][id] = name;
    },

    clear(tableKey) {
      if (tableKey) {
        delete globalCache[tableKey];
      } else {
        Object.keys(globalCache).forEach((k) => delete globalCache[k]);
      }
    },

    async resolve(tableKey, ids) {
      const fetcher = fetchers[tableKey];
      if (!fetcher) return;
      globalCache[tableKey] = globalCache[tableKey] || {};
      const table = globalCache[tableKey];
      const missing = [...new Set(ids)].filter(
        (id): id is string => Boolean(id) && !(id as string in table)
      );
      if (!missing.length) return;
      try {
        const pairs = await fetcher(missing);
        for (const [id, label] of pairs) {
          table[id] = label;
        }
      } catch {
        /* best-effort -- fallback shown for unresolved ids */
      }
    },
  };
}

