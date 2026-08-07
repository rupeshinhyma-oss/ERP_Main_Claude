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

export type NameFetcher = (ids: string[]) => Promise<[string, string][]>;

export interface NameResolverInstance {
  get(tableKey: string, id?: string | null): string | undefined;
  resolve(tableKey: string, ids: (string | null | undefined)[]): Promise<void>;
}

export function createNameResolver(
  fetchers: Record<string, NameFetcher>
): NameResolverInstance {
  const cache: Record<string, Record<string, string>> = {};

  return {
    get(tableKey, id) {
      if (!id) return undefined;
      return cache[tableKey]?.[id];
    },

    async resolve(tableKey, ids) {
      const fetcher = fetchers[tableKey];
      if (!fetcher) return;
      cache[tableKey] = cache[tableKey] || {};
      const table = cache[tableKey];
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
        /* best-effort -- the table just shows a fallback for unresolved ids */
      }
    },
  };
}
