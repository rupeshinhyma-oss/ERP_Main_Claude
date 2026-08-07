/**
 * Flexible, responsive pagination: page-size selector (20/25/50/100),
 * windowed page numbers with ellipses, and Previous/Next.
 *
 * Ported from renderFlexiblePagination() in api.js. The page-number window
 * algorithm, the "Showing A–B of C total (Page D of E)" wording and the inline
 * styling are reproduced as they were. (The original markup also carried an
 * invalid `justify-space-between` property alongside a valid
 * `justify-content: space-between`; only the valid one is kept, since the
 * other was inert.)
 */

import type { PaginationMeta } from "@/types";

const ALLOWED_SIZES = [20, 25, 50, 100];

export interface PaginationProps {
  pagination?: PaginationMeta;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}

/**
 * Which page numbers to show. Up to 7 pages are listed in full; beyond that
 * the current page keeps one neighbour on each side, with the first and last
 * page always pinned and "..." bridging the gaps.
 */
function getPageNumbers(current: number, total: number): (number | "...")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | "...")[] = [1];
  if (current > 3) pages.push("...");

  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);

  for (let i = start; i <= end; i++) {
    if (i > 1 && i < total) pages.push(i);
  }

  if (current < total - 2) pages.push("...");
  pages.push(total);
  return pages;
}

export function Pagination({
  pagination,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationProps) {
  if (!pagination) return null;

  const currentPage = pagination.current_page || 1;
  const totalPages = pagination.total_pages || 1;
  const totalRecords = pagination.total_records ?? pagination.total_items ?? 0;
  const effectivePageSize = pageSize || pagination.page_size || 20;

  const startItem = totalRecords > 0 ? (currentPage - 1) * effectivePageSize + 1 : 0;
  const endItem = Math.min(currentPage * effectivePageSize, totalRecords);

  const hasPrevious = pagination.has_previous ?? currentPage > 1;
  const hasNext = pagination.has_next ?? currentPage < totalPages;

  const pageNumbers = getPageNumbers(currentPage, totalPages);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexWrap: "wrap",
        gap: "12px",
        width: "100%",
        marginTop: "12px",
        paddingTop: "12px",
        borderTop: "1px solid var(--color-border, #e2e8f0)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "6px",
            fontSize: "13px",
            color: "var(--color-muted, #64748b)",
          }}
        >
          <span>Show</span>
          <select
            className="page-size-select"
            value={effectivePageSize}
            onChange={(e) => onPageSizeChange?.(parseInt(e.target.value, 10))}
            style={{
              padding: "4px 8px",
              border: "1px solid var(--color-border, #cbd5e0)",
              borderRadius: "var(--radius, 6px)",
              fontSize: "13px",
              background: "#fff",
              cursor: "pointer",
            }}
          >
            {ALLOWED_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span>per page</span>
        </div>
        <span className="muted" style={{ fontSize: "13px", color: "var(--color-muted, #64748b)" }}>
          Showing{" "}
          <strong>
            {startItem}–{endItem}
          </strong>{" "}
          of <strong>{totalRecords}</strong> total (Page {currentPage} of {totalPages})
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
        <button
          type="button"
          className="btn btn-small prev-page-btn"
          disabled={!hasPrevious}
          onClick={() => onPageChange(currentPage - 1)}
        >
          Previous
        </button>
        {pageNumbers.map((item, index) =>
          item === "..." ? (
            <span
              key={`gap-${index}`}
              style={{ padding: "4px 6px", color: "var(--color-muted, #64748b)", fontSize: "13px" }}
            >
              ...
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={`btn btn-small page-num-btn ${item === currentPage ? "btn-primary" : ""}`}
              disabled={item === currentPage}
              onClick={() => onPageChange(item)}
              style={
                item === currentPage
                  ? { fontWeight: 700, minWidth: "32px" }
                  : { minWidth: "32px" }
              }
            >
              {item}
            </button>
          )
        )}
        <button
          type="button"
          className="btn btn-small next-page-btn"
          disabled={!hasNext}
          onClick={() => onPageChange(currentPage + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
