/**
 * Universal search dropdown, shown in the topbar.
 *
 * Ported from initUniversalSearch() in nav.js. Queries the backend's
 * `GET /search?q=` endpoint (app/search/service.py), which searches across
 * every major entity type -- organization, users, suppliers, products,
 * categories, brands, HSN codes, and the geography
 * and currency/UOM masters -- and groups results by category.
 *
 * The backend predates the SPA rewrite: it still returns legacy relative URLs
 * like `./users.html` as each result's target. resolveLegacyUrl() (in
 * lib/nav.ts) maps those to the matching React route so a result click
 * navigates client-side instead of hitting the server for a page that no
 * longer exists as a static file.
 */

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, isAbortError } from "@/lib/api";
import { resolveLegacyUrl } from "@/lib/nav";
import { useSearchController } from "@/lib/hooks";
import { ICONS, IconBox, IconSearch, type IconKey } from "./icons";
import type { SearchResultItem, UniversalSearchResponse } from "@/types";

function ResultIcon({ iconKey }: { iconKey: string }) {
  const Icon = ICONS[iconKey as IconKey] ?? IconBox;
  return <Icon className={undefined} width={16} height={16} />;
}

interface GroupedResults {
  category: string;
  items: SearchResultItem[];
}

function groupByCategory(results: SearchResultItem[]): GroupedResults[] {
  const order: string[] = [];
  const groups = new Map<string, SearchResultItem[]>();
  for (const item of results) {
    if (!groups.has(item.category)) {
      groups.set(item.category, []);
      order.push(item.category);
    }
    groups.get(item.category)!.push(item);
  }
  return order.map((category) => ({ category, items: groups.get(category)! }));
}

export function UniversalSearch() {
  const navigate = useNavigate();
  const search = useSearchController();

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [open, setOpen] = useState(false);
  const [errored, setErrored] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on any click outside the search box or its dropdown.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  function handleInput(value: string) {
    const cleanValue = value.trimStart();
    setQuery(cleanValue);
    setHighlightedIndex(-1);

    const trimmed = cleanValue.trim();
    if (!trimmed) {
      search.cancel();
      setOpen(false);
      setResults([]);
      setErrored(false);
      return;
    }

    void search.run(async (signal) => {
      try {
        const { data } = await apiGet<UniversalSearchResponse>(
          `/search?q=${encodeURIComponent(trimmed)}`,
          { signal }
        );
        setResults(data.results || []);
        setErrored(false);
        setOpen(true);
      } catch (err) {
        if (isAbortError(err)) return;
        setResults([]);
        setErrored(true);
        setOpen(true);
      }
    }, 250);
  }

  function goToResult(item: SearchResultItem) {
    setOpen(false);
    setQuery("");
    setResults([]);
    const path = resolveLegacyUrl(item.target_url);
    // Carry the matched record's id along as a query param so the
    // destination page can open that exact record's detail view/drawer on
    // arrival, instead of just landing on the bare list (see each page's
    // `id` search-param handling, e.g. Suppliers.tsx, Buyers.tsx,
    // Users.tsx, MasterPage.tsx, masters/Products.tsx).
    const separator = path.includes("?") ? "&" : "?";
    navigate(`${path}${separator}id=${encodeURIComponent(item.id)}`);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedIndex((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      if (highlightedIndex >= 0 && highlightedIndex < results.length) {
        e.preventDefault();
        goToResult(results[highlightedIndex]);
      }
    }
  }

  const grouped = groupByCategory(results);
  // Flat index -> result, matching the order rendered, so arrow-key
  // highlighting lines up with the grouped display.
  let flatIndex = -1;

  return (
    <div className="topbar-search-wrapper" ref={wrapperRef}>
      <div className="topbar-search">
        <IconSearch />
        <input
          type="text"
          autoComplete="off"
          placeholder="Search entire ERP (e.g. company, users, products, suppliers)..."
          value={query}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
      <div className={`universal-search-dropdown ${open ? "active" : ""}`}>
        {errored ? (
          <div className="search-no-results">Error executing search</div>
        ) : results.length === 0 ? (
          <div className="search-no-results">
            No results matching &quot;<strong>{query}</strong>&quot;
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.category}>
              <div className="search-group-header">
                <span>{group.category}</span>
                <span
                  style={{
                    fontSize: "10px",
                    fontWeight: 600,
                    background: "#cbd5e1",
                    color: "#1e293b",
                    padding: "1px 6px",
                    borderRadius: "10px",
                  }}
                >
                  {group.items.length}
                </span>
              </div>
              {group.items.map((item) => {
                flatIndex += 1;
                const isHighlighted = flatIndex === highlightedIndex;
                return (
                  <a
                    key={`${item.category}-${item.id}`}
                    className={`search-item ${isHighlighted ? "highlighted" : ""}`}
                    onClick={(e) => {
                      e.preventDefault();
                      goToResult(item);
                    }}
                  >
                    <div className="search-item-icon">
                      <ResultIcon iconKey={item.icon} />
                    </div>
                    <div className="search-item-content">
                      <div className="search-item-title">{item.title}</div>
                      <div className="search-item-subtitle">{item.subtitle || ""}</div>
                    </div>
                    <div className="search-item-badge">{item.category}</div>
                  </a>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}