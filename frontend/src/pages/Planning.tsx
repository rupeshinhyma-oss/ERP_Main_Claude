/**
 * Shipment Planning.
 *
 * Models the "Master Planning Sheet" workbook as a live, editable grid:
 * one tab per branch sheet (Mum Branch, MP Branch, GJ Branch, ...), rows
 * are item/machine lines, columns are entirely admin-defined and
 * unlimited -- there is no hardcoded "Mum 40" column anywhere in this
 * file, an admin adds it (and as many more as they want) via "+ Column".
 *
 * Any cell can carry a CRM-style status tag (red = requirement raised,
 * blue = ordered to manufacturer, green = purchased, or a custom
 * admin-defined color) via the swatch button that appears on hover.
 *
 * Every structural change (row/column added, renamed, moved, deleted) and
 * every cell edit is recorded server-side with who/when; the "History"
 * button opens a drawer showing that trail for the current sheet.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { SearchableDropdown, type DropdownOption } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, API_BASE, ApiError, toQueryString } from "@/lib/api";
import { Auth } from "@/lib/auth";
import { useAuth } from "@/lib/hooks";
import { useLookup } from "@/lib/lookups";
import { useToast } from "@/lib/toast";
import { useLiveList } from "@/lib/live/useLiveList";
import { roleDisplayName } from "@/lib/permissionLabels";
import type { Role } from "@/types";
import type {
  MumColumnStatusHistoryEntry,
  PlanningAggregateFn,
  PlanningCell,
  PlanningCellStatusColor,
  PlanningChangeLogEntry,
  PlanningColumn,
  PlanningColumnSourceType,
  PlanningGrid,
  PlanningRow,
  PlanningSheet,
  PlanningStatusTag,
  SourceModuleInfo,
} from "@/types/planning";

/**
 * Maps a source_registry module key (see backend `app/planning/source_registry.py`)
 * to the REST list endpoint and display-label field used to search/resolve
 * records for that module in linked-lookup pickers. Shared by every place
 * that needs to search or resolve a source-module record (the row-link
 * picker and the "Add Row" picker when ITEM itself is linked-lookup), so
 * adding a new source module only needs an entry here, not one per picker.
 */
const SOURCE_MODULE_API: Record<string, string> = {
  product: "/masters/products",
  supplier: "/suppliers",
  buyer: "/buyers",
};
const SOURCE_MODULE_LABEL_FIELD: Record<string, string> = {
  product: "product_name",
  supplier: "company_name",
  buyer: "company_name",
};
import { BUILTIN_STATUS_COLORS } from "@/types/planning";

// Compact-grid sizing (spec: "cells have excessive horizontal width /
// vertical height / padding / header height / minimum width / unused
// whitespace... make the grid compact and dense like a practical ERP
// spreadsheet, while keeping text readable and cells comfortable enough
// to edit").
//
// Column width is no longer one fixed number for every column -- a
// column's default width is now computed from its OWN header label's
// length via `computeHeaderWidth` below (e.g. "TEST (Y/N)" gets a much
// narrower column than "SUPPLIER NAME", instead of both getting the same
// fixed width regardless of what they actually hold), and can be
// overridden per column by dragging its resize handle (persisted
// server-side via PlanningColumn.width_px, shared across every user
// viewing the sheet -- see that field's docstring for why this is
// server-side unlike Hide/Freeze).
//
// CELL_MIN_WIDTH is now only the absolute FLOOR every computed/dragged
// width is clamped to (so even a 1-character header like "Y" stays
// comfortably clickable/editable) -- not the width every column gets.
// ITEM_COL_WIDTH remains fixed (the ITEM column isn't user-resizable in
// this pass; it's derived from product names, not an admin-typed label,
// so auto-sizing it the same way wouldn't make sense).
const CELL_MIN_WIDTH = 64;
const CELL_MAX_WIDTH = 320;
const ITEM_COL_WIDTH = 240;

/**
 * Roughly how many pixels one character of a bold ~13px header label
 * needs, plus fixed padding/icon allowance (filter icon, source badge,
 * delete button on hover, etc. all share the header's horizontal space).
 * Deliberately an estimate, not exact text measurement (e.g. via canvas)
 * -- exact measurement would need to run per-column on every render and
 * still be immediately overridable by drag-resize anyway, so a cheap,
 * good-enough estimate that a user can always correct by dragging is a
 * better trade than the complexity of pixel-perfect auto-sizing.
 */
const HEADER_CHAR_WIDTH_PX = 7.2;
const HEADER_WIDTH_PADDING_PX = 40;

/**
 * Compute a column's default width purely from its header label's
 * length, clamped to [CELL_MIN_WIDTH, CELL_MAX_WIDTH] -- e.g. "Y/N" or
 * "Test (Y/N)" naturally lands near the floor, "Supplier Name" or a long
 * admin-typed header lands wider, both without any per-column type-based
 * guessing. Used as the fallback whenever a column has no manually-set
 * ``width_px`` yet (see PlanningColumn.width_px's docstring) -- once a
 * user drags a column's resize handle, that persisted value takes over
 * completely and this function is no longer consulted for that column.
 */
function computeHeaderWidth(label: string): number {
  const estimated = Math.ceil((label || "").length * HEADER_CHAR_WIDTH_PX) + HEADER_WIDTH_PADDING_PX;
  return Math.max(CELL_MIN_WIDTH, Math.min(CELL_MAX_WIDTH, estimated));
}

/** A column's effective width: its manually-resized width_px if set, otherwise computed from its header label. */
function effectiveColumnWidth(column: { name: string; width_px?: number | null }): number {
  if (column.width_px != null) return Math.max(CELL_MIN_WIDTH, Math.min(CELL_MAX_WIDTH, column.width_px));
  return computeHeaderWidth(column.name);
}

/**
 * Hide/Freeze are per-user *display* preferences (which columns to show,
 * which to pin while scrolling) -- not shared sheet data, so they live in
 * localStorage keyed by sheet rather than round-tripping through the
 * backend. Reused by the "Columns" panel and the header pin/hide buttons.
 */
/**
 * The Approval Date column gets a special eye/history button instead of
 * normal manual entry: hardcoded to the exact name "Approval Date"
 * (trimmed, case-insensitive, so "APPROVAL DATE " with a trailing space --
 * exactly as it appears in the source Excel sheet -- still matches).
 */
function isApprovalDateColumn(columnName: string): boolean {
  const name = (columnName || "").trim().toLowerCase();
  return name === "approval date" || name === "approval_date";
}

/**
 * Extract the group number from any column belonging to a "Mum N" group:
 * "Mum 2", "Mum2 Remarks", "NO. OF PKG MUM2", "TOTAL WEIGHT MUM2",
 * "TOTAL CBM MUM2" all return 2. Returns null for anything else (e.g.
 * "Mumbai Office" does not match -- the number is required right after
 * "mum", with only optional whitespace between).
 *
 * This is the single source of truth for "which columns belong together
 * as one Mum group" -- used by the eye/history popover (group entries by
 * this number), delete-column (cascade-delete the whole group), and
 * hide-column (cascade-hide the whole group) so all three features
 * always agree on grouping, instead of three separate regexes drifting
 * apart over time.
 */
/**
 * Extract the group number from a Mum-series column name (e.g. "Mum 3" ->
 * 3, "NO. OF PKG CN2" -> 2), using the sheet's OWN group label -- never a
 * hardcoded "mum" fallback. A sheet labeled "CN" or "TN" must not match a
 * column that merely happens to contain the literal substring "mum"
 * followed by digits (extremely unlikely in practice, but the point of
 * `mum_group_label` existing at all is that the label is NOT fixed to
 * "Mum" -- silently also accepting "mum" here defeated that for every
 * non-Mum-labeled sheet, and could inflate a numbering scan's max count
 * if any unrelated column happened to match).
 *
 * `label` should always be passed (the caller's `grid.sheet.mum_group_label`);
 * the parameterless fallback below only exists for the handful of
 * call sites that intentionally want "does this look like ANY group
 * column, using whatever label the sheet already has" without needing to
 * re-derive that label themselves (e.g. quick predicates over a column
 * name before the sheet's label has necessarily loaded) -- it still never
 * hardcodes "mum" as a second, always-on alternative.
 */
function mumGroupNumber(columnName: string, label?: string): number | null {
  const str = (columnName || "").trim();
  const effectiveLabel = label || "Mum";
  const escapedLabel = effectiveLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`${escapedLabel}\\s*(\\d+)`, "i");
  const match = str.match(regex);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isNaN(num) ? null : num;
}

function mumRemarksGroupNumber(columnName: string, label?: string): number | null {
  const str = (columnName || "").trim();
  const effectiveLabel = (label || "Mum").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${effectiveLabel}\\s*(\\d+)\\s*remarks$`, "i");
  const match = str.match(regex);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isNaN(num) ? null : num;
}

function hiddenColumnsStorageKey(sheetId: string): string {
  return `planning:hiddenColumns:${sheetId}`;
}
function frozenColumnsStorageKey(sheetId: string): string {
  return `planning:frozenColumns:${sheetId}`;
}
function loadColumnIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function PlanningGridSkeletonRows({
  columns,
  count = 10,
}: {
  columns: PlanningColumn[];
  count?: number;
}) {
  return (
    <>
      {Array.from({ length: count }).map((_, rIdx) => (
        <tr key={`plan-sk-row-${rIdx}`}>
          <td
            style={{
              position: "sticky",
              left: 0,
              zIndex: 3,
              background: "#F8FAFC",
              borderRight: "2px solid #CBD5E1",
              padding: "10px 12px",
              minWidth: 160,
              maxWidth: 220,
            }}
          >
            <div
              className="skeleton-line"
              style={{
                width: ["65%", "85%", "70%", "90%", "60%"][rIdx % 5],
                height: "15px",
                borderRadius: "4px",
              }}
            />
          </td>
          {columns.map((col, cIdx) => (
            <td
              key={`plan-sk-cell-${rIdx}-${col.id}`}
              style={{
                padding: "8px 10px",
                textAlign: col.data_type === "number" ? "right" : "left",
                minWidth: col.width_px || 120,
              }}
            >
              <div
                className="skeleton-line"
                style={{
                  width: col.data_type === "boolean_yn" ? "40px" : col.data_type === "date" ? "75px" : ["70%", "50%", "85%", "60%", "40%"][(rIdx + cIdx) % 5],
                  height: col.data_type === "boolean_yn" ? "18px" : "14px",
                  borderRadius: col.data_type === "boolean_yn" ? "10px" : "4px",
                  marginLeft: col.data_type === "number" ? "auto" : undefined,
                }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function statusSwatchColor(
  statusColor: PlanningCellStatusColor | null | undefined,
  customStatusTagId: string | null | undefined,
  customTags: PlanningStatusTag[]
): string | null {
  if (!statusColor) return null;
  if (statusColor === "custom") {
    const tag = customTags.find((t) => t.id === customStatusTagId);
    return tag?.hex_color ?? "#9CA3AF";
  }
  return BUILTIN_STATUS_COLORS[statusColor]?.hex ?? null;
}

function statusLabel(
  statusColor: PlanningCellStatusColor | null | undefined,
  customStatusTagId: string | null | undefined,
  customTags: PlanningStatusTag[]
): string {
  if (!statusColor) return "No status";
  if (statusColor === "custom") {
    const tag = customTags.find((t) => t.id === customStatusTagId);
    return tag?.label ?? "Custom";
  }
  return BUILTIN_STATUS_COLORS[statusColor]?.label ?? statusColor;
}

/**
 * Floating description popover — appears anchored below a column header when the
 * user clicks the ✎ description button. Pressing Enter saves; Shift+Enter inserts
 * a new line; Escape closes without saving.
 */
function DescriptionPopover({
  anchor,
  initialValue,
  onSave,
  onClose,
}: {
  anchor: HTMLElement;
  initialValue: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initialValue);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Snapshot position on initial mount so if anchor unmounts or mouse leaves the header, the popover remains locked in place
  const [pos] = useState(() => {
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(10, Math.min(rect.left, window.innerWidth - 290));
    const top =
      rect.bottom + 230 > window.innerHeight && rect.top > 240
        ? Math.max(10, rect.top - 220)
        : Math.max(10, Math.min(rect.bottom + 6, window.innerHeight - 240));
    return { top, left };
  });

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function commit() {
    onSave(text);
    onClose();
  }

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={() => { onSave(text); onClose(); }} />
      <div
        style={{
          position: "fixed",
          top: pos.top,
          left: pos.left,
          zIndex: 9999,
          background: "#fff",
          border: "1px solid #CBD5E1",
          borderRadius: 8,
          boxShadow: "0 10px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)",
          padding: 10,
          width: 270,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Description
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              onClose();
              e.stopPropagation();
            } else if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder="Add a note for this column…"
          rows={4}
          style={{
            width: "100%",
            border: "1px solid #E2E8F0",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 13,
            resize: "vertical",
            outline: "none",
            fontFamily: "inherit",
            boxSizing: "border-box",
          }}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{ fontSize: 12, padding: "4px 10px", border: "1px solid #E2E8F0", borderRadius: 5, background: "#fff", cursor: "pointer", color: "#64748B" }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            style={{ fontSize: 12, padding: "4px 10px", border: "none", borderRadius: 5, background: "#2563EB", color: "#fff", cursor: "pointer", fontWeight: 600 }}
          >
            Save
          </button>
        </div>
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4, textAlign: "right" }}>Enter to save · Shift+Enter for new line</div>
      </div>
    </>,
    document.body
  );
}

/**
 * Excel-style column filter popover:
 * Allows user to search unique values, check/uncheck specific values,
 * perform text search filter, and clear/apply filter.
 */
function ColumnFilterPopover({
  anchor,
  sheetId,
  columnId,
  columnName,
  organizationId,
  fallbackUniqueValues,
  currentFilter,
  onApply,
  onClear,
  onClose,
}: {
  anchor: HTMLElement;
  sheetId: string;
  columnId: string;
  columnName: string;
  organizationId?: string | null;
  fallbackUniqueValues: [string, number][];
  currentFilter?: { selectedValues?: Set<string>; textQuery?: string };
  onApply: (filter: { selectedValues?: Set<string>; textQuery?: string }) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const rect = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(10, rect.left), window.innerWidth - 280);
  const top = Math.min(rect.bottom + 6, window.innerHeight - 380);

  const [searchValue, setSearchValue] = useState(currentFilter?.textQuery || "");
  const [serverValues, setServerValues] = useState<[string, number][]>(fallbackUniqueValues);
  const [loadingValues, setLoadingValues] = useState(false);

  // Track if user explicitly clicked checkboxes to customize value selection
  const [hasModifiedSelection, setHasModifiedSelection] = useState(
    Boolean(currentFilter?.selectedValues && currentFilter.selectedValues.size > 0)
  );

  const [checkedValues, setCheckedValues] = useState<Set<string>>(() => {
    if (currentFilter?.selectedValues && currentFilter.selectedValues.size > 0) {
      return new Set(currentFilter.selectedValues);
    }
    return new Set();
  });

  // Fetch unique values from server across the entire dataset (all 1384+ items)
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoadingValues(true);
      try {
        const colParam = columnId === "item-header-col" ? "" : columnId;
        const qs = toQueryString({
          column_id: colParam || undefined,
          search: searchValue.trim() ? searchValue.trim() : undefined,
          ...(organizationId ? { organization_id: organizationId } : {}),
          limit: 1000,
        });
        const { data } = await apiGet<{ value: string; count: number }[]>(`/planning/sheets/${sheetId}/filter-values${qs}`);
        if (!cancelled && Array.isArray(data)) {
          const list: [string, number][] = data.map((item) => [item.value, item.count]);
          setServerValues(list);
        }
      } catch {
        // Fallback to local unique values gracefully
      } finally {
        if (!cancelled) setLoadingValues(false);
      }
    }, 150);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sheetId, columnId, organizationId, searchValue]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredUniqueValues = useMemo(() => {
    if (!searchValue.trim()) return serverValues;
    const q = searchValue.trim().toLowerCase();
    return serverValues.filter(([val]) => val.toLowerCase().includes(q));
  }, [serverValues, searchValue]);

  const isValueChecked = useCallback(
    (val: string) => {
      if (!hasModifiedSelection) {
        // By default (no custom checkbox changes), all items are considered selected
        return true;
      }
      return checkedValues.has(val);
    },
    [hasModifiedSelection, checkedValues]
  );

  const allFilteredChecked = useMemo(() => {
    if (filteredUniqueValues.length === 0) return false;
    if (!hasModifiedSelection) return true;
    return filteredUniqueValues.every(([v]) => checkedValues.has(v));
  }, [filteredUniqueValues, hasModifiedSelection, checkedValues]);

  const handleToggleAll = () => {
    setHasModifiedSelection(true);
    if (allFilteredChecked) {
      setCheckedValues((prev) => {
        const next = hasModifiedSelection ? new Set(prev) : new Set(filteredUniqueValues.map(([v]) => v));
        filteredUniqueValues.forEach(([v]) => next.delete(v));
        return next;
      });
    } else {
      setCheckedValues((prev) => {
        const next = new Set(prev);
        filteredUniqueValues.forEach(([v]) => next.add(v));
        return next;
      });
    }
  };

  const handleToggleValue = (val: string) => {
    setCheckedValues((prev) => {
      let next: Set<string>;
      if (!hasModifiedSelection) {
        // First explicit click: start from all currently filtered values except the toggled one
        next = new Set(filteredUniqueValues.map(([v]) => v));
        next.delete(val);
      } else {
        next = new Set(prev);
        if (next.has(val)) {
          next.delete(val);
        } else {
          next.add(val);
        }
      }
      return next;
    });
    setHasModifiedSelection(true);
  };

  const handleApply = () => {
    const hasText = searchValue.trim().length > 0;
    const textQuery = hasText ? searchValue.trim() : undefined;

    if (!hasModifiedSelection) {
      // User only searched by text or left default select-all
      if (!textQuery) {
        onClear();
      } else {
        onApply({ textQuery, selectedValues: undefined });
      }
      onClose();
      return;
    }

    // User customized checkbox selections
    if (checkedValues.size === 0) {
      // Nothing selected
      onApply({ textQuery, selectedValues: new Set(["__NO_MATCH__"]) });
    } else if (!hasText && serverValues.length > 0 && checkedValues.size >= serverValues.length) {
      // All checked and no text search -> no filter needed
      onClear();
    } else {
      onApply({ textQuery, selectedValues: new Set(checkedValues) });
    }
    onClose();
  };

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 9999,
          background: "#FFFFFF",
          border: "1px solid #CBD5E1",
          borderRadius: 8,
          boxShadow: "0 10px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)",
          padding: 12,
          width: 260,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #E2E8F0", paddingBottom: 6 }}>
          <span style={{ fontWeight: 600, color: "#0F172A", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 190 }} title={columnName}>
            Filter: {columnName}
          </span>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "#64748B", fontSize: 14 }}>
            ✕
          </button>
        </div>

        <div style={{ position: "relative", width: "100%" }}>
          <input
            type="text"
            placeholder="Search items..."
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            style={{
              width: "100%",
              boxSizing: "border-box",
              padding: "5px 8px",
              fontSize: 12,
              borderRadius: 5,
              border: "1px solid #CBD5E1",
              outline: "none",
            }}
          />
          {loadingValues && (
            <span style={{ position: "absolute", right: 8, top: 6, fontSize: 10, color: "#94A3B8" }}>
              Loading…
            </span>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 600, color: "#334155" }}>
            <input
              type="checkbox"
              checked={allFilteredChecked}
              onChange={handleToggleAll}
            />
            (Select All)
          </label>
          <button
            type="button"
            onClick={() => {
              setHasModifiedSelection(true);
              setCheckedValues(new Set());
            }}
            style={{ border: "none", background: "transparent", color: "#2563EB", cursor: "pointer", fontSize: 11, padding: 0 }}
          >
            Clear
          </button>
        </div>

        <div style={{ maxHeight: 180, overflowY: "auto", border: "1px solid #F1F5F9", borderRadius: 6, padding: "4px 6px", display: "flex", flexDirection: "column", gap: 3 }}>
          {filteredUniqueValues.length === 0 ? (
            <div style={{ color: "#94A3B8", fontSize: 12, padding: "8px 0", textAlign: "center" }}>
              {loadingValues ? "Searching all records…" : "No matching items"}
            </div>
          ) : (
            filteredUniqueValues.map(([val, count]) => (
              <label
                key={val}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  color: "#334155",
                  padding: "2px 4px",
                  borderRadius: 4,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                  <input
                    type="checkbox"
                    checked={isValueChecked(val)}
                    onChange={() => handleToggleValue(val)}
                  />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={val}>
                    {val}
                  </span>
                </div>
                <span style={{ fontSize: 10, color: "#94A3B8", flexShrink: 0 }}>({count})</span>
              </label>
            ))
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ flex: 1, padding: "4px 8px", fontSize: 12 }}
            onClick={() => {
              onClear();
              onClose();
            }}
          >
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary"
            style={{ flex: 1, padding: "4px 8px", fontSize: 12 }}
            onClick={handleApply}
          >
            Apply
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
function isSystemColumn(name: string): boolean {
  const cleaned = (name || "").trim().toLowerCase();
  return cleaned === "item" || cleaned === "test(y/n)" || cleaned.includes("test (y/n)") || cleaned === "approval date";
}

function isPureMumColumn(name: string, label?: string): boolean {
  const cleaned = (name || "").trim().toLowerCase();
  if (cleaned.includes("remark") || cleaned.startsWith("no. of pkg") || cleaned.startsWith("total")) {
    return false;
  }
  if (label) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^(?:${escapedLabel}|mum)\\s*\\d+$`, "i");
    if (regex.test(cleaned)) return true;
  }
  return /^(?:mum|[a-z0-9_-]+)\s*\d+$/i.test(cleaned);
}

function formatDaysMonthYear(dateStr: string | null | undefined): string {
  if (!dateStr) return "";
  const trimmed = String(dateStr).trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const [, yyyy, mm, dd] = match;
    return `${dd}/${mm}/${yyyy}`;
  }
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

/** Popover for showing a row's Mum-series status history feed. */
function MumStatusHistoryPopover({
  anchor,
  sheetId,
  rowId,
  visibleMumGroupNumbers,
  mumGroupLabel,
  onClose,
}: {
  anchor: HTMLElement;
  sheetId: string;
  rowId: string;
  visibleMumGroupNumbers?: Set<number>;
  /** The sheet's own group label (e.g. "Mum"/"CN"/"TN") -- required to correctly parse group numbers out of column names like "CN2"; never assume "Mum". */
  mumGroupLabel?: string;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<MumColumnStatusHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const rect = anchor.getBoundingClientRect();

  useEffect(() => {
    let active = true;
    apiGet<MumColumnStatusHistoryEntry[]>(`/planning/sheets/${sheetId}/rows/${rowId}/mum-status-history`)
      .then(({ data }) => {
        if (active) setEntries(data || []);
      })
      .catch(() => {
        if (active) setEntries([]);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sheetId, rowId]);

  /**
   * Group every entry (status change OR value edit) by its Mum group
   * number, newest-first within each group -- unlike the old behavior
   * (kept only the single latest status entry per group, discarding the
   * rest), this keeps the FULL history so the eye button shows every
   * time a cell's color or value ever changed, who did it, and when.
   * Deleted columns are already excluded server-side (the backend only
   * returns entries for columns still on the sheet -- see
   * PlanningService.get_mum_column_status_history_for_row's docstring),
   * and hidden columns are excluded here the same way the old code did,
   * via visibleMumGroupNumbers (hide is a local/client-side display
   * preference, so filtering it here rather than server-side is
   * intentional -- see hiddenColumnsStorageKey).
   */
  const groupedEntries = useMemo(() => {
    if (!entries || entries.length === 0) return [];
    const byGroup = new Map<number, MumColumnStatusHistoryEntry[]>();
    const unGrouped: MumColumnStatusHistoryEntry[] = [];

    for (const entry of entries) {
      const groupNum = mumGroupNumber(entry.column_name, mumGroupLabel);
      if (groupNum === null) {
        unGrouped.push(entry);
        continue;
      }
      if (visibleMumGroupNumbers && visibleMumGroupNumbers.size > 0 && !visibleMumGroupNumbers.has(groupNum)) {
        continue;
      }
      const list = byGroup.get(groupNum);
      if (list) list.push(entry);
      else byGroup.set(groupNum, [entry]);
    }

    for (const list of byGroup.values()) {
      list.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());
    }
    unGrouped.sort((a, b) => new Date(b.changed_at).getTime() - new Date(a.changed_at).getTime());

    const grouped = [...byGroup.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([groupNum, groupEntries]) => ({ groupNum, entries: groupEntries }));
    if (unGrouped.length > 0) grouped.push({ groupNum: 9000, entries: unGrouped });
    return grouped;
  }, [entries, visibleMumGroupNumbers, mumGroupLabel]);

  function formatEntryTime(changedAt: string): string {
    const d = new Date(changedAt);
    if (isNaN(d.getTime())) return changedAt;
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${day}/${month}/${year} ${hours}:${minutes}`;
  }

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top: Math.max(10, Math.min(rect.bottom + 4, window.innerHeight - 340)),
          left: Math.max(10, Math.min(rect.left, window.innerWidth - 340)),
          zIndex: 9999,
          width: 320,
          maxHeight: 380,
          overflowY: "auto",
          background: "#fff",
          border: "1px solid #CBD5E1",
          borderRadius: 8,
          boxShadow: "0 10px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)",
          padding: 12,
          textAlign: "left",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Cell Change History
        </div>
        {loading ? (
          <div className="muted" style={{ fontSize: 12 }}>Loading history…</div>
        ) : !groupedEntries || groupedEntries.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>No changes recorded on these columns yet.</div>
        ) : (
          groupedEntries.map(({ groupNum, entries: groupEntries }) => (
            <div key={groupNum} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#334155", marginBottom: 4 }}>
                {groupEntries[0].column_name}
              </div>
              {groupEntries.map((e, i) => {
                const isStatus = (e.entry_type ?? "status") === "status";
                const builtinEntry =
                  isStatus && e.new_status && e.new_status !== "custom"
                    ? BUILTIN_STATUS_COLORS[e.new_status as Exclude<PlanningCellStatusColor, "custom">]
                    : undefined;
                const swatch = isStatus ? builtinEntry?.hex ?? "#94A3B8" : "#94A3B8";

                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "5px 0",
                      borderBottom: i < groupEntries.length - 1 ? "1px solid #F1F5F9" : "none",
                    }}
                  >
                    {isStatus ? (
                      <span
                        style={{ width: 10, height: 10, borderRadius: "50%", background: swatch, flexShrink: 0, marginTop: 3 }}
                      />
                    ) : (
                      <span
                        title="Value edited"
                        style={{ width: 10, textAlign: "center", flexShrink: 0, marginTop: 1, fontSize: 11, color: "#94A3B8" }}
                      >
                        ✎
                      </span>
                    )}
                    <div style={{ fontSize: 12, color: "#334155", flex: 1, minWidth: 0 }}>
                      {isStatus ? (
                        <div>
                          <span style={{ fontWeight: 600, color: swatch !== "#94A3B8" ? swatch : "#475569" }}>
                            {e.new_status ? builtinEntry?.label || e.new_status : "Cleared"}
                          </span>
                        </div>
                      ) : (
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ color: "#94A3B8" }}>{e.old_value || "(empty)"}</span>
                          {" → "}
                          <span style={{ fontWeight: 600, color: "#0F172A" }}>{e.new_value || "(empty)"}</span>
                        </div>
                      )}
                      <div style={{ fontSize: 11, color: "#64748B", marginTop: 1 }}>
                        {formatEntryTime(e.changed_at)} · <span style={{ color: "#334155", fontWeight: 500 }}>{e.changed_by_username}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>,
    document.body
  );
}

function GridCell({
  value,
  displayValue,
  statusColor,
  customStatusTagId,
  customTags,
  canEdit,
  canSetStatus,
  sourceType,
  enableStatusColor,
  showMumHistory,
  saveStatus,
  onSave,
  onRetrySave,
  onOpenStatusPicker,
  onOpenMumHistory,
  onOpenLinkPicker,
  isFrozen,
  isLastFrozen,
  stickyLeft,
  width,
  disabledReason,
  onDisabledClick,
}: {
  value: string | null | undefined;
  displayValue: string | null | undefined;
  statusColor: PlanningCellStatusColor | null | undefined;
  customStatusTagId: string | null | undefined;
  customTags: PlanningStatusTag[];
  canEdit: boolean;
  canSetStatus?: boolean;
  sourceType: PlanningColumnSourceType;
  enableStatusColor?: boolean;
  /** True only for the Approval Date column -- adds the Mum-status-history eye button. */
  showMumHistory?: boolean;
  /** "saving" while the optimistic write is in flight/retrying, "error" if every retry failed. Undefined once confirmed saved. */
  saveStatus?: "saving" | "error";
  onSave: (newValue: string) => void;
  /** Re-attempt a failed save with the value already shown (only relevant when saveStatus === "error"). */
  onRetrySave?: () => void;
  onOpenStatusPicker: (anchor: HTMLElement) => void;
  onOpenMumHistory?: (anchor: HTMLElement) => void;
  onOpenLinkPicker: () => void;
  isFrozen?: boolean;
  isLastFrozen?: boolean;
  stickyLeft?: number;
  /** This column's effective width (computed from its header label, or manually resized). Falls back to CELL_MIN_WIDTH if omitted. */
  width?: number;
  /** If provided, prevents editing and displays as disabled with tooltip/toast. */
  disabledReason?: string;
  onDisabledClick?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const swatch = statusSwatchColor(statusColor, customStatusTagId, customTags);
  const isManual = sourceType === "manual";
  const rawShownValue = isManual ? (value ?? displayValue) : (displayValue ?? value);
  const shownValue = showMumHistory ? formatDaysMonthYear(rawShownValue) : rawShownValue;
  const colWidth = width ?? CELL_MIN_WIDTH;
  const isBlocked = !!disabledReason;
  const isActuallyEditable = canEdit && isManual && !isBlocked;
  const canInteractWithStatus = canSetStatus ?? canEdit;
  const hasValidValue = (() => {
    const val = (value ?? "").trim();
    if (!val || val === "0") return false;
    const num = Number(val);
    return !isNaN(num) ? num > 0 : true;
  })();
  const effectiveSwatch = hasValidValue ? swatch : undefined;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== (value ?? "")) onSave(draft);
  }

  function handleCellClick() {
    if (isBlocked) {
      if (onDisabledClick) onDisabledClick();
      return;
    }
    if (isActuallyEditable) {
      setEditing(true);
    }
  }

  const bg = isFrozen
    ? (!isManual || isBlocked ? "#F8FAFC" : "#fff")
    : (!isManual || isBlocked ? "#F8FAFC" : "#fff");

  return (
    <td
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: isFrozen ? "sticky" : "relative",
        left: isFrozen ? stickyLeft : undefined,
        zIndex: isFrozen ? 3 : undefined,
        minWidth: colWidth,
        width: colWidth,
        maxWidth: colWidth,
        boxSizing: "border-box",
        padding: 0,
        textAlign: "center",
        borderBottom: "1px solid #F1F5F9",
        borderLeft: "3px solid transparent",
        borderRight: isFrozen && isLastFrozen ? "2px solid #CBD5E1" : "1px solid #F1F5F9",
        backgroundColor: bg,
        boxShadow: isFrozen && isLastFrozen ? "3px 0 6px -2px rgba(0,0,0,0.15)" : undefined,
      }}
      className="planning-cell"
    >
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 26, padding: "3px 5px" }}>
        {editing && isActuallyEditable ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(value ?? "");
                setEditing(false);
              }
            }}
            style={{
              width: "100%",
              border: "1px solid #2563EB",
              borderRadius: 4,
              padding: "3px 5px",
              fontSize: 13,
              textAlign: "center",
              color: effectiveSwatch || undefined,
              fontWeight: effectiveSwatch ? 600 : undefined,
            }}
          />
        ) : (
          <span
            onClick={handleCellClick}
            title={
              disabledReason
                ? disabledReason
                : !isManual
                  ? `Computed (${sourceType}) — not directly editable`
                  : statusColor
                    ? statusLabel(statusColor, customStatusTagId, customTags)
                    : undefined
            }
            style={{
              width: "100%",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              cursor: isBlocked ? "not-allowed" : isActuallyEditable ? "text" : "default",
              fontSize: 13,
              minHeight: 18,
              display: "block",
              textAlign: "center",
              fontStyle: !isManual ? "italic" : undefined,
              color: isBlocked ? "#94A3B8" : effectiveSwatch || (!isManual ? "#475569" : undefined),
              fontWeight: effectiveSwatch ? 600 : undefined,
              opacity: isBlocked ? 0.7 : 1,
            }}
          >
            {shownValue || ""}
          </span>
        )}
        <div
          style={{
            position: "absolute",
            right: 4,
            top: "50%",
            transform: "translateY(-50%)",
            display: "flex",
            alignItems: "center",
            gap: 3,
            background: bg,
            zIndex: 2,
          }}
        >
          {sourceType === "linked_lookup" && canEdit && (
            <button
              type="button"
              onClick={onOpenLinkPicker}
              title="Link this row to a record"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#2563EB", fontSize: 11, flexShrink: 0 }}
            >
              🔗
            </button>
          )}
          {saveStatus === "saving" && (
            <span
              title="Saving…"
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                border: "1.5px solid #94A3B8",
                borderTopColor: "transparent",
                flexShrink: 0,
                animation: "planning-save-spin 0.7s linear infinite",
              }}
            />
          )}
          {saveStatus === "error" && (
            <button
              type="button"
              onClick={onRetrySave}
              title="Couldn't save yet -- click to retry"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "#DC2626",
                fontSize: 12,
                flexShrink: 0,
                padding: 0,
              }}
            >
              ⚠
            </button>
          )}
          {canInteractWithStatus && !editing && enableStatusColor && hasValidValue && (hovered || effectiveSwatch) && (
            <button
              type="button"
              className="planning-status-dot"
              onClick={(e) => onOpenStatusPicker(e.currentTarget)}
              title={statusLabel(statusColor, customStatusTagId, customTags)}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: effectiveSwatch ? "none" : "1px dashed #CBD5E1",
                background: effectiveSwatch || "transparent",
                flexShrink: 0,
                cursor: "pointer",
                opacity: effectiveSwatch ? 1 : 0.4,
              }}
            />
          )}
          {!canInteractWithStatus && !editing && enableStatusColor && effectiveSwatch && (
            <span
              className="planning-status-dot-static"
              title={statusLabel(statusColor, customStatusTagId, customTags)}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: effectiveSwatch,
                flexShrink: 0,
                opacity: 1,
              }}
            />
          )}
          {showMumHistory && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenMumHistory?.(e.currentTarget);
              }}
              title="View Mum column status history for this row"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "#94A3B8",
                fontSize: 13,
                padding: "1px 3px",
                flexShrink: 0,
              }}
            >
              👁
            </button>
          )}
        </div>
      </div>
    </td>
  );
}

/** Popover for picking/clearing a cell's CRM-style status color. */
function StatusPicker({
  anchor,
  customTags,
  onPick,
  onClose,
  canPickRed,
  canPickGreen,
  canPickBlue,
  canPickCustom,
  canClearStatus,
}: {
  anchor: HTMLElement;
  customTags: PlanningStatusTag[];
  onPick: (color: PlanningCellStatusColor | null, customTagId: string | null) => void;
  onClose: () => void;
  canPickRed: boolean;
  canPickGreen: boolean;
  canPickBlue: boolean;
  canPickCustom: boolean;
  canClearStatus: boolean;
}) {
  const rect = anchor.getBoundingClientRect();
  const top =
    rect.bottom + 250 > window.innerHeight && rect.top > 260
      ? Math.max(10, rect.top - 250)
      : Math.max(10, Math.min(rect.bottom + 6, window.innerHeight - 250));
  const left = Math.max(10, Math.min(rect.left, window.innerWidth - 230));

  return createPortal(
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 9998 }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 9999,
          background: "#fff",
          border: "1px solid #E2E8F0",
          borderRadius: 8,
          boxShadow: "0 10px 25px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)",
          padding: 8,
          width: 210,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", padding: "2px 6px 6px" }}>SET STATUS</div>
        {(Object.entries(BUILTIN_STATUS_COLORS) as [PlanningCellStatusColor, { label: string; hex: string }][]).map(
          ([key, { label, hex }]) => {
            const isBlocked =
              (key === "red_requirement" && !canPickRed) ||
              (key === "green_purchased" && !canPickGreen) ||
              (key === "blue_ordered" && !canPickBlue);
            return (
              <button
                key={key}
                type="button"
                disabled={isBlocked}
                title={isBlocked ? "You don't have permission to set this status color." : undefined}
                onClick={() => {
                  if (isBlocked) return;
                  onPick(key, null);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  width: "100%",
                  padding: "6px 8px",
                  border: "none",
                  background: "transparent",
                  borderRadius: 6,
                  cursor: isBlocked ? "not-allowed" : "pointer",
                  fontSize: 13,
                  textAlign: "left",
                  opacity: isBlocked ? 0.4 : 1,
                }}
                onMouseEnter={(e) => {
                  if (!isBlocked) e.currentTarget.style.background = "#F1F5F9";
                }}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ width: 12, height: 12, borderRadius: "50%", background: hex, flexShrink: 0 }} />
                {label}
              </button>
            );
          }
        )}
        {customTags.length > 0 && <div style={{ borderTop: "1px solid #EEF2F6", margin: "6px 0" }} />}
        {customTags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            disabled={!canPickCustom}
            title={!canPickCustom ? "You don't have permission to set custom status tags." : undefined}
            onClick={() => {
              if (!canPickCustom) return;
              onPick("custom", tag.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 8px",
              border: "none",
              background: "transparent",
              borderRadius: 6,
              cursor: !canPickCustom ? "not-allowed" : "pointer",
              fontSize: 13,
              textAlign: "left",
              opacity: !canPickCustom ? 0.4 : 1,
            }}
            onMouseEnter={(e) => {
              if (canPickCustom) e.currentTarget.style.background = "#F1F5F9";
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: tag.hex_color, flexShrink: 0 }} />
            {tag.label}
          </button>
        ))}
        <div style={{ borderTop: "1px solid #EEF2F6", margin: "6px 0" }} />
        <button
          type="button"
          disabled={!canClearStatus}
          title={!canClearStatus ? "You don't have permission to clear status." : undefined}
          onClick={() => {
            if (!canClearStatus) return;
            onPick(null, null);
          }}
          style={{
            width: "100%",
            padding: "6px 8px",
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: !canClearStatus ? "not-allowed" : "pointer",
            fontSize: 13,
            color: "#94A3B8",
            textAlign: "left",
            opacity: !canClearStatus ? 0.4 : 1,
          }}
          onMouseEnter={(e) => {
            if (canClearStatus) e.currentTarget.style.background = "#F1F5F9";
          }}
          onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
        >
          Clear status
        </button>
      </div>
    </>,
    document.body
  );
}

/** Drawer listing a sheet's (or one row's/column's) change history: who, when, what. */
function HistoryDrawer({
  entries,
  loading,
  onClose,
}: {
  entries: PlanningChangeLogEntry[];
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, display: "flex", justifyContent: "flex-end" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.35)" }} onClick={onClose} />
      <div
        style={{
          position: "relative",
          width: 420,
          maxWidth: "100%",
          height: "100%",
          background: "#fff",
          boxShadow: "-8px 0 24px rgba(0,0,0,0.12)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div style={{ padding: "16px 20px", borderBottom: "1px solid #E2E8F0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>Change History</div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 18, color: "#64748B" }}>
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
          {loading ? (
            <div className="muted" style={{ padding: 20 }}>Loading history…</div>
          ) : entries.length === 0 ? (
            <div className="muted" style={{ padding: 20 }}>No changes recorded yet.</div>
          ) : (
            entries.map((e) => (
              <div key={e.id} style={{ padding: "10px 20px", borderBottom: "1px solid #F1F5F9" }}>
                <div style={{ fontSize: 13, color: "#0F172A" }}>{e.description || e.action}</div>
                <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 2 }}>
                  {e.changed_by_username_snapshot} · {new Date(e.created_at).toLocaleString()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function PlanningPage() {
  const { hasPermission } = useAuth();
  const showToast = useToast();
  const canManageColumns = hasPermission("planning.column.manage");
  const canEditCells = hasPermission("planning.cell.edit");
  const canEditTestYN = hasPermission("planning.textyn.edit");
  const canEditApprovalDate = hasPermission("planning.approvaldate.edit");
  const canSetRedStatus = hasPermission("planning.colorstatusred.edit");
  const canSetGreenStatus = hasPermission("planning.colorstatusgreen.edit");

  const [searchParams, setSearchParams] = useSearchParams();
  const [sheets, setSheets] = useState<PlanningSheet[]>([]);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [grid, setGrid] = useState<PlanningGrid | null>(null);

  /**
   * Organization filter (Master Data > Organization List, e.g. Inhyma /
   * FNB Solution / Darsh Impex / One Stop). Never a real column on the
   * sheet -- membership is read live off each row's linked Product
   * Master record (Product.organization_ids) by the backend, exactly
   * like every other Shipment Planning lookup column (see
   * app.planning.source_registry) -- so this filter is always in sync
   * with Product Master and never needs its own edit/delete UI here.
   * Applied server-side (passed into loadGrid/loadMoreRows below) so it
   * covers the WHOLE sheet, not just whichever page is currently
   * loaded. Kept in the URL (?org=<name>) alongside ?sheet=<name>, the
   * same pattern the active sheet tab already uses, so a link to a
   * filtered view can be shared/bookmarked.
   */
  const organizations = useLookup<{ id: string; name: string; branches?: { id: string; name: string; code_prefix?: string }[] | null }>("/masters/company-list/lookup", 250);
  const [activeOrganizationId, setActiveOrganizationId] = useState<string | null>(null);
  /**
   * Which organization's sheet TABS are currently shown at all (Mumbai/
   * Chennai/Inhyma Mumbai etc.) -- completely separate from
   * `activeOrganizationId` above, which is the legacy per-request ROW
   * filter for sheets that predate the branch-link feature. This one
   * controls which tabs even appear in the tab bar: picking an
   * organization here hides every sheet not linked to it (see
   * `visibleSheets` below); null means "no organization filter chosen
   * yet" and defaults to showing whichever organization the
   * first-loaded sheet belongs to (see the effect below), so the page
   * never shows a confusing mix of every organization's branches at
   * once by default.
   */
  const [tabOrganizationFilterId, setTabOrganizationFilterId] = useState<string | null>(null);
  const [itemHeaderTitle, setItemHeaderTitle] = useState("ITEM");
  const [customTags, setCustomTags] = useState<PlanningStatusTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [newSheetGroupLabel, setNewSheetGroupLabel] = useState("Mum");
  const [newSheetOrganizationId, setNewSheetOrganizationId] = useState("");
  const [newSheetBranchId, setNewSheetBranchId] = useState("");

  const [statusPicker, setStatusPicker] = useState<{ anchor: HTMLElement; rowId: string; columnId: string } | null>(null);
  const [mumHistoryPopover, setMumHistoryPopover] = useState<{ anchor: HTMLElement; rowId: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<PlanningChangeLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [configureColumn, setConfigureColumn] = useState<PlanningColumn | null>(null);
  const [linkPicker, setLinkPicker] = useState<{ rowId: string; column: PlanningColumn } | null>(null);

  // Hide / Freeze -- per-user view preferences, persisted to localStorage per sheet (see helpers above).
  const [hiddenColumnIds, setHiddenColumnIds] = useState<Set<string>>(new Set());
  const [frozenColumnIds, setFrozenColumnIds] = useState<Set<string>>(new Set());
  const [columnsPanelOpen, setColumnsPanelOpen] = useState(false);
  const [activeColumnFilters, setActiveColumnFilters] = useState<Record<string, { selectedValues?: Set<string>; textQuery?: string }>>({});

  /**
   * Server-side search payload derived from `activeColumnFilters`,
   * scoped to the currently-active sheet -- built into the exact shape
   * `app.planning.routes._parse_search_query_param` expects: a JSON
   * array of `{column_id, text_query, selected_values}`, one entry per
   * column with an active filter. `column_id: null` means the ITEM
   * column (matched server-side against `PlanningRow.label`, since ITEM
   * has no real `PlanningColumn`/`PlanningCell` of its own).
   *
   * This is what makes search cover the WHOLE sheet (10,000+ rows and
   * counting) instead of only whatever page happened to already be
   * loaded in the browser -- see PlanningRowRepository's
   * `_apply_search_column_filters` for the matching SQL.
   */
  const searchQueryParam = useMemo(() => {
    if (!activeSheetId) return undefined;
    const prefix = `${activeSheetId}:`;
    const entries = Object.entries(activeColumnFilters)
      .filter(([key, state]) => {
        if (!key.startsWith(prefix)) return false;
        const hasValues = state.selectedValues && state.selectedValues.size > 0;
        const hasQuery = state.textQuery && state.textQuery.trim().length > 0;
        return hasValues || hasQuery;
      })
      .map(([key, state]) => {
        const colId = key.slice(prefix.length);
        const vals = state.selectedValues && state.selectedValues.size > 0 ? Array.from(state.selectedValues) : undefined;
        return {
          column_id: colId === "item-header-col" ? null : colId,
          text_query: state.textQuery && state.textQuery.trim() ? state.textQuery.trim() : undefined,
          selected_values: vals && vals.length > 0 && vals.length <= 100 ? vals : undefined,
        };
      });
    if (entries.length === 0) return undefined;
    return JSON.stringify(entries);
  }, [activeSheetId, activeColumnFilters]);

  const [filterPopover, setFilterPopover] = useState<{ anchor: HTMLElement; columnId: string; columnName: string } | null>(null);

  // --- Organization-Wide Cross-Branch Search Bar State ---
  const [orgSearchTerm, setOrgSearchTerm] = useState("");
  const [orgSearchResults, setOrgSearchResults] = useState<{
    total_matches: number;
    branches: {
      sheet_id: string;
      sheet_name: string;
      organization_id: string | null;
      branch_id: string | null;
      match_count: number;
      items: { row_id: string; label: string }[];
    }[];
  } | null>(null);
  const [orgSearchLoading, setOrgSearchLoading] = useState(false);
  const [orgSearchDropdownOpen, setOrgSearchDropdownOpen] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);
  const orgSearchContainerRef = useRef<HTMLDivElement | null>(null);

  const currentOrgName = useMemo(() => {
    if (!tabOrganizationFilterId) return "All";
    return organizations.items.find((o) => o.id === tabOrganizationFilterId)?.name || "Current Organization";
  }, [tabOrganizationFilterId, organizations.items]);

  // Close org search dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (orgSearchContainerRef.current && !orgSearchContainerRef.current.contains(e.target as Node)) {
        setOrgSearchDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounced multi-branch scan across the active organization
  useEffect(() => {
    const term = orgSearchTerm.trim();
    if (!term) {
      setOrgSearchResults(null);
      setOrgSearchLoading(false);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setOrgSearchLoading(true);
      try {
        const qs = toQueryString({
          query: term,
          ...(tabOrganizationFilterId ? { organization_id: tabOrganizationFilterId } : {}),
          limit_per_branch: 5,
        });
        const { data } = await apiGet<{
          total_matches: number;
          branches: {
            sheet_id: string;
            sheet_name: string;
            organization_id: string | null;
            branch_id: string | null;
            match_count: number;
            items: { row_id: string; label: string }[];
          }[];
        }>(`/planning/organization-search${qs}`);
        if (!cancelled && data) {
          setOrgSearchResults(data);
          setOrgSearchDropdownOpen(true);
        }
      } catch {
        // Graceful fallback
      } finally {
        if (!cancelled) setOrgSearchLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [orgSearchTerm, tabOrganizationFilterId]);

  // Live filter active sheet grid while typing
  const handleOrgSearchChange = (term: string) => {
    setOrgSearchTerm(term);
    if (!term.trim()) {
      setOrgSearchDropdownOpen(false);
      if (activeSheetId) {
        setActiveColumnFilters((prev) => {
          const next = { ...prev };
          delete next[`${activeSheetId}:item-header-col`];
          return next;
        });
      }
    } else {
      setOrgSearchDropdownOpen(true);
      if (activeSheetId) {
        setActiveColumnFilters((prev) => ({
          ...prev,
          [`${activeSheetId}:item-header-col`]: { textQuery: term.trim() },
        }));
      }
    }
  };

  const handleSelectBranchFromSearch = (sheetId: string, sheetName: string) => {
    setActiveSheetId(sheetId);
    setGrid(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sheet", sheetName);
      return next;
    });
    if (orgSearchTerm.trim()) {
      setActiveColumnFilters((prev) => ({
        ...prev,
        [`${sheetId}:item-header-col`]: { textQuery: orgSearchTerm.trim() },
      }));
    }
    setOrgSearchDropdownOpen(false);
  };

  const handleSelectItemFromSearch = (sheetId: string, sheetName: string, itemLabel: string) => {
    setActiveSheetId(sheetId);
    setGrid(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sheet", sheetName);
      return next;
    });
    setOrgSearchTerm(itemLabel);
    setActiveColumnFilters((prev) => ({
      ...prev,
      [`${sheetId}:item-header-col`]: { textQuery: itemLabel },
    }));
    setOrgSearchDropdownOpen(false);
  };

  const handleClearOrgSearch = () => {
    setOrgSearchTerm("");
    setOrgSearchResults(null);
    setOrgSearchDropdownOpen(false);
    if (activeSheetId) {
      setActiveColumnFilters((prev) => {
        const next = { ...prev };
        delete next[`${activeSheetId}:item-header-col`];
        return next;
      });
    }
  };

  /** Draft text for the "Group Label" fix-in-place field inside the Configuration panel. Reset to the sheet's current label whenever the panel opens. */
  const [groupLabelDraft, setGroupLabelDraft] = useState("");
  const [savingGroupLabel, setSavingGroupLabel] = useState(false);

  useEffect(() => {
    if (!activeSheetId) return;
    setHiddenColumnIds(loadColumnIdSet(hiddenColumnsStorageKey(activeSheetId)));
    setFrozenColumnIds(loadColumnIdSet(frozenColumnsStorageKey(activeSheetId)));
  }, [activeSheetId]);

  const toggleColumnHidden = useCallback(
    (columnId: string) => {
      if (!activeSheetId) return;
      const cols = grid?.columns ?? [];
      const target = cols.find((c) => c.id === columnId);
      // Hiding any column in a "Mum N" group (main column, Remarks, or
      // any of the 3 computed totals) hides the WHOLE group together --
      // leaving "TOTAL CBM MUM2" visible with no "Mum 2" column next to
      // it just orphans a number nobody can trace back to its source.
      const mumLabel = grid?.sheet?.mum_group_label || "Mum";
      const groupNum = target ? mumGroupNumber(target.name, mumLabel) : null;
      const groupIds =
        groupNum !== null ? cols.filter((c) => mumGroupNumber(c.name, mumLabel) === groupNum).map((c) => c.id) : [columnId];
      setHiddenColumnIds((prev) => {
        const next = new Set(prev);
        const nowHiding = !next.has(columnId); // toggling based on the clicked column's current state
        for (const id of groupIds) {
          if (nowHiding) next.add(id);
          else next.delete(id);
        }
        localStorage.setItem(hiddenColumnsStorageKey(activeSheetId), JSON.stringify([...next]));
        return next;
      });
    },
    [activeSheetId, grid?.columns]
  );

  const toggleColumnFrozen = useCallback(
    (columnId: string) => {
      if (!activeSheetId) return;
      setFrozenColumnIds((prev) => {
        const next = new Set(prev);
        if (next.has(columnId)) next.delete(columnId);
        else next.add(columnId);
        localStorage.setItem(frozenColumnsStorageKey(activeSheetId), JSON.stringify([...next]));
        return next;
      });
    },
    [activeSheetId]
  );

  const [togglingStatusColorId, setTogglingStatusColorId] = useState<string | null>(null);

  async function handleToggleColumnStatusColor(columnId: string, enabled: boolean) {
    if (!activeSheetId) return;
    setTogglingStatusColorId(columnId);
    try {
      await apiPut(`/planning/sheets/${activeSheetId}/columns/${columnId}/status-color-enabled`, {
        enable_status_color: enabled,
      });
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    } finally {
      setTogglingStatusColorId(null);
    }
  }

  const activeSheet = useMemo(
    () => sheets.find((s) => s.id === activeSheetId),
    [sheets, activeSheetId]
  );

  /**
   * Set the `?sheet=` URL param while preserving whatever `?org=` is
   * currently active (or explicitly overriding it via `orgName`). Every
   * call site that used to do `setSearchParams({ sheet: ... })` now goes
   * through this instead, so switching/adding/renaming/deleting a sheet
   * never silently drops the Organization filter out of the URL.
   */
  const setSheetUrlParam = useCallback(
    (sheetName: string, orgName?: string | null) => {
      const effectiveOrgName = orgName !== undefined ? orgName : searchParams.get("org");
      const next: Record<string, string> = { sheet: sheetName };
      if (effectiveOrgName) next.org = effectiveOrgName;
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  /**
   * Resolve `?org=<name>` from the URL to an organization ID once the
   * Organization List has loaded -- mirrors how `loadSheets` resolves
   * `?sheet=<name>` to a sheet ID. Only runs the match while
   * `activeOrganizationId` is still unset, so it doesn't fight with the
   * dropdown once the person has changed the filter themselves.
   * If no org param is provided, default tabOrganizationFilterId to Inhyma.
   */
  useEffect(() => {
    if (!organizations.loaded || organizations.items.length === 0) return;
    const urlOrgParam = searchParams.get("org");
    if (urlOrgParam) {
      const matched = organizations.items.find(
        (o) => o.name.toLowerCase() === urlOrgParam.toLowerCase() || o.id === urlOrgParam
      );
      if (matched) {
        if (activeOrganizationId === null) setActiveOrganizationId(matched.id);
        setTabOrganizationFilterId((prev) => (prev !== null ? prev : matched.id));
        return;
      }
    }
    // Default organization filter to Inhyma when not explicitly set
    const inhymaOrg = organizations.items.find((o) => o.name.toLowerCase().includes("inhyma"));
    if (inhymaOrg) {
      setTabOrganizationFilterId((prev) => (prev === null ? inhymaOrg.id : prev));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizations.loaded, organizations.items, searchParams]);

  const loadSheets = useCallback(async () => {
    try {
      const { data } = await apiGet<PlanningSheet[]>("/planning/sheets");
      setSheets(data);
      if (data.length > 0) {
        const urlSheetParam = searchParams.get("sheet");
        const matched = urlSheetParam
          ? data.find(
            (s) => s.name.toLowerCase() === urlSheetParam.toLowerCase() || s.id === urlSheetParam
          )
          : null;

        // Find Inhyma organization and its primary sheet as the default
        const inhymaOrg = organizations.items.find((o) => o.name.toLowerCase().includes("inhyma"));
        const inhymaSheet = inhymaOrg
          ? data.find((s) => s.organization_id === inhymaOrg.id)
          : data.find((s) => s.name.toLowerCase().includes("inhyma"));

        const target = matched || (activeSheetId ? data.find((s) => s.id === activeSheetId) : null) || inhymaSheet || data[0];
        setActiveSheetId(target.id);
        setSheetUrlParam(target.name);
        
        // Default the tab-visibility filter to Inhyma if available, otherwise target's organization
        const defaultOrgId = inhymaOrg ? inhymaOrg.id : (target.organization_id ?? null);
        setTabOrganizationFilterId((prev) => (prev !== null ? prev : defaultOrgId));
      }
    } catch (err) {
      setError(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, setSearchParams, organizations.items, activeSheetId]);

  /**
   * Sheets currently shown as tabs, restricted to whichever organization
   * `tabOrganizationFilterId` is set to (null = no filter, every sheet
   * shown -- e.g. for legacy unlinked sheets, or before any sheet has
   * loaded yet). A sheet with no organization_id (created before the
   * branch-link feature existed) never matches a real filter selection,
   * by design -- picking "Darsh Impex" should show ONLY Darsh Impex's
   * branches, not every unlinked legacy sheet as well.
   */
  const visibleSheets = useMemo(() => {
    if (tabOrganizationFilterId === null) return sheets;
    return sheets.filter((s) => s.organization_id === tabOrganizationFilterId);
  }, [sheets, tabOrganizationFilterId]);

  /**
   * Keep `activeSheetId` valid whenever the tab-visibility filter
   * changes: if the currently active sheet is still visible under the
   * new filter, leave it selected; otherwise switch to the new filter's
   * first sheet, or go blank (no active sheet, no grid shown) if that
   * organization has no sheets at all yet -- exactly the "if not show
   * blank" behavior asked for, rather than silently falling back to some
   * unrelated organization's sheet.
   */
  useEffect(() => {
    if (visibleSheets.some((s) => s.id === activeSheetId)) return;
    const next = visibleSheets[0] ?? null;
    setGrid(null);
    setActiveSheetId(next?.id ?? null);
    if (next) setSheetUrlParam(next.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSheets]);

  /**
   * Live sync for the SHEET LIST only (Phase 5, consolidated onto the
   * shared `useLiveList` pattern in Phase 6 -- see
   * `frontend/src/lib/live/useLiveList.ts`) -- e.g. another tab
   * creating/renaming/deleting a branch tab shows up here without a
   * manual refresh. `useLiveList` is the SAME hook `Buyers.tsx` uses;
   * this is one of the two reference integrations it was extracted from.
   *
   * Deliberately SEPARATE from the existing per-sheet grid-internals
   * socket below (`applyLiveEvent`, `/planning/sheets/{sheet_id}/live`)
   * -- that one is untouched this phase and keeps handling cell/column/
   * row-level events at its own, much finer granularity that
   * `useLiveList` (a flat-list pattern) was never meant to cover. This
   * hook only ever touches the flat `sheets` array (tab list), never
   * `grid`.
   */
  useLiveList<PlanningSheet>({
    moduleName: "planning",
    setRecords: setSheets,
    // No buildFromEvent: a `planning.created` event's `changes` only
    // carries {name}, not a full PlanningSheet (item_source_type,
    // mum_group_label, etc. -- see the event's own small-payload
    // docstring) -- inserting an incomplete sheet object would risk this
    // tab crashing on a field it assumes exists. A brand-new sheet
    // created by another tab appears here on this tab's next natural
    // `loadSheets()` call (e.g. navigating to Shipment Planning) instead.
  });

  /** Rows per page for the grid -- matches Product Master's own default page size. */
  const GRID_PAGE_SIZE = 50;

  /**
   * Load (or reload) a sheet's grid, always starting from page 1.
   *
   * Every structural change (row added/deleted, column added/renamed,
   * duplicating a sheet, etc.) calls this to get a fully consistent
   * snapshot -- unlike the old unpaginated endpoint, this now only pulls
   * the FIRST `GRID_PAGE_SIZE` rows, which is why it stays fast even once
   * a sheet has grown to hundreds of rows. Loading more rows beyond the
   * first page is a separate, additive action -- see `loadMoreRows` below.
   */
  const loadGrid = useCallback(
    async (sheetId: string, organizationIdOverride?: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const organizationId =
          organizationIdOverride !== undefined ? organizationIdOverride : activeOrganizationId;
        const qs = toQueryString({
          offset: 0,
          limit: GRID_PAGE_SIZE,
          ...(organizationId ? { organization_id: organizationId } : {}),
          ...(searchQueryParam ? { search: searchQueryParam } : {}),
        });
        const { data } = await apiGet<PlanningGrid>(`/planning/sheets/${sheetId}/grid${qs}`);
        setGrid(data);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [activeOrganizationId, searchQueryParam]
  );

  const [loadingMoreRows, setLoadingMoreRows] = useState(false);

  /**
   * Fetch the NEXT page of already-existing (or, absent an active
   * search, freshly auto-populated from Product Master -- see
   * PlanningService.get_grid's docstring) rows and append them to the
   * currently-loaded grid, instead of re-fetching (and recomputing)
   * every row on the sheet from scratch. Powers the automatic
   * scroll-triggered loading (see the IntersectionObserver effect
   * above).
   */
  const loadMoreRows = useCallback(async () => {
    if (!activeSheetId) return;
    setLoadingMoreRows(true);
    setError(null);
    try {
      const currentCount = grid?.rows.length ?? 0;
      const qs = toQueryString({
        offset: currentCount,
        limit: GRID_PAGE_SIZE,
        ...(activeOrganizationId ? { organization_id: activeOrganizationId } : {}),
        ...(searchQueryParam ? { search: searchQueryParam } : {}),
      });
      const { data } = await apiGet<PlanningGrid>(`/planning/sheets/${activeSheetId}/grid${qs}`);
      setGrid((prev) => {
        if (!prev) return data;
        const existingIds = new Set(prev.rows.map((r) => r.id));
        const newRows = data.rows.filter((r) => !existingIds.has(r.id));
        return { ...prev, rows: [...prev.rows, ...newRows], total_rows: data.total_rows };
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMoreRows(false);
    }
  }, [activeSheetId, grid, activeOrganizationId, searchQueryParam]);

  /**
   * Auto-load-ahead while scrolling: a tiny invisible sentinel row sits
   * right after the last currently-rendered row. An IntersectionObserver
   * watches it (relative to the scrollable grid container, not the
   * whole page -- see `root: scrollContainerRef.current` below) and
   * fires `loadMoreRows()` the moment it comes within `rootMargin` of
   * being visible, well BEFORE the user actually reaches the literal
   * bottom -- this is what makes the next batch feel "already ready"
   * rather than causing a visible pause once the user gets there.
   *
   * Replaces both the old "Load More Products" button (this now happens
   * automatically as part of ordinary scrolling -- see get_grid's own
   * docstring for why one `loadMoreRows()` call already transparently
   * auto-populates new Product Master rows AND returns already-existing
   * ones, so a single trigger covers both) and the pagination footer's
   * manual "Load N more" button.
   *
   * `loadingRef` (a ref, not state) guards against firing a second
   * overlapping fetch while one is already in flight -- state updates
   * are asynchronous and batched, so relying on `loadingMoreRows` state
   * alone inside the observer's callback could still let a fast series
   * of intersection events slip through before the first fetch's
   * `setLoadingMoreRows(true)` has actually re-rendered.
   */
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollSentinelRef = useRef<HTMLTableRowElement>(null);
  const loadMoreRowsRef = useRef(loadMoreRows);
  loadMoreRowsRef.current = loadMoreRows;
  const isFetchingMoreRef = useRef(false);

  useEffect(() => {
    const sentinel = scrollSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (isFetchingMoreRef.current) return;
        const currentCount = grid?.rows.length ?? 0;
        const total = grid?.total_rows ?? 0;
        if (currentCount >= total) return; // everything already loaded -- nothing to prefetch
        isFetchingMoreRef.current = true;
        void loadMoreRowsRef.current().finally(() => {
          isFetchingMoreRef.current = false;
        });
      },
      {
        root: container,
        // Fire ~2 rows' worth of scroll before the sentinel is literally
        // on-screen, so the next page is already loading in the
        // background by the time the user gets there.
        rootMargin: "120px 0px",
        threshold: 0,
      }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
    // Re-attach whenever the sheet changes (new container contents) or
    // the row/total counts change (so a just-finished fetch's updated
    // grid.total_rows is visible to the NEXT intersection check without
    // waiting for an unrelated re-render to happen to recreate this
    // effect first).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheetId, grid?.rows.length, grid?.total_rows]);

  const loadCustomTags = useCallback(async () => {
    try {
      const { data } = await apiGet<PlanningStatusTag[]>("/planning/status-tags");
      setCustomTags(data);
    } catch {
      // Non-critical: custom tags are additive; built-in colors still work if this fails.
    }
  }, []);

  /**
   * Live updates: apply an event pushed from the backend WebSocket
   * directly onto the in-memory grid, so a change made by another user
   * (or another tab) appears immediately without a manual refresh.
   * Every branch here mirrors the equivalent local-state update the
   * corresponding REST handler already does for the person who made the
   * change themselves (e.g. handleSaveCellValue) -- this is just the
   * same patch applied on behalf of *other* viewers.
   */
  const applyLiveEvent = useCallback(
    (event: { type: string; payload: any }) => {
      const { type, payload } = event;

      // Strict sheet isolation: ignore any event that belongs to a different sheet
      if (type !== "source_record_changed") {
        const eventSheetId = payload?.sheet_id || payload?.sheet?.id || payload?.column?.sheet_id;
        if (eventSheetId && activeSheetId && String(eventSheetId) !== String(activeSheetId)) {
          return;
        }
      }

      // "A Product Master (or other source module) record changed
      // somewhere else" -- this event isn't sheet-specific (it's
      // broadcast to every open Planning tab, since the backend has no
      // cheap way to know in advance which sheets reference that record;
      // see ws_manager.notify_source_record_changed), so THIS tab decides
      // for itself whether it's relevant: only when the current sheet's
      // ITEM column pulls from that exact module AND at least one row is
      // actually linked to the changed record, or any other column does.
      // A full grid reload (not a hand-patched cell) is used here because
      // determining the new display value client-side would mean
      // re-implementing compute_cell_display_value's module-lookup logic
      // in the browser -- correctness over cleverness for a rare event.
      if (type === "source_record_changed") {
        if (!activeSheetId || !grid) return;
        const changedModule = payload.module as string;
        const changedRecordId = payload.record_id as string;
        const itemUsesModule = grid.sheet.item_source_module === changedModule;
        const columnUsesModule = grid.columns.some((c) => c.source_module === changedModule);
        if (!itemUsesModule && !columnUsesModule) return; // nothing on this sheet could possibly reference it
        const anyRowLinkedToRecord =
          grid.rows.some((r) => r.linked_record_id === changedRecordId) ||
          grid.rows.some((r) => r.cells.some((c) => c.linked_record_id === changedRecordId));
        if (!anyRowLinkedToRecord) return; // this sheet uses the module, but not THIS specific record
        void loadGrid(activeSheetId);
        return;
      }

      setGrid((prev) => {
        if (!prev) return prev;

        switch (type) {
          case "column_added": {
            if (prev.columns.some((c) => c.id === payload.id)) return prev;
            return { ...prev, columns: [...prev.columns, payload].sort((a, b) => a.position - b.position) };
          }
          case "column_renamed":
          case "column_moved":
          case "column_source_configured":
          case "column_role_lock_changed":
          case "column_status_color_toggled":
          case "column_description_changed":
          case "column_width_changed": {
            return {
              ...prev,
              columns: prev.columns.map((c) => (c.id === payload.id ? payload : c)).sort((a, b) => a.position - b.position),
            };
          }
          case "item_description_changed": {
            return { ...prev, sheet: payload };
          }
          case "column_deleted": {
            const columnId = payload.column_id;
            return {
              ...prev,
              columns: prev.columns.filter((c) => c.id !== columnId),
              rows: prev.rows.map((r) => ({ ...r, cells: r.cells.filter((cell) => cell.column_id !== columnId) })),
            };
          }
          case "row_added": {
            if (prev.rows.some((r) => r.id === payload.id)) return prev;
            // Keep total_rows in sync too -- otherwise a row pushed live by
            // another tab would make the "Showing X of N" footer undercount
            // by one (rows.length grows here, but total_rows was fetched
            // before this row existed).
            return {
              ...prev,
              rows: [...prev.rows, { ...payload, cells: payload.cells ?? [] }],
              total_rows: (prev.total_rows ?? prev.rows.length) + 1,
            };
          }
          case "row_renamed":
          case "row_moved":
          case "row_description_changed": {
            return {
              ...prev,
              rows: prev.rows.map((r) => (r.id === payload.id ? { ...r, ...payload, cells: r.cells } : r)),
            };
          }
          case "row_deleted": {
            const stillHasRow = prev.rows.some((r) => r.id === payload.row_id);
            return {
              ...prev,
              rows: prev.rows.filter((r) => r.id !== payload.row_id),
              total_rows: stillHasRow ? Math.max(0, (prev.total_rows ?? prev.rows.length) - 1) : prev.total_rows,
            };
          }
          case "cell_value_changed": {
            const cellPayload = payload.cell;
            const rowId = payload.row_id as string;
            const rawDerived = (payload.derived_values ?? {}) as Record<string, string | null | Record<string, string>>;
            const mumApprovalDates = (rawDerived["__mum_approval_dates__"] as Record<string, string> | undefined) ?? undefined;
            const derived = Object.fromEntries(
              Object.entries(rawDerived).filter(([k]) => k !== "__mum_approval_dates__")
            ) as Record<string, string | null>;
            const approvalDateColumnId = prev.columns.find((c) => isApprovalDateColumn(c.name))?.id;
            return {
              ...prev,
              rows: prev.rows.map((r) => {
                if (r.id !== rowId) return r;
                const exists = r.cells.some((c) => c.column_id === cellPayload.column_id);
                let updatedCells = exists
                  ? r.cells.map((c) => (c.column_id === cellPayload.column_id ? { ...c, ...cellPayload } : c))
                  : [...r.cells, cellPayload];
                // Patch every FORMULA/derived column's fresh display value too
                // (e.g. NO. OF PKG / TOTAL WEIGHT / TOTAL CBM recompute the
                // instant a sibling Mum column is typed into).
                updatedCells = updatedCells.map((c) => {
                  if (!Object.prototype.hasOwnProperty.call(derived, c.column_id)) return c;
                  const nextDisplayValue = derived[c.column_id];
                  // The Approval Date column renders from `value` (it's a
                  // MANUAL column), not `display_value` -- see GridCell's
                  // isManual branch -- so its auto-computed date has to land
                  // in `value` too, exactly like the initial grid load does,
                  // or it silently never appears despite being computed correctly.
                  // Never clobbers a value the person actually typed in themselves
                  // (guarded by is_auto_approval_date, not a value/string guess).
                  if (c.column_id === approvalDateColumnId && (c.is_auto_approval_date || !c.value)) {
                    return { ...c, display_value: nextDisplayValue, value: nextDisplayValue, is_auto_approval_date: true };
                  }
                  return { ...c, display_value: nextDisplayValue };
                });
                // Any derived column not yet present as a cell entry (formula
                // columns often have none) needs a synthetic one so the grid
                // still has one entry per (row, column) to render.
                const presentColumnIds = new Set(updatedCells.map((c) => c.column_id));
                for (const [columnId, displayValue] of Object.entries(derived)) {
                  if (!presentColumnIds.has(columnId)) {
                    updatedCells.push({
                      id: null,
                      row_id: rowId,
                      column_id: columnId,
                      value: columnId === approvalDateColumnId ? displayValue : null,
                      display_value: displayValue,
                      status_color: null,
                      custom_status_tag_id: null,
                      is_auto_approval_date: columnId === approvalDateColumnId,
                    } as any);
                  }
                }
                // Keep mum_approval_dates current too -- cellByRowColumn's
                // hidden-aware recompute (the "first non-hidden Mum group"
                // pick) reads this off the row, not off derived_values, so
                // without updating it here a live edit from another tab
                // would patch the raw cell correctly but the hidden-column
                // override would keep using stale per-group dates.
                return { ...r, cells: updatedCells, mum_approval_dates: mumApprovalDates ?? r.mum_approval_dates };
              }),
            };
          }
          case "cell_status_changed":
          case "cell_description_changed": {
            const cellPayload = payload.cell;
            const rowId = payload.row_id as string;
            return {
              ...prev,
              rows: prev.rows.map((r) => {
                if (r.id !== rowId) return r;
                const exists = r.cells.some((c) => c.column_id === cellPayload.column_id);
                const updatedCells = exists
                  ? r.cells.map((c) => (c.column_id === cellPayload.column_id ? { ...c, ...cellPayload } : c))
                  : [...r.cells, cellPayload];
                return { ...r, cells: updatedCells };
              }),
            };
          }
          default:
            return prev;
        }
      });
    },
    [activeSheetId, grid, loadGrid]
  );

  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!activeSheetId) return;
    const token = Auth.getAccessToken();
    if (!token) return;

    // Build the WS URL from the same API_BASE the REST client uses, so
    // this works identically whether the backend is same-origin (dev, via
    // the Vite proxy -- API_BASE is just "/api/v1", a relative path with
    // no scheme) or a separate absolute origin (VITE_API_ORIGIN set,
    // API_BASE already starts with http(s)://). The WebSocket constructor
    // requires an absolute ws(s):// URL -- a bare relative path throws a
    // SyntaxError immediately -- so a relative API_BASE is first resolved
    // against window.location before the scheme swap.
    const absoluteApiBase = new URL(`${API_BASE}/planning/sheets/${activeSheetId}/live`, window.location.href).toString();
    const wsUrl =
      absoluteApiBase.replace(/^https:/, "wss:").replace(/^http:/, "ws:") + `?token=${encodeURIComponent(token)}`;

    let socket: WebSocket;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      socket.onmessage = (evt) => {
        try {
          const parsed = JSON.parse(evt.data);
          applyLiveEvent(parsed);
        } catch {
          // Ignore malformed events rather than crashing the socket handler.
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        // Reconnect after a short delay (e.g. transient network blip, or
        // the backend restarting) rather than leaving the tab silently
        // stuck without live updates until the person manually reloads.
        retryTimer = setTimeout(connect, 3000);
      };
      socket.onerror = () => {
        socket.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current = null;
      if (socket) {
        if (socket.readyState === WebSocket.CONNECTING) {
          // Calling close() while still CONNECTING is safe (the socket
          // never opens) but Chrome/Firefox log a "WebSocket is closed
          // before the connection is established" console warning for
          // it -- purely cosmetic, but avoidable: defer the close until
          // the handshake actually settles (open or error), same as
          // waiting for a promise to settle before cancelling it.
          const pendingSocket = socket;
          pendingSocket.addEventListener("open", () => pendingSocket.close(), { once: true });
        } else {
          socket.close();
        }
      }
    };
  }, [activeSheetId, applyLiveEvent]);

  useEffect(() => {
    void loadSheets();
    void loadCustomTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeSheetId) {
      setGrid(null);
      void loadGrid(activeSheetId);
    }
  }, [activeSheetId, loadGrid]);

  const columns = grid?.columns ?? [];

  useEffect(() => {
    if (!activeSheetId || columns.length === 0) return;
    const validIds = new Set(columns.map((c) => c.id));

    setFrozenColumnIds((prev) => {
      // If user has not set custom frozen columns yet, default to first 2 dynamic columns (TEST(Y/N), APPROVAL DATE)
      if (localStorage.getItem(frozenColumnsStorageKey(activeSheetId)) === null && prev.size === 0) {
        const defaults = new Set(columns.slice(0, 2).map((c) => c.id));
        return defaults;
      }
      const pruned = new Set([...prev].filter((id) => validIds.has(id)));
      if (pruned.size !== prev.size) {
        localStorage.setItem(frozenColumnsStorageKey(activeSheetId), JSON.stringify([...pruned]));
      }
      return pruned.size !== prev.size ? pruned : prev;
    });
    setHiddenColumnIds((prev) => {
      const pruned = new Set([...prev].filter((id) => validIds.has(id)));
      if (pruned.size !== prev.size) {
        localStorage.setItem(hiddenColumnsStorageKey(activeSheetId), JSON.stringify([...pruned]));
      }
      return pruned.size !== prev.size ? pruned : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSheetId, columns]);
  const rows = grid?.rows ?? [];

  function isTestColumn(colName: string): boolean {
    const name = colName.trim().toLowerCase();
    return name.startsWith("test");
  }


  function isMumMainColumn(colName: string): boolean {
    const name = colName.trim().toLowerCase();
    if (name.startsWith("no. of pkg") || name.startsWith("total weight") || name.startsWith("total cbm")) {
      return false;
    }
    return mumGroupNumber(colName, grid?.sheet?.mum_group_label) !== null;
  }

  function isMumTotalColumn(colName: string): boolean {
    const name = colName.trim().toLowerCase();
    return (
      name.startsWith("no. of pkg") ||
      name.startsWith("total weight") ||
      name.startsWith("total cbm")
    );
  }

  function organizeNonFrozenColumns(cols: PlanningColumn[]): PlanningColumn[] {
    const mumLabel = grid?.sheet?.mum_group_label || "Mum";
    const testCols: PlanningColumn[] = [];
    const approvalCols: PlanningColumn[] = [];
    const mumMain: PlanningColumn[] = [];
    const mumTotals: PlanningColumn[] = [];
    const standard: PlanningColumn[] = [];

    for (const c of cols) {
      if (isTestColumn(c.name)) {
        testCols.push(c);
      } else if (isApprovalDateColumn(c.name)) {
        approvalCols.push(c);
      } else if (isMumMainColumn(c.name)) {
        mumMain.push(c);
      } else if (isMumTotalColumn(c.name)) {
        mumTotals.push(c);
      } else {
        standard.push(c);
      }
    }

    // Sort group main/remarks columns in ASCENDING NUMERIC ORDER (Group 1, Group 1 Remarks, Group 2, Group 2 Remarks...)
    mumMain.sort((a, b) => {
      const numA = mumGroupNumber(a.name, mumLabel) ?? 999;
      const numB = mumGroupNumber(b.name, mumLabel) ?? 999;
      if (numA !== numB) return numA - numB;
      const isRemarksA = a.name.toLowerCase().includes("remark");
      const isRemarksB = b.name.toLowerCase().includes("remark");
      if (!isRemarksA && isRemarksB) return -1;
      if (isRemarksA && !isRemarksB) return 1;
      return a.position - b.position;
    });

    // Sort summary total columns by group number ascending if applicable
    mumTotals.sort((a, b) => {
      const numA = mumGroupNumber(a.name, mumLabel) ?? 999;
      const numB = mumGroupNumber(b.name, mumLabel) ?? 999;
      if (numA !== numB) return numA - numB;
      return a.position - b.position;
    });

    const supplierIdx = standard.findIndex((c) => /supplier/i.test(c.name));
    const cbmIdx = standard.findIndex((c) => /cbm\s*[\/\.]?\s*pkg/i.test(c.name));

    let beforeSupplier: PlanningColumn[] = [];
    let supplierToCbm: PlanningColumn[] = [];
    let afterCbm: PlanningColumn[] = [];

    if (supplierIdx !== -1) {
      beforeSupplier = standard.slice(0, supplierIdx);
      if (cbmIdx !== -1 && cbmIdx >= supplierIdx) {
        supplierToCbm = standard.slice(supplierIdx, cbmIdx + 1);
        afterCbm = standard.slice(cbmIdx + 1);
      } else {
        supplierToCbm = standard.slice(supplierIdx);
      }
    } else {
      if (cbmIdx !== -1) {
        supplierToCbm = standard.slice(0, cbmIdx + 1);
        afterCbm = standard.slice(cbmIdx + 1);
      } else {
        supplierToCbm = standard;
      }
    }

    // Compulsory layout from Left to Right:
    // 1. TEST(Y/N)
    // 2. APPROVAL DATE
    // 3. Before-Supplier standard columns (rare -- any admin column that
    //    isn't Supplier/City/PKG-QTY/Weight/CBM and doesn't sort after them)
    // 4. EVERY group's main column + Remarks companion, ascending by
    //    group number (Group1, Group1 Remarks, Group2, Group2 Remarks, ...)
    // 5. Supplier Name -> City -> PKG QTY -> UNIT WEIGHT/PKG -> CBM/PKG
    //    (the fixed common block) -- always right here, between every
    //    group's main/Remarks columns and every group's totals, never
    //    before the group columns and never after the totals.
    // 6. EVERY group's own 3 fixed totals (NO. OF PKG / TOTAL WEIGHT /
    //    TOTAL CBM), ascending by group number, all together after the
    //    common block -- NOT interleaved per-group between step 4 and 5.
    // 7. Any other standard column that isn't part of the common block
    //    (rare -- an admin-added extra column sorting after CBM/PKG).
    return [
      ...testCols,
      ...approvalCols,
      ...beforeSupplier,
      ...mumMain,
      ...supplierToCbm,
      ...mumTotals,
      ...afterCbm,
    ];
  }

  // Hidden columns are simply excluded. Frozen (pinned) columns are moved to
  // the front, in their original relative order, so they sit right after the
  // always-frozen ITEM column and stay stuck there while the rest scrolls --
  // same visual result as Excel's freeze panes, without requiring the
  // frozen set to be a contiguous run of leading columns.
  const configurableColumns = useMemo(
    () => columns.filter((col) => !isTestColumn(col.name) && !isApprovalDateColumn(col.name)),
    [columns]
  );
  const hiddenCount = useMemo(
    () => configurableColumns.filter((c) => hiddenColumnIds.has(c.id)).length,
    [configurableColumns, hiddenColumnIds]
  );
  const visibleColumns = useMemo(
    () => columns.filter((c) => isTestColumn(c.name) || isApprovalDateColumn(c.name) || !hiddenColumnIds.has(c.id)),
    [columns, hiddenColumnIds]
  );
  // Which Mum group numbers are currently visible (not hidden) -- the
  // Approval Date eye popover uses this to exclude hidden Mum groups from
  // its history list, matching the fact that the group's own columns are
  // hidden from the grid too.
  const visibleMumGroupNumbers = useMemo(() => {
    const nums = new Set<number>();
    const mumLabel = grid?.sheet?.mum_group_label || "Mum";
    for (const c of visibleColumns) {
      const groupNum = mumGroupNumber(c.name, mumLabel);
      if (groupNum !== null) nums.add(groupNum);
    }
    return nums;
  }, [visibleColumns, grid?.sheet?.mum_group_label]);

  const approvalDateColumnId = useMemo(
    () => columns.find((c) => isApprovalDateColumn(c.name))?.id,
    [columns]
  );

  const cellByRowColumn = useMemo(() => {
    const map = new Map<string, PlanningRow["cells"][number]>();
    for (const row of rows) {
      for (const cell of row.cells) {
        map.set(`${row.id}:${cell.column_id}`, cell);
      }
      // Approval Date override: pick the FIRST Mum group (lowest number)
      // that is both (a) not hidden by this viewer and (b) has an
      // approval date, from the backend's per-group breakdown -- the
      // backend's own auto-fill (already baked into the fetched cell
      // above) can't know about per-user hidden columns, so it may have
      // picked a group this viewer has hidden. `is_auto_approval_date`
      // (explicit backend flag, not a string-comparison guess) ensures
      // this only ever overrides a backend-computed date, NEVER a value
      // someone actually typed into the Approval Date cell themselves.
      if (approvalDateColumnId) {
        const existingCell = map.get(`${row.id}:${approvalDateColumnId}`);
        const isAutoFilled = existingCell?.is_auto_approval_date ?? (!existingCell || !existingCell.value);
        if (isAutoFilled) {
          const visibleGroupNums = row.mum_approval_dates
            ? Object.keys(row.mum_approval_dates)
              .map((k) => parseInt(k, 10))
              .filter((n) => !Number.isNaN(n) && visibleMumGroupNumbers.has(n))
            : [];
          const effectiveDate =
            visibleGroupNums.length > 0 && row.mum_approval_dates
              ? row.mum_approval_dates[Math.min(...visibleGroupNums)]
              : null;
          if (existingCell) {
            map.set(`${row.id}:${approvalDateColumnId}`, {
              ...existingCell,
              value: effectiveDate,
              display_value: effectiveDate,
              is_auto_approval_date: true,
            });
          } else if (effectiveDate) {
            map.set(`${row.id}:${approvalDateColumnId}`, {
              id: null,
              row_id: row.id,
              column_id: approvalDateColumnId,
              value: effectiveDate,
              display_value: effectiveDate,
              status_color: null,
              custom_status_tag_id: null,
              is_auto_approval_date: true,
            } as PlanningCell);
          }
        }
      }
    }
    return map;
  }, [rows, approvalDateColumnId, visibleMumGroupNumbers]);

  const getUniqueValuesForColumn = useCallback(
    (colId: string) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        let val = "";
        if (colId === "item-header-col") {
          val = row.label || "(Blanks)";
        } else {
          const cell = cellByRowColumn.get(`${row.id}:${colId}`);
          const raw = cell?.display_value ?? cell?.value;
          val = raw !== null && raw !== undefined && raw.trim() !== "" ? raw.trim() : "(Blanks)";
        }
        counts.set(val, (counts.get(val) ?? 0) + 1);
      }
      return [...counts.entries()].sort(([a], [b]) => {
        if (a === "(Blanks)") return 1;
        if (b === "(Blanks)") return -1;
        return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      });
    },
    [rows, cellByRowColumn]
  );

  const activeFilterCount = useMemo(() => {
    if (!activeSheetId) return 0;
    return Object.entries(activeColumnFilters).filter(([key, state]) => {
      if (!key.startsWith(`${activeSheetId}:`)) return false;
      return (state.selectedValues && state.selectedValues.size > 0) || (state.textQuery && state.textQuery.trim().length > 0);
    }).length;
  }, [activeSheetId, activeColumnFilters]);

  const clearAllSheetFilters = () => {
    if (!activeSheetId) return;
    setActiveColumnFilters((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(next)) {
        if (key.startsWith(`${activeSheetId}:`)) {
          delete next[key];
        }
      }
      return next;
    });
  };

  /* Sorting State */
  const [sortColumnId, setSortColumnId] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    setSortColumnId(null);
    setSortDirection("asc");
  }, [activeSheetId]);

  const handleSortColumn = useCallback((colId: string) => {
    setSortColumnId((prev) => {
      if (prev === colId) {
        if (sortDirection === "asc") {
          setSortDirection("desc");
          return colId;
        } else {
          setSortDirection("asc");
          return null;
        }
      } else {
        setSortDirection("asc");
        return colId;
      }
    });
  }, [sortDirection]);

  const displayedRows = useMemo(() => {
    if (!sortColumnId) return rows;
    const list = [...rows];
    list.sort((a, b) => {
      let rawA = "";
      let rawB = "";
      if (sortColumnId === "item-header-col") {
        rawA = (a.label || "").trim();
        rawB = (b.label || "").trim();
      } else {
        const cellA = cellByRowColumn.get(`${a.id}:${sortColumnId}`);
        const cellB = cellByRowColumn.get(`${b.id}:${sortColumnId}`);
        rawA = (cellA?.display_value ?? cellA?.value ?? "").trim();
        rawB = (cellB?.display_value ?? cellB?.value ?? "").trim();
      }
      const numA = Number(rawA);
      const numB = Number(rawB);
      if (rawA !== "" && rawB !== "" && !isNaN(numA) && !isNaN(numB)) {
        return sortDirection === "asc" ? numA - numB : numB - numA;
      }
      if (!rawA && rawB) return 1;
      if (rawA && !rawB) return -1;
      return sortDirection === "asc"
        ? rawA.localeCompare(rawB, undefined, { numeric: true, sensitivity: "base" })
        : rawB.localeCompare(rawA, undefined, { numeric: true, sensitivity: "base" });
    });
    return list;
  }, [rows, sortColumnId, sortDirection, cellByRowColumn]);

  const orderedColumns = useMemo(() => {
    const testCols = visibleColumns.filter((c) => isTestColumn(c.name));
    const appCols = visibleColumns.filter((c) => isApprovalDateColumn(c.name));
    const userFrozen = visibleColumns.filter(
      (c) => !isTestColumn(c.name) && !isApprovalDateColumn(c.name) && frozenColumnIds.has(c.id)
    );
    const rest = visibleColumns.filter(
      (c) => !isTestColumn(c.name) && !isApprovalDateColumn(c.name) && !frozenColumnIds.has(c.id)
    );
    return [...testCols, ...appCols, ...userFrozen, ...organizeNonFrozenColumns(rest)];
  }, [visibleColumns, frozenColumnIds]);
  const stickyLeftByColumnId = useMemo(() => {
    const map = new Map<string, number>();
    let left = ITEM_COL_WIDTH;
    for (const col of orderedColumns) {
      const isFrozen = isTestColumn(col.name) || isApprovalDateColumn(col.name) || frozenColumnIds.has(col.id);
      if (!isFrozen) break;
      map.set(col.id, left);
      left += effectiveColumnWidth(col);
    }
    return map;
  }, [orderedColumns, frozenColumnIds]);
  const lastFrozenColumnId = useMemo(() => {
    const frozenInOrder = orderedColumns.filter(
      (c) => isTestColumn(c.name) || isApprovalDateColumn(c.name) || frozenColumnIds.has(c.id)
    );
    return frozenInOrder.length > 0 ? frozenInOrder[frozenInOrder.length - 1].id : null;
  }, [orderedColumns, frozenColumnIds]);

  const itemColumn: PlanningColumn = useMemo(
    () => ({
      id: "item-header-col",
      sheet_id: activeSheetId || "",
      name: itemHeaderTitle,
      data_type: "text",
      position: 0,
      is_locked: false,
      source_type: grid?.sheet.item_source_type || "manual",
      source_module: grid?.sheet.item_source_module || null,
      source_field: grid?.sheet.item_source_field || null,
      source_aggregate_fn: null,
      source_aggregate_filters: null,
      formula_expression: grid?.sheet.item_formula_expression || null,
      enable_description: grid?.sheet.item_enable_description ?? false,
      auto_populate_enabled: grid?.sheet.item_auto_populate_enabled ?? false,
      auto_populate_limit: grid?.sheet.item_auto_populate_limit ?? null,
      created_by: "",
      created_at: "",
      updated_at: "",
    }),
    [activeSheetId, itemHeaderTitle, grid?.sheet]
  );

  async function handleCreateSheet(e: React.FormEvent) {
    e.preventDefault();
    if (!newSheetGroupLabel.trim() || !newSheetOrganizationId || !newSheetBranchId) return;
    // The sheet's name is always exactly the selected branch's name from
    // Product Master's organization list -- there is no separate
    // free-typed "sheet name" anymore. This can never be empty when the
    // guard above passed, since newSheetBranchId can only be set to a
    // real branch id that came from this same organization's branches
    // list (see the Branch <SelectField> below).
    const branchName =
      organizations.items.find((o) => o.id === newSheetOrganizationId)?.branches?.find((b) => b.id === newSheetBranchId)
        ?.name ?? "";
    if (!branchName.trim()) return;
    try {
      const { data } = await apiPost<PlanningSheet>("/planning/sheets", {
        name: branchName.trim(),
        organization_id: newSheetOrganizationId,
        branch_id: newSheetBranchId,
        mum_group_label: newSheetGroupLabel.trim(),
      });
      setNewSheetGroupLabel("Mum");
      setNewSheetOrganizationId("");
      setNewSheetBranchId("");
      setAddSheetOpen(false);
      await loadSheets();
      setActiveSheetId(data.id);
      setSheetUrlParam(data.name);
    } catch (err) {
      setError(err);
    }
  }

  /**
   * Fix an existing sheet's group label in place -- see
   * PlanningService.update_mum_group_label. Reloads the grid afterward
   * since every Mum-series column NAME just changed (e.g. "Mum 1" ->
   * "Test 1"), which the currently-loaded grid state doesn't know about
   * yet -- a full reload is simplest and this is a rare, deliberate
   * admin action, not a hot path worth hand-patching column names for.
   */
  async function handleUpdateGroupLabel() {
    if (!activeSheetId) return;
    const label = groupLabelDraft.trim();
    if (!label) return;
    setSavingGroupLabel(true);
    try {
      await apiPatch(`/planning/sheets/${activeSheetId}/group-label`, { mum_group_label: label });
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    } finally {
      setSavingGroupLabel(false);
    }
  }

  async function handleDeleteSheet(sheetId: string, sheetName: string) {
    if (!window.confirm(`Are you sure you want to delete sheet '${sheetName}'? This will remove the sheet and all its columns and rows.`)) return;
    try {
      await apiDelete(`/planning/sheets/${sheetId}`);
      await loadSheets();
      if (activeSheetId === sheetId) {
        // Fall back within the currently-VISIBLE (organization-filtered)
        // set only -- picking from the full unfiltered `sheets` here
        // could otherwise silently jump the user to a different
        // organization's sheet after deleting the last one in the
        // filtered view, which the tab-visibility filter above exists
        // specifically to prevent. Mirrors the same fallback the
        // `visibleSheets` effect performs on any other filter change.
        const remaining = visibleSheets.filter((s) => s.id !== sheetId);
        if (remaining.length > 0) {
          setActiveSheetId(remaining[0].id);
          setSheetUrlParam(remaining[0].name);
        } else {
          setActiveSheetId(null);
        }
      }
    } catch (err) {
      setError(err);
    }
  }

  async function handleRenameSheet(sheetId: string, currentName: string) {
    const newName = window.prompt("Rename sheet:", currentName);
    if (!newName || !newName.trim() || newName.trim() === currentName) return;
    try {
      await apiPatch(`/planning/sheets/${sheetId}`, { name: newName.trim() });
      await loadSheets();
      if (activeSheetId === sheetId) {
        setSheetUrlParam(newName.trim());
      }
    } catch (err) {
      setError(err);
    }
  }

  const [creatingNextMum, setCreatingNextMum] = useState(false);

  async function handleCreateNextMumGroup() {
    if (!activeSheetId) return;
    setCreatingNextMum(true);
    setError(null);
    try {
      const { data: updatedColumns } = await apiPost<PlanningColumn[]>(
        `/planning/sheets/${activeSheetId}/columns/next-mum-group`
      );
      if (updatedColumns && Array.isArray(updatedColumns)) {
        setGrid((prev) => (prev ? { ...prev, columns: updatedColumns } : prev));
      }
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    } finally {
      setCreatingNextMum(false);
    }
  }

  async function handleDeleteColumn(columnId: string) {
    if (!activeSheetId) return;
    const target = columns.find((c) => c.id === columnId);
    if (!target) return;
    if (isSystemColumn(target.name)) {
      setError(`System column '${target.name}' cannot be deleted.`);
      return;
    }

    // Deleting any column that belongs to a "Mum N" group (the main Mum
    // column, its Remarks, or any of the 3 computed totals) cascades to
    // the WHOLE group -- leaving, say, "TOTAL CBM MUM2" behind after
    // "Mum 2" itself is deleted would just be a dead formula column
    // referencing a Mum column that no longer exists.
    const mumLabel = grid?.sheet?.mum_group_label || "Mum";
    const groupNum = mumGroupNumber(target.name, mumLabel);
    const groupColumns = groupNum !== null ? columns.filter((c) => mumGroupNumber(c.name, mumLabel) === groupNum) : [target];

    const confirmMessage =
      groupColumns.length > 1
        ? `Delete the whole ${mumLabel} ${groupNum} group? This removes "${groupColumns.map((c) => c.name).join('", "')}" and every value stored in them.`
        : "Delete this column? This removes every value stored in it.";
    if (!window.confirm(confirmMessage)) return;

    try {
      for (const col of groupColumns) {
        await apiDelete(`/planning/sheets/${activeSheetId}/columns/${col.id}`);
      }
      const deletedIds = new Set(groupColumns.map((c) => c.id));
      setGrid((prev) =>
        prev
          ? {
            ...prev,
            columns: prev.columns.filter((c) => !deletedIds.has(c.id)),
            rows: prev.rows.map((r) => ({ ...r, cells: r.cells.filter((cell) => !deletedIds.has(cell.column_id)) })),
          }
          : prev
      );
    } catch (err) {
      setError(err);
    }
  }

  async function handleRenameColumn(columnId: string, name: string) {
    if (!activeSheetId || !name.trim()) return;
    try {
      await apiPatch(`/planning/sheets/${activeSheetId}/columns/${columnId}`, { name: name.trim() });
      setGrid((prev) =>
        prev
          ? {
            ...prev,
            columns: prev.columns.map((c) => (c.id === columnId ? { ...c, name: name.trim() } : c)),
          }
          : prev
      );
    } catch (err) {
      setError(err);
    }
  }

  /**
   * Persist a drag-resized column width to the server (shared across
   * every user viewing this sheet -- see PlanningColumn.width_px's
   * docstring). Updates local state optimistically first since the drag
   * gesture itself already gave the user immediate visual feedback (see
   * ColumnHeader's handleResizeStart) -- this call is just making that
   * already-applied width durable, not the thing that makes the column
   * visually resize.
   */
  async function handleResizeColumn(columnId: string, widthPx: number) {
    if (!activeSheetId) return;
    setGrid((prev) =>
      prev
        ? { ...prev, columns: prev.columns.map((c) => (c.id === columnId ? { ...c, width_px: widthPx } : c)) }
        : prev
    );
    try {
      await apiPatch(`/planning/sheets/${activeSheetId}/columns/${columnId}/width`, { width_px: widthPx });
    } catch (err) {
      setError(err);
    }
  }

  async function handleRenameRow(rowId: string, label: string) {
    if (!activeSheetId || !label.trim()) return;
    try {
      await apiPatch(`/planning/sheets/${activeSheetId}/rows/${rowId}`, { label: label.trim() });
      setGrid((prev) =>
        prev
          ? {
            ...prev,
            rows: prev.rows.map((r) => (r.id === rowId ? { ...r, label: label.trim() } : r)),
          }
          : prev
      );
    } catch (err) {
      setError(err);
    }
  }

  /**
   * Per-cell save status for the optimistic-save indicator -- "saving…"
   * while a write is in flight/retrying, "error" if every retry attempt
   * failed (the value stays visible either way; this only drives a small
   * dot/label next to the cell, never blocks or reverts what the person
   * typed). Cleared (key removed) once a save actually confirms.
   * Keyed by `${rowId}:${columnId}`.
   */
  const [cellSaveStatus, setCellSaveStatus] = useState<Record<string, "saving" | "error">>({});

  /**
   * Tracks the most recent save "generation" per cell (a simple
   * incrementing counter), so that if the same cell is edited again
   * while an earlier save for it is still in flight/retrying, the
   * earlier attempt's eventual response (or failure) is a no-op instead
   * of clobbering the newer value with stale server data -- last edit
   * always wins, regardless of which network request happens to resolve
   * last.
   */
  const cellSaveGenerationRef = useRef<Record<string, number>>({});

  /** Simple key helper so the save-status map and its consumers always agree on the key shape. */
  function cellStatusKey(rowId: string, columnId: string): string {
    return `${rowId}:${columnId}`;
  }

  /**
   * Save a cell value optimistically: apply it to local state INSTANTLY
   * (before any network call), then persist it in the background with a
   * few retries on transient failure. The person sees their typed value
   * immediately and keeps typing/tabbing -- nothing here blocks the UI
   * waiting for the server, and a slow or flaky connection never makes
   * an edit look like it didn't "take".
   *
   * Retries 3 times with a short exponential backoff (400ms/800ms/1600ms)
   * before giving up and marking the cell "error" -- deliberately silent
   * otherwise (no error banner for a single cell write, which would be
   * disruptive while someone is actively filling in a sheet); the small
   * per-cell indicator is enough, and hovering/clicking it lets them
   * retry by re-saving the same value.
   */
  async function handleSaveCellValue(rowId: string, columnId: string, value: string) {
    if (!activeSheetId) return;
    const sheetId = activeSheetId;
    const key = cellStatusKey(rowId, columnId);
    const myGeneration = (cellSaveGenerationRef.current[key] ?? 0) + 1;
    cellSaveGenerationRef.current[key] = myGeneration;
    const isStillLatest = () => cellSaveGenerationRef.current[key] === myGeneration;

    const targetCol = grid?.columns.find((c) => c.id === columnId);
    const mumLabel = grid?.sheet?.mum_group_label || "Mum";
    const isMumCol = targetCol ? isPureMumColumn(targetCol.name, mumLabel) : false;
    const isStatusColorCol = targetCol
      ? isMumCol || (targetCol.enable_status_color && !isTestColumn(targetCol.name) && !isApprovalDateColumn(targetCol.name))
      : false;
    const isZeroOrBlank = isMumCol && (value.trim() === "" || value.trim() === "0" || (!isNaN(Number(value)) && Number(value) === 0));
    const effectiveVal = isZeroOrBlank ? "" : value;
    const mumNum = targetCol ? mumGroupNumber(targetCol.name, mumLabel) : null;
    const remarksColId = (isZeroOrBlank && mumNum !== null)
      ? grid?.columns.find((c) => mumRemarksGroupNumber(c.name, mumLabel) === mumNum)?.id
      : undefined;

    // 1. Apply optimistically, right away -- the person's typed value is
    // the source of truth in the UI from this point on, independent of
    // whether the network call below has even started yet.
    setGrid((prev) => {
      if (!prev) return prev;
      const approvalDateCol = prev.columns.find((c) => isApprovalDateColumn(c.name));
      return {
        ...prev,
        rows: prev.rows.map((r) => {
          if (r.id !== rowId) return r;
          const exists = r.cells.some((cell) => cell.column_id === columnId);
          const optimisticCell = isZeroOrBlank
            ? { value: "", display_value: "", status_color: null, custom_status_tag_id: null }
            : {
              value: effectiveVal,
              display_value: effectiveVal,
              ...(isStatusColorCol && effectiveVal.trim() !== "" ? { status_color: "blue_ordered" as PlanningCellStatusColor, custom_status_tag_id: null } : {}),
            };
          let updatedCells = exists
            ? r.cells.map((cell) => (cell.column_id === columnId ? { ...cell, ...optimisticCell } : cell))
            : [
              ...r.cells,
              {
                id: null,
                row_id: rowId,
                column_id: columnId,
                value: isZeroOrBlank ? "" : effectiveVal,
                display_value: isZeroOrBlank ? "" : effectiveVal,
                status_color: isZeroOrBlank ? null : isStatusColorCol && effectiveVal.trim() !== "" ? "blue_ordered" : null,
                custom_status_tag_id: null,
              } as PlanningCell,
            ];
          if (remarksColId) {
            updatedCells = updatedCells.map((cell) =>
              cell.column_id === remarksColId ? { ...cell, value: "", display_value: "" } : cell
            );
          }
          let nextMumDates = r.mum_approval_dates ? { ...r.mum_approval_dates } : undefined;
          if (isZeroOrBlank && mumNum !== null && nextMumDates) {
            delete nextMumDates[mumNum];
          }
          const hasOtherActiveMum = updatedCells.some((c) => {
            const col = prev.columns.find((cl) => cl.id === c.column_id);
            if (!col || !isPureMumColumn(col.name, mumLabel)) return false;
            const v = (c.value ?? "").trim();
            return v !== "" && v !== "0" && !isNaN(Number(v)) && Number(v) > 0;
          });
          if (!hasOtherActiveMum && approvalDateCol) {
            updatedCells = updatedCells.map((cell) =>
              cell.column_id === approvalDateCol.id ? { ...cell, value: "", display_value: "" } : cell
            );
          }
          return {
            ...r,
            cells: updatedCells,
            mum_approval_dates: nextMumDates,
          };
        }),
      };
    });
    setCellSaveStatus((prev) => ({ ...prev, [key]: "saving" }));

    const maxAttempts = 3;
    const backoffMs = [400, 800, 1600];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const { data } = await apiPut<{ cell: PlanningCell; derived_values: Record<string, string | null | Record<string, string>> }>(
          `/planning/sheets/${sheetId}/rows/${rowId}/columns/${columnId}/value`,
          { value: isZeroOrBlank ? null : value }
        );
        // A newer edit to this SAME cell started while this request was
        // in flight -- that newer save already applied its own optimistic
        // value and has its own request racing to persist it, so this
        // now-stale response must not overwrite it. Simply stop; the
        // newer generation's own success/failure handling takes it from here.
        if (!isStillLatest()) return;
        const patchedCell = data?.cell;
        const rawDerived = data?.derived_values ?? {};
        const mumApprovalDates = (rawDerived["__mum_approval_dates__"] as Record<string, string> | undefined) ?? undefined;
        const derived = Object.fromEntries(
          Object.entries(rawDerived).filter(([k]) => k !== "__mum_approval_dates__")
        ) as Record<string, string | null>;
        setGrid((prev) => {
          if (!prev) return prev;
          const approvalDateColumnId = prev.columns.find((c) => isApprovalDateColumn(c.name))?.id;
          return {
            ...prev,
            rows: prev.rows.map((r) => {
              if (r.id !== rowId) return r;
              const exists = r.cells.some((cell) => cell.column_id === columnId);
              // Apply the REAL response from the server, not a hand-rolled
              // guess -- typing into a Mum column auto-turns its status blue
              // server-side (see PlanningService.set_cell_value), and this
              // cell's own tab needs that status_color applied immediately
              // too, or the dot only turns blue after a manual refresh even
              // though the write itself already succeeded.
              const patched = patchedCell ?? {
                id: null,
                row_id: rowId,
                column_id: columnId,
                value: isZeroOrBlank ? "" : value,
                display_value: isZeroOrBlank ? "" : value,
                status_color: null,
                custom_status_tag_id: null,
              };
              let updatedCells = exists
                ? r.cells.map((cell) => (cell.column_id === columnId ? { ...cell, ...patched } : cell))
                : [...r.cells, patched];
              if (remarksColId) {
                updatedCells = updatedCells.map((cell) =>
                  cell.column_id === remarksColId ? { ...cell, value: "", display_value: "" } : cell
                );
              }
              // Also patch every derived column (formula totals, and the
              // Approval Date auto-date) for THIS SAME tab -- the acting
              // user doesn't receive their own WebSocket broadcast (see
              // ws_manager's exclude_user_id), so without this the person
              // who actually typed the value would be the one person who
              // has to refresh to see their own Approval Date / totals update.
              updatedCells = updatedCells.map((c) => {
                if (!Object.prototype.hasOwnProperty.call(derived, c.column_id)) return c;
                const nextDisplayValue = derived[c.column_id];
                if (c.column_id === approvalDateColumnId && (c.is_auto_approval_date || !c.value || nextDisplayValue === null || nextDisplayValue === "")) {
                  return { ...c, display_value: nextDisplayValue ?? "", value: nextDisplayValue ?? "", is_auto_approval_date: true };
                }
                return { ...c, display_value: nextDisplayValue, value: nextDisplayValue !== undefined ? nextDisplayValue : c.value };
              });
              const presentColumnIds = new Set(updatedCells.map((c) => c.column_id));
              for (const [derivedColumnId, displayValue] of Object.entries(derived)) {
                if (!presentColumnIds.has(derivedColumnId)) {
                  updatedCells.push({
                    id: null,
                    row_id: rowId,
                    column_id: derivedColumnId,
                    value: derivedColumnId === approvalDateColumnId ? displayValue : null,
                    display_value: displayValue,
                    status_color: null,
                    custom_status_tag_id: null,
                    is_auto_approval_date: derivedColumnId === approvalDateColumnId,
                  } as any);
                }
              }
              return { ...r, cells: updatedCells, mum_approval_dates: mumApprovalDates ?? r.mum_approval_dates };
            }),
          };
        });
        // Success -- clear the "saving"/"error" indicator for this cell.
        setCellSaveStatus((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        return;
      } catch (err) {
        // A newer edit superseded this one while it was retrying --
        // don't mark the cell "error"; the newer generation owns the
        // status indicator now.
        if (!isStillLatest()) return;
        // Only retry TRANSIENT failures -- a dropped connection, a
        // timeout, or the server briefly erroring (5xx). A 4xx (bad
        // request, forbidden, not found -- e.g. the row or column was
        // deleted from under this edit) means retrying the exact same
        // request will just fail again identically, so stop immediately
        // instead of waiting through 3 pointless attempts.
        const status = err instanceof ApiError ? err.status : undefined;
        const isRetryable = status === undefined || status >= 500 || status === 408 || status === 429;
        const isLastAttempt = attempt === maxAttempts - 1;
        if (!isRetryable || isLastAttempt) {
          setCellSaveStatus((prev) => ({ ...prev, [key]: "error" }));
          if (status && status < 500 && status !== 408 && status !== 429) {
            showToast(err instanceof Error ? err.message : "Cannot save cell", "error");
          }
          console.error("Failed to save cell value:", err);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs[attempt]));
        if (!isStillLatest()) return;
      }
    }
  }

  /** Re-attempt a previously-failed cell save (same value already shown, just retry the write). */
  function retryCellSave(rowId: string, columnId: string) {
    const cell = (grid?.rows.find((r) => r.id === rowId)?.cells ?? []).find((c) => c.column_id === columnId);
    void handleSaveCellValue(rowId, columnId, cell?.value ?? "");
  }

  async function handleSetCellStatus(
    rowId: string,
    columnId: string,
    statusColor: PlanningCellStatusColor | null,
    customTagId: string | null
  ) {
    if (!activeSheetId) return;
    if (statusColor !== null) {
      const targetCell = (grid?.rows.find((r) => r.id === rowId)?.cells ?? []).find((c) => c.column_id === columnId);
      const cellVal = (targetCell?.value ?? "").trim();
      const num = Number(cellVal);
      const hasActiveNumber = cellVal !== "" && cellVal !== "0" && (!isNaN(num) ? num > 0 : true);
      if (!hasActiveNumber) {
        showToast("Cannot set status color on an empty cell. Enter a quantity first.", "warning");
        setStatusPicker(null);
        return;
      }
    }
    try {
      await apiPut(`/planning/sheets/${activeSheetId}/rows/${rowId}/columns/${columnId}/status`, {
        status_color: statusColor,
        custom_status_tag_id: customTagId,
      });
      setStatusPicker(null);
      setGrid((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.id !== rowId) return r;
            const exists = r.cells.some((cell) => cell.column_id === columnId);
            const updatedCells = exists
              ? r.cells.map((cell) =>
                cell.column_id === columnId
                  ? { ...cell, status_color: statusColor, custom_status_tag_id: customTagId }
                  : cell
              )
              : [
                ...r.cells,
                {
                  id: null,
                  row_id: rowId,
                  column_id: columnId,
                  value: "",
                  display_value: "",
                  status_color: statusColor,
                  custom_status_tag_id: customTagId,
                },
              ];
            return { ...r, cells: updatedCells };
          }),
        };
      });
    } catch (err) {
      setError(err);
    }
  }

  /** Set/clear a column's single header-level description note (pencil on the column header). */
  async function handleSaveColumnDescription(columnId: string, description: string | null) {
    if (!activeSheetId) return;
    try {
      const { data } = await apiPut<PlanningColumn>(`/planning/sheets/${activeSheetId}/columns/${columnId}/description`, {
        description,
      });
      setGrid((prev) => (prev && data ? { ...prev, columns: prev.columns.map((c) => (c.id === columnId ? data : c)) } : prev));
    } catch (err) {
      setError(err);
    }
  }

  /** Set/clear the ITEM column's single header-level description note. Mirrors handleSaveColumnDescription. */
  async function handleSaveItemDescription(description: string | null) {
    if (!activeSheetId) return;
    try {
      const { data } = await apiPut<PlanningSheet>(`/planning/sheets/${activeSheetId}/item-description`, { description });
      setGrid((prev) => (prev && data ? { ...prev, sheet: data } : prev));
    } catch (err) {
      setError(err);
    }
  }

  async function handleOpenHistory() {
    if (!activeSheetId) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const { data } = await apiGet<PlanningChangeLogEntry[]>(`/planning/sheets/${activeSheetId}/history`);
      setHistoryEntries(data);
    } catch (err) {
      setError(err);
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <AppShell activeKey="planning">
      <main className="page">
        <Breadcrumb
          trail={
            activeSheet
              ? [
                "Shipment Planning",
                activeSheet.name,
                ...(activeOrganizationId
                  ? [`Filter Organization: ${organizations.items.find((o) => o.id === activeOrganizationId)?.name ?? ""}`]
                  : []),
              ]
              : ["Shipment Planning"]
          }
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0, flexShrink: 0 }}>
            Shipment Planning{activeSheet ? ` / ${activeSheet.name}` : ""}
            {activeOrganizationId && (
              <span style={{ fontSize: 13, fontWeight: 500, color: "#2563EB" }}>
                {" "}/ Filter Organization: {organizations.items.find((o) => o.id === activeOrganizationId)?.name ?? ""}
              </span>
            )}
          </h1>

          {/* Org-Wide Cross-Branch Search Bar */}
          <div ref={orgSearchContainerRef} style={{ position: "relative", flex: "1 1 340px", maxWidth: 460, minWidth: 260 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                background: "#FFFFFF",
                border: isSearchFocused ? "1.5px solid #2563EB" : "1.5px solid #E2E8F0",
                borderRadius: 8,
                padding: "0 10px",
                height: 38,
                gap: 8,
                boxShadow: isSearchFocused
                  ? "0 0 0 3px rgba(37, 99, 235, 0.12), 0 1px 2px rgba(0,0,0,0.04)"
                  : "0 1px 2px rgba(0,0,0,0.04)",
                transition: "all 0.15s ease-in-out",
                boxSizing: "border-box",
              }}
            >
              {/* Modern SVG Search Icon */}
              <span
                style={{
                  color: isSearchFocused ? "#2563EB" : "#94A3B8",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                  transition: "color 0.15s",
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>

              <input
                type="text"
                value={orgSearchTerm}
                onChange={(e) => handleOrgSearchChange(e.target.value)}
                onFocus={() => {
                  setIsSearchFocused(true);
                  if (orgSearchTerm.trim() && orgSearchResults) {
                    setOrgSearchDropdownOpen(true);
                  }
                }}
                onBlur={() => setIsSearchFocused(false)}
                placeholder={
                  tabOrganizationFilterId
                    ? `Search across ${currentOrgName} branches...`
                    : "Search items across all branches..."
                }
                style={{
                  border: "none",
                  outline: "none",
                  width: "100%",
                  fontSize: 13,
                  fontWeight: 450,
                  color: "#0F172A",
                  background: "transparent",
                  padding: 0,
                }}
              />

              {/* Organization Pill badge */}
              {tabOrganizationFilterId && !orgSearchTerm && (
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "#2563EB",
                    background: "#EFF6FF",
                    padding: "2px 7px",
                    borderRadius: 4,
                    border: "1px solid #DBEAFE",
                    flexShrink: 0,
                    userSelect: "none",
                    whiteSpace: "nowrap",
                  }}
                >
                  {currentOrgName}
                </span>
              )}

              {/* Modern Spinner while scanning */}
              {orgSearchLoading && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    color: "#64748B",
                    fontSize: 11,
                    fontWeight: 500,
                    flexShrink: 0,
                  }}
                >
                  <svg
                    style={{ animation: "spinOrgSearch 0.8s linear infinite" }}
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="#2563EB"
                    strokeWidth="2.5"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                  <style>{`
                    @keyframes spinOrgSearch {
                      from { transform: rotate(0deg); }
                      to { transform: rotate(360deg); }
                    }
                  `}</style>
                </div>
              )}

              {/* Clear button */}
              {orgSearchTerm && (
                <button
                  type="button"
                  onClick={handleClearOrgSearch}
                  title="Clear search"
                  style={{
                    border: "none",
                    background: "#F1F5F9",
                    color: "#64748B",
                    cursor: "pointer",
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    fontSize: 11,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    flexShrink: 0,
                    transition: "background 0.15s, color 0.15s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "#E2E8F0";
                    e.currentTarget.style.color = "#0F172A";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "#F1F5F9";
                    e.currentTarget.style.color = "#64748B";
                  }}
                >
                  ✕
                </button>
              )}
            </div>

            {/* Cross-Branch Search Results Dropdown */}
            {orgSearchDropdownOpen && orgSearchTerm.trim() && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 8px)",
                  left: 0,
                  right: 0,
                  zIndex: 999,
                  background: "#FFFFFF",
                  border: "1px solid #E2E8F0",
                  borderRadius: 10,
                  boxShadow: "0 15px 30px -5px rgba(15, 23, 42, 0.12), 0 6px 12px -4px rgba(15, 23, 42, 0.06)",
                  maxHeight: 400,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  fontSize: 12,
                }}
              >
                {/* Header Summary */}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "9px 12px",
                    background: "#F8FAFC",
                    borderBottom: "1px solid #E2E8F0",
                    color: "#475569",
                    fontSize: 11.5,
                    fontWeight: 600,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span>🏢</span>
                    <span>
                      {tabOrganizationFilterId ? `${currentOrgName} Organization Branches` : "All Branches"}
                    </span>
                  </div>
                  <span
                    style={{
                      background: orgSearchLoading ? "#F1F5F9" : (orgSearchResults && orgSearchResults.total_matches > 0 ? "#EEF2FF" : "#F1F5F9"),
                      color: orgSearchLoading ? "#64748B" : (orgSearchResults && orgSearchResults.total_matches > 0 ? "#4338CA" : "#64748B"),
                      padding: "2px 8px",
                      borderRadius: 12,
                      fontWeight: 600,
                      fontSize: 11,
                      border: orgSearchResults && orgSearchResults.total_matches > 0 ? "1px solid #C7D2FE" : "1px solid #E2E8F0",
                    }}
                  >
                    {orgSearchLoading
                      ? "Scanning branches..."
                      : orgSearchResults
                      ? `${orgSearchResults.total_matches} match${orgSearchResults.total_matches === 1 ? "" : "es"}`
                      : "Ready"}
                  </span>
                </div>

                <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                  {orgSearchLoading && !orgSearchResults && (
                    <div style={{ padding: "24px 12px", textAlign: "center", color: "#64748B", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
                      <svg style={{ animation: "spinOrgSearch 0.8s linear infinite" }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.5">
                        <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                      </svg>
                      <span style={{ fontSize: 12 }}>Scanning across branches for "{orgSearchTerm}"...</span>
                    </div>
                  )}

                  {!orgSearchLoading && orgSearchResults && orgSearchResults.branches.length === 0 && (
                    <div style={{ padding: "20px 12px", textAlign: "center", color: "#94A3B8" }}>
                      No branches found linked to this organization.
                    </div>
                  )}

                  {!orgSearchLoading && orgSearchResults && orgSearchResults.total_matches === 0 && (
                    <div style={{ padding: "20px 12px", textAlign: "center", color: "#64748B", display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <span style={{ fontSize: 18 }}>🔍</span>
                      <span style={{ fontWeight: 600, color: "#1E293B", fontSize: 13 }}>No matching items found</span>
                      <span style={{ fontSize: 11.5, color: "#94A3B8" }}>
                        "{orgSearchTerm}" is not planned in any {currentOrgName} branch.
                      </span>
                    </div>
                  )}

                  {orgSearchResults &&
                    orgSearchResults.branches.map((branch) => {
                      const isActive = branch.sheet_id === activeSheetId;
                      const hasMatches = branch.match_count > 0;
                      return (
                        <div
                          key={branch.sheet_id}
                          style={{
                            background: isActive ? "#F0F7FF" : "#FFFFFF",
                            border: isActive ? "1px solid #BFDBFE" : "1px solid #E2E8F0",
                            borderRadius: 8,
                            padding: "8px 10px",
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                            transition: "border-color 0.15s",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                            }}
                          >
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontWeight: 600, color: "#1E293B", fontSize: 12.5 }}>
                                {branch.sheet_name}
                              </span>
                              {isActive ? (
                                <span
                                  style={{
                                    background: "#ECFDF5",
                                    color: "#059669",
                                    fontSize: 10,
                                    fontWeight: 700,
                                    padding: "1.5px 6px",
                                    borderRadius: 4,
                                    border: "1px solid #A7F3D0",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 3,
                                  }}
                                >
                                  <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#10B981" }} />
                                  Active Sheet
                                </span>
                              ) : (
                                <span style={{ fontSize: 10, color: "#94A3B8", background: "#F1F5F9", padding: "1px 5px", borderRadius: 4 }}>
                                  Branch
                                </span>
                              )}
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  color: hasMatches ? "#16A34A" : "#94A3B8",
                                }}
                              >
                                {branch.match_count} item{branch.match_count === 1 ? "" : "s"}
                              </span>
                              {!isActive && hasMatches && (
                                <button
                                  type="button"
                                  onClick={() => handleSelectBranchFromSearch(branch.sheet_id, branch.sheet_name)}
                                  style={{
                                    border: "1px solid #2563EB",
                                    background: "#EFF6FF",
                                    color: "#2563EB",
                                    cursor: "pointer",
                                    fontSize: 11,
                                    padding: "2.5px 9px",
                                    borderRadius: 5,
                                    fontWeight: 600,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 3,
                                    transition: "all 0.15s",
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.background = "#2563EB";
                                    e.currentTarget.style.color = "#FFFFFF";
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.background = "#EFF6FF";
                                    e.currentTarget.style.color = "#2563EB";
                                  }}
                                >
                                  Open Branch →
                                </button>
                              )}
                            </div>
                          </div>

                          {branch.items.length > 0 && (
                            <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2, paddingTop: 4, borderTop: isActive ? "1px solid #DBEAFE" : "1px solid #F1F5F9" }}>
                              {branch.items.map((item) => (
                                <div
                                  key={item.row_id}
                                  onClick={() => handleSelectItemFromSearch(branch.sheet_id, branch.sheet_name, item.label)}
                                  title={`Open ${branch.sheet_name} and view ${item.label}`}
                                  style={{
                                    padding: "4px 8px",
                                    borderRadius: 5,
                                    cursor: "pointer",
                                    color: "#334155",
                                    fontSize: 11.5,
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    background: "transparent",
                                    transition: "background 0.1s, color 0.1s",
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.background = isActive ? "#DBEAFE" : "#F1F5F9";
                                    e.currentTarget.style.color = "#0F172A";
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.background = "transparent";
                                    e.currentTarget.style.color = "#334155";
                                  }}
                                >
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                                    <span style={{ color: "#94A3B8", fontSize: 11, flexShrink: 0 }}>📦</span>
                                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {item.label}
                                    </span>
                                  </div>
                                  <span style={{ color: "#2563EB", fontSize: 10.5, fontWeight: 500, flexShrink: 0 }}>Select ↵</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
            <button type="button" className="btn btn-secondary" onClick={handleOpenHistory} disabled={!activeSheetId}>
              History
            </button>
            <Can permission="planning.sheet.manage">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setNewSheetGroupLabel("Mum");
                  const inhymaOrg = organizations.items.find((o) => o.name.toLowerCase().includes("inhyma"));
                  setNewSheetOrganizationId(tabOrganizationFilterId || inhymaOrg?.id || "");
                  setNewSheetBranchId("");
                  setAddSheetOpen(true);
                }}
              >
                + Sheet
              </button>
            </Can>
          </div>
        </div>

        <Banner error={error} />

        {/*
          Which organization's branches show as tabs at all -- separate
          from the "Organization" control in the toolbar above (which
          either filters ROWS on the currently-open legacy sheet, or
          shows a locked badge for a branch-linked sheet). This one
          controls the TAB BAR itself: pick an organization here and
          only ITS sheets remain visible below; if it has none yet, the
          tab bar goes blank rather than falling back to some other
          organization's sheet (see the visibleSheets/effect above for
          the exact fallback rules).
        */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <label htmlFor="tab_organization_filter" style={{ fontSize: 13, fontWeight: 600, color: "#475569" }}>
            Organization:
          </label>
          <select
            id="tab_organization_filter"
            value={tabOrganizationFilterId ?? ""}
            onChange={(e) => setTabOrganizationFilterId(e.target.value || null)}
            title="Show only this organization's branch tabs"
            style={{
              border: "1px solid #CBD5E1",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 13,
              color: tabOrganizationFilterId ? "#2563EB" : "#334155",
              background: tabOrganizationFilterId ? "#EFF6FF" : "#FFFFFF",
              cursor: "pointer",
            }}
          >
            <option value="">All Organizations</option>
            {organizations.items.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>

        {/* Sheet tabs -- one per branch (Mum Branch, MP Branch, GJ Branch, ...), unlimited. */}
        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E2E8F0", marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {visibleSheets.map((sheet) => (
            <div
              key={sheet.id}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderBottom: sheet.id === activeSheetId ? "2px solid #2563EB" : "2px solid transparent",
                color: sheet.id === activeSheetId ? "#2563EB" : "#475569",
                fontWeight: sheet.id === activeSheetId ? 600 : 500,
                fontSize: 13,
                cursor: "pointer",
                userSelect: "none",
                background: sheet.id === activeSheetId ? "#F8FAFC" : "transparent",
                borderRadius: "4px 4px 0 0",
              }}
              onClick={() => {
                if (sheet.id !== activeSheetId) {
                  setGrid(null);
                  setActiveSheetId(sheet.id);
                  setSheetUrlParam(sheet.name);
                }
              }}
            >
              <span
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  handleRenameSheet(sheet.id, sheet.name);
                }}
                title="Double-click to rename sheet"
              >
                {sheet.name}
              </span>
              <Can permission="planning.sheet.manage">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRenameSheet(sheet.id, sheet.name);
                  }}
                  title="Rename sheet"
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94A3B8", fontSize: 11, padding: "0 2px" }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteSheet(sheet.id, sheet.name);
                  }}
                  title="Delete sheet"
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94A3B8", fontSize: 13, fontWeight: 700, padding: "0 2px" }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#94A3B8")}
                >
                  ×
                </button>
              </Can>
            </div>
          ))}
          {visibleSheets.length === 0 && !loading && (
            <div className="muted" style={{ padding: "8px 4px" }}>
              {sheets.length === 0
                ? "No sheets yet. Add one to get started."
                : `No sheets yet for ${organizations.items.find((o) => o.id === tabOrganizationFilterId)?.name ?? "this organization"}.`}
            </div>
          )}
        </div>

        {activeSheetId && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
              <Can permission="planning.column.manage">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setGroupLabelDraft(grid?.sheet?.mum_group_label || "Mum");
                    setColumnsPanelOpen(true);
                  }}
                  disabled={columns.length === 0}
                >
                  Configuration{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}
                </button>
              </Can>
              <Can permission="planning.column.manage">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCreateNextMumGroup}
                  disabled={creatingNextMum || !activeSheetId}
                  title="Automatically detect latest Mum number and create next Mum column group (Mum, Remarks, PKG, Weight, CBM)"
                >
                  {creatingNextMum ? `Creating Next ${grid?.sheet?.mum_group_label || "Mum"}…` : `+ Next ${grid?.sheet?.mum_group_label || "Mum"}`}
                </button>
              </Can>
              {activeFilterCount > 0 && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 6, padding: "5px 10px", fontSize: 12, color: "#1E40AF", marginLeft: "auto" }}>
                  <span>🔍 <strong>{activeFilterCount}</strong> filter(s) active ({grid?.total_rows ?? rows.length} matching row{(grid?.total_rows ?? rows.length) === 1 ? "" : "s"} across the whole sheet)</span>
                  <button
                    type="button"
                    onClick={clearAllSheetFilters}
                    style={{ border: "none", background: "transparent", cursor: "pointer", color: "#2563EB", fontWeight: 600, fontSize: 12, textDecoration: "underline", marginLeft: 4 }}
                  >
                    Clear all
                  </button>
                </div>
              )}
            </div>

            <div ref={scrollContainerRef} style={{ overflow: "auto", border: "1px solid #E2E8F0", borderRadius: 8, maxHeight: "calc(100vh - 210px)" }}>
              <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "max-content", minWidth: "100%", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    <EditableItemHeader
                      column={itemColumn}
                      canManage={canManageColumns}
                      onRename={setItemHeaderTitle}
                      onSaveDescription={handleSaveItemDescription}
                      itemDescription={grid?.sheet.item_description}
                      isLastFrozen={lastFrozenColumnId === null}
                      isFiltered={!!(activeColumnFilters[`${activeSheetId}:item-header-col`]?.selectedValues?.size || activeColumnFilters[`${activeSheetId}:item-header-col`]?.textQuery)}
                      onOpenFilter={(anchor) => setFilterPopover({ anchor, columnId: "item-header-col", columnName: itemColumn.name })}
                      isSorted={sortColumnId === "item-header-col"}
                      sortDirection={sortDirection}
                      onSort={() => handleSortColumn("item-header-col")}
                    />
                    {orderedColumns.map((col) => (
                      <ColumnHeader
                        key={col.id}
                        column={col}
                        canManage={canManageColumns}
                        onRename={(name) => handleRenameColumn(col.id, name)}
                        onDelete={() => handleDeleteColumn(col.id)}
                        onSaveDescription={(text) => handleSaveColumnDescription(col.id, text)}
                        isFrozen={isTestColumn(col.name) || isApprovalDateColumn(col.name) || frozenColumnIds.has(col.id)}
                        isLastFrozen={col.id === lastFrozenColumnId}
                        stickyLeft={stickyLeftByColumnId.get(col.id)}
                        isFiltered={!!(activeColumnFilters[`${activeSheetId}:${col.id}`]?.selectedValues?.size || activeColumnFilters[`${activeSheetId}:${col.id}`]?.textQuery)}
                        onOpenFilter={(anchor) => setFilterPopover({ anchor, columnId: col.id, columnName: col.name })}
                        width={effectiveColumnWidth(col)}
                        onResize={canManageColumns ? (widthPx) => handleResizeColumn(col.id, widthPx) : undefined}
                        isSorted={sortColumnId === col.id}
                        sortDirection={sortDirection}
                        onSort={() => handleSortColumn(col.id)}
                      />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <PlanningGridSkeletonRows columns={orderedColumns} count={10} />
                  ) : displayedRows.length === 0 ? (
                    <TableMessageRow colSpan={orderedColumns.length + 1}>
                      {activeFilterCount > 0 ? (
                        <>
                          No rows match the active filter(s).{" "}
                          <button
                            type="button"
                            onClick={clearAllSheetFilters}
                            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#2563EB", textDecoration: "underline", fontSize: 13 }}
                          >
                            Clear filters
                          </button>
                        </>
                      ) : (
                        "No rows yet. Add one to get started."
                      )}
                    </TableMessageRow>
                  ) : (
                    displayedRows.map((row) => (
                      <tr key={row.id}>
                        <EditableRowLabel
                          label={row.label}
                          canEdit={canEditCells}
                          sourceType={itemColumn.source_type}
                          onSave={(newLabel) => handleRenameRow(row.id, newLabel)}
                          isLastFrozen={lastFrozenColumnId === null}
                        />
                        {orderedColumns.map((col) => {
                          const cell = cellByRowColumn.get(`${row.id}:${col.id}`);
                          const saveKey = cellStatusKey(row.id, col.id);
                          const mumLabel = grid?.sheet?.mum_group_label || "Mum";
                          const remarksGroupNum = mumRemarksGroupNumber(col.name, mumLabel);
                          let remarksDisabledReason: string | undefined = undefined;

                          if (remarksGroupNum !== null) {
                            const mumMainCol = orderedColumns.find(
                              (c) => isPureMumColumn(c.name, mumLabel) && mumGroupNumber(c.name, mumLabel) === remarksGroupNum
                            );
                            const mumMainCell = mumMainCol ? cellByRowColumn.get(`${row.id}:${mumMainCol.id}`) : undefined;
                            const mumVal = (mumMainCell?.value ?? "").trim();
                            const num = Number(mumVal);
                            const hasActiveMumNumber = mumVal !== "" && mumVal !== "0" && !isNaN(num) && num > 0;
                            if (!hasActiveMumNumber) {
                              remarksDisabledReason = `Enter a quantity in ${mumMainCol?.name || `${mumLabel} ${remarksGroupNum}`} first before adding remarks.`;
                            }
                          }

                          return (
                            <GridCell
                              key={col.id}
                              value={cell?.value}
                              displayValue={cell?.display_value}
                              statusColor={cell?.status_color}
                              customStatusTagId={cell?.custom_status_tag_id}
                              customTags={customTags}
                              canEdit={
                                isTestColumn(col.name)
                                  ? canEditTestYN
                                  : isApprovalDateColumn(col.name)
                                    ? canEditApprovalDate
                                    : canEditCells
                              }
                              canSetStatus={
                                isPureMumColumn(col.name, grid?.sheet?.mum_group_label)
                                  ? (canEditCells || canSetRedStatus || canSetGreenStatus)
                                  : col.enable_status_color
                                    ? (canEditCells || canSetRedStatus || canSetGreenStatus)
                                    : false
                              }
                              sourceType={col.source_type}
                              enableStatusColor={col.enable_status_color}
                              showMumHistory={isApprovalDateColumn(col.name)}
                              saveStatus={cellSaveStatus[saveKey]}
                              onSave={(value) => handleSaveCellValue(row.id, col.id, value)}
                              onRetrySave={() => retryCellSave(row.id, col.id)}
                              onOpenStatusPicker={(anchor) => setStatusPicker({ anchor, rowId: row.id, columnId: col.id })}
                              onOpenMumHistory={(anchor) => setMumHistoryPopover({ anchor, rowId: row.id })}
                              onOpenLinkPicker={() => setLinkPicker({ rowId: row.id, column: col })}
                              isFrozen={isTestColumn(col.name) || isApprovalDateColumn(col.name) || frozenColumnIds.has(col.id)}
                              isLastFrozen={col.id === lastFrozenColumnId}
                              stickyLeft={stickyLeftByColumnId.get(col.id)}
                              width={effectiveColumnWidth(col)}
                              disabledReason={remarksDisabledReason}
                              onDisabledClick={() => remarksDisabledReason && showToast(remarksDisabledReason, "warning")}
                            />
                          );
                        })}
                      </tr>
                    ))
                  )}
                  {/*
                    Auto-load-ahead sentinel: an empty, near-invisible row
                    the IntersectionObserver above watches. Only rendered
                    while there are still more rows to fetch (or an
                    in-flight fetch we're waiting on) -- once every row is
                    loaded there's nothing left to trigger, so it's
                    removed entirely rather than sitting there as dead
                    weight. A small text hint doubles as a "yes, this is
                    still loading" affordance for anyone watching closely,
                    without being an actual clickable "Load more" control
                    -- the whole point is that no click is needed.
                  */}
                  {!loading && grid && rows.length < (grid.total_rows ?? 0) && (
                    <tr ref={scrollSentinelRef}>
                      <td colSpan={orderedColumns.length + 1} style={{ textAlign: "center", padding: "10px 0", color: "#94A3B8", fontSize: 12, border: "none" }}>
                        {loadingMoreRows ? "Loading more…" : ""}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/*
              Footer: "Showing X of Y total" only -- no manual "Load
              more" button anymore. Rows beyond what's currently
              rendered load automatically as the user scrolls (see the
              sentinel row + IntersectionObserver above), so this is
              purely informational now.
            */}
            {grid && typeof grid.total_rows === "number" && grid.total_rows > 0 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 10,
                  padding: "10px 12px",
                  border: "1px solid #E2E8F0",
                  borderRadius: 8,
                  fontSize: 13,
                  color: "#475569",
                }}
              >
                <span>
                  Showing <strong>1–{rows.length}</strong> of <strong>{grid.total_rows}</strong> total
                  {rows.length < grid.total_rows && <span style={{ color: "#94A3B8" }}> · scroll for more</span>}
                </span>
              </div>
            )}
          </>
        )}

        {/* Columns panel: show/hide + freeze/unfreeze + color-status opt-in, all in one place (needed for hidden columns, since they have no visible header to un-hide from). */}
        {columnsPanelOpen && (
          <SimpleModal title="Configuration" onClose={() => setColumnsPanelOpen(false)}>
            {/*
              Group Label fix -- separate from the columns list below.
              Corrects a sheet whose "+Next <label>" group name ended up
              wrong (e.g. left at the default "Mum" instead of what this
              branch actually needed) without creating a new sheet or
              touching any row/cell data. See
              PlanningService.update_mum_group_label.
            */}
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid #E2E8F0" }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#94A3B8", textTransform: "uppercase", marginBottom: 6 }}>
                Group Label
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  value={groupLabelDraft}
                  onChange={(e) => setGroupLabelDraft(e.target.value)}
                  placeholder="e.g. Mum, MP, CN, Test"
                  style={{
                    flex: 1,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid #CBD5E1",
                    fontSize: 13,
                  }}
                />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleUpdateGroupLabel()}
                  disabled={
                    savingGroupLabel || !groupLabelDraft.trim() || groupLabelDraft.trim() === (grid?.sheet?.mum_group_label || "Mum")
                  }
                >
                  {savingGroupLabel ? "Saving…" : "Save"}
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#94A3B8", marginTop: 6 }}>
                Renames every "{grid?.sheet?.mum_group_label || "Mum"} N" column and formula on this sheet to "
                {groupLabelDraft.trim() || "…"} N" -- row and cell data is unaffected.
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: "50vh", overflowY: "auto" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 70px 70px 90px",
                  gap: 8,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "#94A3B8",
                  textTransform: "uppercase",
                  padding: "0 4px 6px",
                  borderBottom: "1px solid #E2E8F0",
                }}
              >
                <span>Column</span>
                <span style={{ textAlign: "center" }}>Visible</span>
                <span style={{ textAlign: "center" }}>Frozen</span>
                <span style={{ textAlign: "center" }}>Color Status</span>
              </div>
              {configurableColumns.map((col) => (
                <div
                  key={col.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 70px 70px 90px",
                    gap: 8,
                    alignItems: "center",
                    padding: "6px 4px",
                    borderBottom: "1px solid #F1F5F9",
                  }}
                >
                  <span style={{ fontSize: 13, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {col.name}
                  </span>
                  <span style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={!hiddenColumnIds.has(col.id)}
                      onChange={() => toggleColumnHidden(col.id)}
                      title={hiddenColumnIds.has(col.id) ? "Show this column" : "Hide this column"}
                    />
                  </span>
                  <span style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={frozenColumnIds.has(col.id)}
                      disabled={hiddenColumnIds.has(col.id)}
                      onChange={() => toggleColumnFrozen(col.id)}
                      title={frozenColumnIds.has(col.id) ? "Unfreeze this column" : "Freeze this column (pin it while scrolling)"}
                    />
                  </span>
                  <span style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      checked={col.enable_status_color ?? false}
                      disabled={!isPureMumColumn(col.name) || togglingStatusColorId === col.id}
                      onChange={() => handleToggleColumnStatusColor(col.id, !(col.enable_status_color ?? false))}
                      title={
                        !isPureMumColumn(col.name)
                          ? "Status colors are only allowed on Mum N main columns"
                          : col.enable_status_color
                            ? "Disable status colors for this column"
                            : "Allow this column's cells to carry a CRM-style status color"
                      }
                    />
                  </span>
                </div>
              ))}
              {configurableColumns.length === 0 && <div className="muted" style={{ padding: "10px 4px" }}>No configurable columns.</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (!activeSheetId) return;
                  setHiddenColumnIds(new Set());
                  setFrozenColumnIds(new Set());
                  localStorage.removeItem(hiddenColumnsStorageKey(activeSheetId));
                  localStorage.removeItem(frozenColumnsStorageKey(activeSheetId));
                }}
              >
                Reset all
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setColumnsPanelOpen(false)}>
                Done
              </button>
            </div>
          </SimpleModal>
        )}

        {/* Configure Column modal (handles all columns including ITEM) */}
        {configureColumn && activeSheetId && (
          <ConfigureColumnModal
            sheetId={activeSheetId}
            column={configureColumn}
            onClose={() => setConfigureColumn(null)}
            onSaved={() => {
              setConfigureColumn(null);
              void loadGrid(activeSheetId);
            }}
            onRefresh={() => void loadGrid(activeSheetId)}
            onError={setError}
          />
        )}

        {addSheetOpen && (
          <SimpleModal title="Add Sheet (Branch Tab)" onClose={() => setAddSheetOpen(false)}>
            <form onSubmit={handleCreateSheet}>
              {/*
                Every sheet must now be linked to one real branch from
                Product Master's organization list (see
                PlanningSheet.organization_id/branch_id) -- this replaces
                "branch" being nothing more than whatever text was typed
                into a name field. There is no separate sheet-name input
                anymore: the sheet's name is always exactly the selected
                branch's own name (see handleCreateSheet), so the tab
                shown next to "Mumbai Branch"/"Chennai Branch" always
                matches Product Master's branch list verbatim, instead of
                risking two different names for the same branch. Branch
                options are scoped to whichever organization is currently
                selected; picking a different organization clears the
                branch selection since a branch id from one organization
                is meaningless for another.
              */}
              <div style={{ marginTop: 12 }}>
                <SelectField
                  id="new_sheet_organization"
                  label="Organization *"
                  required
                  value={newSheetOrganizationId}
                  onChange={(v) => {
                    setNewSheetOrganizationId(v);
                    setNewSheetBranchId("");
                  }}
                  hint="Which Product Master organization this sheet's branch belongs to."
                >
                  <option value="">Select an organization…</option>
                  {organizations.items.map((org) => (
                    <option key={org.id} value={org.id}>
                      {org.name}
                    </option>
                  ))}
                </SelectField>
              </div>
              <div style={{ marginTop: 12 }}>
                <SelectField
                  id="new_sheet_branch"
                  label="Branch *"
                  required
                  value={newSheetBranchId}
                  onChange={setNewSheetBranchId}
                  hint={
                    !newSheetOrganizationId
                      ? "Pick an organization first."
                      : "This sheet will only show Product Master rows in this exact branch."
                  }
                >
                  <option value="">
                    {newSheetOrganizationId ? "Select a branch…" : "Select an organization first"}
                  </option>
                  {(organizations.items.find((o) => o.id === newSheetOrganizationId)?.branches || []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </SelectField>
              </div>
              <div style={{ marginTop: 12 }}>
                <TextField
                  id="new_sheet_group_label"
                  label="Group Label Name *"
                  required
                  placeholder="e.g. CN, MP, Mum, Chen"
                  value={newSheetGroupLabel}
                  onChange={setNewSheetGroupLabel}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setAddSheetOpen(false)}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={!newSheetGroupLabel.trim() || !newSheetOrganizationId || !newSheetBranchId}
                >
                  Create Sheet
                </button>
              </div>
            </form>
          </SimpleModal>
        )}

        {statusPicker && (
          <StatusPicker
            anchor={statusPicker.anchor}
            customTags={customTags}
            onClose={() => setStatusPicker(null)}
            onPick={(color, tagId) => handleSetCellStatus(statusPicker.rowId, statusPicker.columnId, color, tagId)}
            canPickRed={canSetRedStatus}
            canPickGreen={canSetGreenStatus}
            canPickBlue={canEditCells}
            canPickCustom={canEditCells}
            canClearStatus={canEditCells}
          />
        )}

        {mumHistoryPopover && activeSheetId && (
          <MumStatusHistoryPopover
            anchor={mumHistoryPopover.anchor}
            sheetId={activeSheetId}
            rowId={mumHistoryPopover.rowId}
            visibleMumGroupNumbers={visibleMumGroupNumbers}
            mumGroupLabel={grid?.sheet?.mum_group_label}
            onClose={() => setMumHistoryPopover(null)}
          />
        )}

        {filterPopover && activeSheetId && (
          <ColumnFilterPopover
            anchor={filterPopover.anchor}
            sheetId={activeSheetId}
            columnId={filterPopover.columnId}
            columnName={filterPopover.columnName}
            organizationId={activeOrganizationId}
            fallbackUniqueValues={getUniqueValuesForColumn(filterPopover.columnId)}
            currentFilter={activeColumnFilters[`${activeSheetId}:${filterPopover.columnId}`]}
            onApply={(filter) => {
              setActiveColumnFilters((prev) => ({
                ...prev,
                [`${activeSheetId}:${filterPopover.columnId}`]: filter,
              }));
            }}
            onClear={() => {
              setActiveColumnFilters((prev) => {
                const next = { ...prev };
                delete next[`${activeSheetId}:${filterPopover.columnId}`];
                return next;
              });
            }}
            onClose={() => setFilterPopover(null)}
          />
        )}

        {historyOpen && (
          <HistoryDrawer entries={historyEntries} loading={historyLoading} onClose={() => setHistoryOpen(false)} />
        )}

        {linkPicker && activeSheetId && (
          <LinkRecordModal
            sheetId={activeSheetId}
            rowId={linkPicker.rowId}
            column={linkPicker.column}
            onClose={() => setLinkPicker(null)}
            onLinked={() => {
              setLinkPicker(null);
              void loadGrid(activeSheetId);
            }}
            onError={setError}
          />
        )}
      </main>
    </AppShell>
  );
}

/** One admin-defined column header: click name to rename (if permitted), × to delete. */
function ColumnHeader({
  column,
  canManage,
  onRename,
  onDelete,
  onSaveDescription,
  isFrozen,
  isLastFrozen,
  stickyLeft,
  isFiltered,
  onOpenFilter,
  width,
  onResize,
  isSorted,
  sortDirection,
  onSort,
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSaveDescription: (text: string | null) => void;
  isFrozen: boolean;
  isLastFrozen: boolean;
  stickyLeft: number | undefined;
  isFiltered?: boolean;
  onOpenFilter?: (anchor: HTMLElement) => void;
  /** This column's effective width (computed from its header label, or manually resized). Falls back to CELL_MIN_WIDTH if omitted. */
  width?: number;
  /** Called with the final width (px) once the user releases a drag-resize. Omit to disable resizing (e.g. the ITEM column, which has its own header component). */
  onResize?: (widthPx: number) => void;
  isSorted?: boolean;
  sortDirection?: "asc" | "desc";
  onSort?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [descAnchor, setDescAnchor] = useState<HTMLElement | null>(null);
  const [resizing, setResizing] = useState(false);
  const hasDescription = !!column.description;
  const colWidth = width ?? CELL_MIN_WIDTH;

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== column.name) onRename(draft.trim());
    else setDraft(column.name);
  }

  /**
   * Excel-style drag-to-resize: track the pointer's raw movement (not
   * its absolute position, which would jump if the sheet itself is
   * mid-scroll) relative to the width at drag-start, live-updating a
   * local CSS variable on the <th> for zero-re-render dragging feedback,
   * then committing the final width via onResize only once on release
   * (drag-resize would otherwise fire a network request on every pixel
   * of mouse movement).
   */
  function handleResizeStart(e: React.MouseEvent<HTMLDivElement>) {
    if (!onResize) return;
    const resizeCallback = onResize;
    e.preventDefault();
    e.stopPropagation();
    const th = e.currentTarget.closest("th") as HTMLTableCellElement | null;
    const startX = e.clientX;
    const startWidth = colWidth;
    setResizing(true);

    function handleMouseMove(moveEvent: MouseEvent) {
      const delta = moveEvent.clientX - startX;
      const next = Math.max(CELL_MIN_WIDTH, Math.min(CELL_MAX_WIDTH, startWidth + delta));
      if (th) {
        th.style.width = `${next}px`;
        th.style.minWidth = `${next}px`;
        th.style.maxWidth = `${next}px`;
      }
    }
    function handleMouseUp(upEvent: MouseEvent) {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
      setResizing(false);
      const delta = upEvent.clientX - startX;
      const next = Math.max(CELL_MIN_WIDTH, Math.min(CELL_MAX_WIDTH, startWidth + delta));
      if (next !== startWidth) resizeCallback(next);
    }
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  }

  const sourceBadge =
    column.source_type === "formula"
      ? { label: "ƒx", title: `Formula: ${column.formula_expression || ""}` }
      : column.source_type === "linked_lookup"
        ? { label: "🔗", title: `Linked lookup: ${column.source_module}.${column.source_field}` }
        : column.source_type === "aggregate"
          ? { label: "Σ", title: `Aggregate: ${column.source_aggregate_fn}(${column.source_module}.${column.source_field})` }
          : null;

  return (
    <th
      style={{
        padding: "5px 8px",
        textAlign: "center",
        minWidth: colWidth,
        width: colWidth,
        maxWidth: colWidth,
        boxSizing: "border-box",
        borderBottom: "1px solid #E2E8F0",
        borderRight: isFrozen && isLastFrozen ? "2px solid #CBD5E1" : "1px solid #E2E8F0",
        position: "sticky",
        top: 0,
        left: isFrozen ? stickyLeft : undefined,
        zIndex: isFrozen ? 11 : 10,
        background: "#F8FAFC",
        boxShadow: isFrozen && isLastFrozen ? "3px 0 6px -2px rgba(0,0,0,0.15)" : undefined,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", width: "100%", minHeight: 28, gap: 2 }}>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(column.name);
                setEditing(false);
              }
            }}
            style={{ width: "100%", border: "1px solid #2563EB", borderRadius: 4, padding: "2px 5px", fontSize: 13, textAlign: "center" }}
          />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 3, width: "100%", minWidth: 0 }}>
              <span
                onClick={() => {
                  if (onSort) onSort();
                  else if (canManage) setEditing(true);
                }}
                style={{
                  cursor: "pointer",
                  fontWeight: 600,
                  color: isSorted ? "#0284c7" : "#334155",
                  textAlign: "center",
                  padding: "0 2px",
                  whiteSpace: "normal",
                  wordBreak: "break-word",
                  lineHeight: "1.2",
                  minWidth: 0,
                  overflow: "hidden",
                }}
                title={
                  isSorted
                    ? `Sorted by ${column.name} (${sortDirection === "asc" ? "Ascending — click for Descending" : "Descending — click to reset"})`
                    : `Click to sort by ${column.name} (Ascending)`
                }
              >
                {column.name}
              </span>
              {isSorted ? (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort?.();
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    color: "#0284c7",
                    fontSize: "10px",
                    fontWeight: 800,
                    background: "#e0f2fe",
                    padding: "1px 4px",
                    borderRadius: "3px",
                    border: "1px solid #bae6fd",
                    lineHeight: 1,
                    flexShrink: 0,
                    cursor: "pointer",
                  }}
                  title={sortDirection === "asc" ? "Ascending (click for Descending)" : "Descending (click to reset)"}
                >
                  {sortDirection === "asc" ? "▲" : "▼"}
                </span>
              ) : (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort?.();
                  }}
                  style={{
                    fontSize: "10px",
                    color: "#94a3b8",
                    opacity: 0.45,
                    lineHeight: 1,
                    flexShrink: 0,
                    cursor: "pointer",
                  }}
                  title={`Sort by ${column.name}`}
                >
                  ↕
                </span>
              )}
              {sourceBadge && (
                <span
                  title={sourceBadge.title}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#7C3AED",
                    background: "#EDE9FE",
                    borderRadius: 4,
                    padding: "1px 4px",
                    flexShrink: 0,
                  }}
                >
                  {sourceBadge.label}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, flexShrink: 0, marginTop: 2 }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFilter?.(e.currentTarget);
                }}
                title={isFiltered ? `Filter active on ${column.name}` : `Filter ${column.name}`}
                style={{
                  border: "none",
                  background: isFiltered ? "#EFF6FF" : "transparent",
                  color: isFiltered ? "#2563EB" : "#94A3B8",
                  cursor: "pointer",
                  padding: "1px 3px",
                  borderRadius: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  lineHeight: 1,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill={isFiltered ? "#2563EB" : "none"} stroke="currentColor" strokeWidth="2.5">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                </svg>
              </button>

              {isPureMumColumn(column.name) && (
                <button
                  type="button"
                  onClick={(e) => setDescAnchor(descAnchor ? null : e.currentTarget)}
                  title={hasDescription ? `Description: ${column.description}` : "Add a note about this column"}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: "1px 3px",
                    color: hasDescription ? "#2563EB" : "#94A3B8",
                    display: "inline-flex",
                    alignItems: "center",
                    lineHeight: 1,
                  }}
                >
                  ✎
                </button>
              )}

              {canManage && !isSystemColumn(column.name) && (
                <button
                  type="button"
                  onClick={onDelete}
                  title="Delete column"
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "#94A3B8",
                    fontSize: 13,
                    padding: "0 2px",
                    lineHeight: 1,
                    display: "inline-flex",
                    alignItems: "center",
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.color = "#EF4444")}
                  onMouseLeave={(e) => (e.currentTarget.style.color = "#94A3B8")}
                >
                  ×
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {descAnchor && (
        <DescriptionPopover
          anchor={descAnchor}
          initialValue={column.description ?? ""}
          onSave={(text) => onSaveDescription(text || null)}
          onClose={() => setDescAnchor(null)}
        />
      )}
      {onResize && (
        <div
          onMouseDown={handleResizeStart}
          title="Drag to resize column"
          style={{
            position: "absolute",
            top: 0,
            right: -2,
            bottom: 0,
            width: 5,
            cursor: "col-resize",
            zIndex: 13,
            background: resizing ? "#2563EB" : "transparent",
          }}
        />
      )}
    </th>
  );
}

/** Header cell for the first column ("ITEM"). Uses exact same gear function & configuration modal as all other columns. */
function EditableItemHeader({
  column,
  canManage,
  onRename,
  onSaveDescription,
  itemDescription,
  isLastFrozen,
  isFiltered,
  onOpenFilter,
  isSorted,
  sortDirection,
  onSort,
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (newTitle: string) => void;
  onSaveDescription: (text: string | null) => void;
  itemDescription?: string | null;
  isLastFrozen?: boolean;
  isFiltered?: boolean;
  onOpenFilter?: (anchor: HTMLElement) => void;
  isSorted?: boolean;
  sortDirection?: "asc" | "desc";
  onSort?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [descAnchor, setDescAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const hasDescription = !!itemDescription;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setDraft(column.name);
  }, [column.name]);

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== column.name) {
      onRename(draft.trim());
    } else {
      setDraft(column.name);
    }
  }

  const sourceBadge =
    column.source_type === "formula"
      ? { label: "ƒx", title: `Formula: ${column.formula_expression || ""}` }
      : column.source_type === "linked_lookup"
        ? { label: "🔗", title: `Linked lookup: ${column.source_module}.${column.source_field}` }
        : column.source_type === "aggregate"
          ? { label: "Σ", title: `Aggregate: ${column.source_aggregate_fn}(${column.source_module}.${column.source_field})` }
          : null;

  return (
    <th
      style={{
        padding: "5px 8px",
        textAlign: "left",
        minWidth: ITEM_COL_WIDTH,
        width: ITEM_COL_WIDTH,
        maxWidth: ITEM_COL_WIDTH,
        boxSizing: "border-box",
        borderBottom: "1px solid #E2E8F0",
        borderRight: isLastFrozen ? "2px solid #CBD5E1" : "1px solid #E2E8F0",
        position: "sticky",
        top: 0,
        left: 0,
        zIndex: 12,
        background: "#F8FAFC",
        boxShadow: isLastFrozen ? "3px 0 6px -2px rgba(0,0,0,0.15)" : undefined,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center", width: "100%", minHeight: 28, gap: 2 }}>
        {editing && canManage ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(column.name);
                setEditing(false);
              }
            }}
            style={{ width: "100%", border: "1px solid #2563EB", borderRadius: 4, padding: "2px 5px", fontSize: 13, fontWeight: 600 }}
          />
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 3, width: "100%", minWidth: 0 }}>
              <span
                onClick={() => {
                  if (onSort) onSort();
                  else if (canManage) setEditing(true);
                }}
                title={
                  isSorted
                    ? `Sorted by ${column.name} (${sortDirection === "asc" ? "Ascending — click for Descending" : "Descending — click to reset"})`
                    : `Click to sort by ${column.name} (Ascending)`
                }
                style={{
                  cursor: "pointer",
                  fontWeight: 600,
                  color: isSorted ? "#0284c7" : "#334155",
                  minWidth: 0,
                  flex: "1 1 auto",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {column.name}
              </span>
              {isSorted ? (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort?.();
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    color: "#0284c7",
                    fontSize: "10px",
                    fontWeight: 800,
                    background: "#e0f2fe",
                    padding: "1px 4px",
                    borderRadius: "3px",
                    border: "1px solid #bae6fd",
                    lineHeight: 1,
                    flexShrink: 0,
                    cursor: "pointer",
                  }}
                  title={sortDirection === "asc" ? "Ascending (click for Descending)" : "Descending (click to reset)"}
                >
                  {sortDirection === "asc" ? "▲" : "▼"}
                </span>
              ) : (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort?.();
                  }}
                  style={{
                    fontSize: "10px",
                    color: "#94a3b8",
                    opacity: 0.45,
                    lineHeight: 1,
                    flexShrink: 0,
                    cursor: "pointer",
                  }}
                  title="Sort by Item"
                >
                  ↕
                </span>
              )}
              {sourceBadge && (
                <span
                  title={sourceBadge.title}
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: "#7C3AED",
                    background: "#EDE9FE",
                    borderRadius: 4,
                    padding: "1px 4px",
                    flexShrink: 0,
                  }}
                >
                  {sourceBadge.label}
                </span>
              )}
            </div>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, flexShrink: 0, marginTop: 2 }}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenFilter?.(e.currentTarget);
                }}
                title={isFiltered ? `Filter active on ${column.name}` : `Filter ${column.name}`}
                style={{
                  border: "none",
                  background: isFiltered ? "#EFF6FF" : "transparent",
                  color: isFiltered ? "#2563EB" : "#94A3B8",
                  cursor: "pointer",
                  padding: "1px 3px",
                  borderRadius: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  lineHeight: 1,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill={isFiltered ? "#2563EB" : "none"} stroke="currentColor" strokeWidth="2.5">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                </svg>
              </button>

              {column.enable_description && (
                <button
                  type="button"
                  onClick={(e) => setDescAnchor(descAnchor ? null : e.currentTarget)}
                  title={hasDescription ? `Description: ${itemDescription}` : "Add a note about this column"}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 12,
                    padding: "1px 3px",
                    color: hasDescription ? "#2563EB" : "#94A3B8",
                    display: "inline-flex",
                    alignItems: "center",
                    lineHeight: 1,
                  }}
                >
                  ✎
                </button>
              )}
            </div>
          </>
        )}
      </div>
      {descAnchor && (
        <DescriptionPopover
          anchor={descAnchor}
          initialValue={itemDescription ?? ""}
          onSave={(text) => onSaveDescription(text || null)}
          onClose={() => setDescAnchor(null)}
        />
      )}
    </th>
  );
}

/** Row label cell (first column). Clickable and inline-editable just like grid cells, unless the sheet's ITEM column is linked-lookup -- then it's pulled from the linked record instead. */
function EditableRowLabel({
  label,
  canEdit,
  sourceType,
  onSave,
  isLastFrozen,
}: {
  label: string;
  canEdit: boolean;
  sourceType: PlanningColumnSourceType;
  onSave: (newLabel: string) => void;
  isLastFrozen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);
  const isManual = sourceType === "manual";

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setDraft(label);
  }, [label]);

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== label) {
      onSave(draft.trim());
    } else {
      setDraft(label);
    }
  }

  return (
    <td
      style={{
        padding: "4px 8px",
        textAlign: "left",
        borderBottom: "1px solid #F1F5F9",
        borderRight: isLastFrozen ? "2px solid #CBD5E1" : "1px solid #F1F5F9",
        fontWeight: 500,
        minWidth: ITEM_COL_WIDTH,
        width: ITEM_COL_WIDTH,
        maxWidth: ITEM_COL_WIDTH,
        boxSizing: "border-box",
        position: "sticky",
        left: 0,
        zIndex: 4,
        background: "#fff",
        boxShadow: isLastFrozen ? "3px 0 6px -2px rgba(0,0,0,0.15)" : undefined,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, width: "100%", minWidth: 0, overflow: "hidden" }}>
        {editing && canEdit && isManual ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(label);
                setEditing(false);
              }
            }}
            style={{ width: "100%", border: "1px solid #2563EB", borderRadius: 4, padding: "3px 6px", fontSize: 13, fontWeight: 500, boxSizing: "border-box" }}
          />
        ) : (
          <span
            onClick={() => canEdit && isManual && setEditing(true)}
            title={
              label
                ? (!isManual
                  ? `${label} (Auto-filled from Product Master)`
                  : canEdit
                    ? `${label} (Click to edit Item label)`
                    : label)
                : undefined
            }
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              cursor: canEdit && isManual ? "pointer" : "default",
              fontSize: 13,
              display: "block",
              fontStyle: !isManual ? "italic" : undefined,
              color: !isManual ? "#475569" : "#0F172A",
            }}
          >
            {label}
          </span>
        )}
      </div>
    </td>
  );
}

/** Small centered modal, matching the create-form pattern used elsewhere (e.g. Users.tsx). */
function SimpleModal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.35)" }} onClick={onClose} />
      <div
        style={{
          position: "relative",
          width: 420,
          maxWidth: "90vw",
          background: "#fff",
          borderRadius: 10,
          boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
          padding: 20,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

/**
 * Configure a column's data source: Manual / Linked Lookup / Aggregate / Formula,
 * plus the optional per-column role lock. One modal covers all four source
 * types -- the fields shown change based on the selected type, mirroring
 * the same "reveal fields as needed" pattern used in the Add Column modal.
 */
function ConfigureColumnModal({
  sheetId,
  column,
  onClose,
  onSaved,
  onRefresh,
  onError,
}: {
  sheetId: string;
  column: PlanningColumn;
  onClose: () => void;
  onSaved: () => void;
  onRefresh: () => void;
  onError: (err: unknown) => void;
}) {
  const isItemColumn = column.id === "item-header-col";
  const [sourceType, setSourceType] = useState<PlanningColumnSourceType>(column.source_type);
  const [sourceModule, setSourceModule] = useState(column.source_module || "");
  const [sourceField, setSourceField] = useState(column.source_field || "");
  const [aggregateFn, setAggregateFn] = useState<PlanningAggregateFn | "">(column.source_aggregate_fn || "");
  const [formulaExpression, setFormulaExpression] = useState(column.formula_expression || "");
  const [modules, setModules] = useState<SourceModuleInfo[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [lockedRoleIds, setLockedRoleIds] = useState<string[]>([]);
  const [savingLock, setSavingLock] = useState(false);
  // "Load everything from that field's data automatically" -- keeps the
  // existing manual per-row 🔗 flow intact, this is purely additive. For
  // ITEM this bulk-creates rows straight from the source module (paged by
  // pageSize); for a regular column it bulk-links every row's cell to
  // whatever record that row's ITEM is already linked to.
  const [enableDescription, setEnableDescription] = useState<boolean>(column.enable_description ?? false);
  const [autoPopulate, setAutoPopulate] = useState<boolean>(column.auto_populate_enabled ?? false);
  const [pageSize, setPageSize] = useState<25 | 50 | 100 | "all">(
    column.auto_populate_limit == null ? "all" : ([25, 50, 100].includes(column.auto_populate_limit) ? (column.auto_populate_limit as 25 | 50 | 100) : "all")
  );
  const [autoPopulating, setAutoPopulating] = useState(false);
  const [autoPopulateResult, setAutoPopulateResult] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiGet<SourceModuleInfo[]>("/planning/source-modules");
        setModules(data);
      } catch (err) {
        onError(err);
      }
      if (isItemColumn) return; // ITEM has no per-column role lock -- it isn't a row in planning_columns.
      try {
        const { data } = await apiGet<Role[]>("/rbac/roles");
        setRoles(data);
      } catch {
        // Non-critical: the role-lock section simply won't have options if this fails.
      }
      try {
        const { data } = await apiGet<{ role_ids: string[] }>(
          `/planning/sheets/${sheetId}/columns/${column.id}/role-lock`
        );
        setLockedRoleIds(data.role_ids);
      } catch {
        // No lock set yet, or endpoint unavailable -- default to unlocked.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [column.id, sheetId]);

  const selectedModule = modules.find((m) => m.key === sourceModule);
  const fieldOptions = selectedModule?.fields ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setAutoPopulateResult(null);
    const resolvedLimit = pageSize === "all" ? null : pageSize;
    try {
      if (isItemColumn) {
        await apiPut(`/planning/sheets/${sheetId}/item-source`, {
          source_type: sourceType,
          source_module: sourceType === "linked_lookup" ? sourceModule || null : null,
          source_field: sourceType === "linked_lookup" ? sourceField || null : null,
          formula_expression: sourceType === "formula" ? formulaExpression || null : null,
          item_enable_description: enableDescription,
          item_auto_populate_enabled: autoPopulate,
          item_auto_populate_limit: resolvedLimit,
        });
        if (sourceType === "linked_lookup" && autoPopulate) {
          setAutoPopulating(true);
          try {
            const { data } = await apiPost<unknown[]>(`/planning/sheets/${sheetId}/item-source/auto-populate`, {
              limit: resolvedLimit,
            });
            setAutoPopulateResult(`Added ${data.length} row(s) from ${selectedModule?.label || "the source module"}.`);
            onRefresh();
            return; // keep the modal open so the result message above is visible
          } finally {
            setAutoPopulating(false);
          }
        }
        onSaved();
        return;
      }
      await apiPut(`/planning/sheets/${sheetId}/columns/${column.id}/source`, {
        source_type: sourceType,
        source_module: sourceType === "linked_lookup" || sourceType === "aggregate" ? sourceModule || null : null,
        source_field: sourceType === "linked_lookup" || sourceType === "aggregate" ? sourceField || null : null,
        source_aggregate_fn: sourceType === "aggregate" ? aggregateFn || null : null,
        source_aggregate_filters: null,
        formula_expression: sourceType === "formula" ? formulaExpression || null : null,
        enable_description: enableDescription,
        auto_populate_enabled: autoPopulate,
        auto_populate_limit: resolvedLimit,
      });
      if (sourceType === "linked_lookup" && autoPopulate) {
        setAutoPopulating(true);
        try {
          const { data } = await apiPost<unknown[]>(`/planning/sheets/${sheetId}/columns/${column.id}/auto-link`);
          setAutoPopulateResult(`Linked ${data.length} row(s) to their ITEM's record.`);
          onRefresh();
          return; // keep the modal open so the result message above is visible
        } finally {
          setAutoPopulating(false);
        }
      }
      onSaved();
    } catch (err) {
      onError(err);
    }
  }

  async function handleSaveRoleLock() {
    if (isItemColumn) return; // No-op: role-lock section isn't rendered for ITEM (see below).
    setSavingLock(true);
    try {
      await apiPut(`/planning/sheets/${sheetId}/columns/${column.id}/role-lock`, { role_ids: lockedRoleIds });
    } catch (err) {
      onError(err);
    } finally {
      setSavingLock(false);
    }
  }

  function toggleRole(roleId: string) {
    setLockedRoleIds((prev) => (prev.includes(roleId) ? prev.filter((r) => r !== roleId) : [...prev, roleId]));
  }

  return (
    <SimpleModal title={`Configure Column — ${column.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <SelectField
          id="source_type"
          label="Data Source"
          value={sourceType}
          onChange={(v) => setSourceType(v as PlanningColumnSourceType)}
          hint="Manual: type values directly. The other three compute the value automatically."
        >
          <option value="manual">Manual entry</option>
          <option value="linked_lookup">Linked lookup (pull one field per row from another module)</option>
          {!isItemColumn && <option value="aggregate">Aggregate (one computed value from another module)</option>}
          <option value="formula">Formula (calculate from other columns in this sheet)</option>
        </SelectField>

        {(sourceType === "linked_lookup" || sourceType === "aggregate") && (
          <>
            <div style={{ marginTop: 12 }}>
              <SelectField
                id="source_module"
                label="Source Module *"
                required
                value={sourceModule}
                onChange={(v) => {
                  setSourceModule(v);
                  setSourceField("");
                }}
              >
                <option value="">Select a module…</option>
                {modules.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </SelectField>
            </div>
            <div style={{ marginTop: 12 }}>
              <SelectField id="source_field" label="Field *" required value={sourceField} onChange={setSourceField}>
                <option value="">Select a field…</option>
                {fieldOptions
                  .filter((f) => sourceType === "linked_lookup" || aggregateFn === "count" || f.is_numeric)
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
              </SelectField>
            </div>
          </>
        )}

        {sourceType === "aggregate" && (
          <div style={{ marginTop: 12 }}>
            <SelectField
              id="aggregate_fn"
              label="Calculation *"
              required
              value={aggregateFn}
              onChange={(v) => setAggregateFn(v as PlanningAggregateFn)}
            >
              <option value="">Select…</option>
              <option value="count">Count</option>
              <option value="sum">Sum</option>
              <option value="avg">Average</option>
              <option value="min">Minimum</option>
              <option value="max">Maximum</option>
            </SelectField>
          </div>
        )}

        {sourceType === "formula" && (
          <div style={{ marginTop: 12 }}>
            <TextAreaField
              id="formula_expression"
              label="Formula *"
              rows={2}
              value={formulaExpression}
              onChange={setFormulaExpression}
              placeholder="e.g. Mum40 * Rate + 5"
              hint="Reference other columns on this sheet by their exact name. Supports + - * / ** % and round/abs/min/max/sum."
            />
          </div>
        )}

        {sourceType === "linked_lookup" && (
          <div
            style={{
              marginTop: 14,
              padding: 10,
              background: "#F8FAFC",
              border: "1px solid #E2E8F0",
              borderRadius: 8,
            }}
          >
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={autoPopulate}
                onChange={(e) => setAutoPopulate(e.target.checked)}
                style={{ marginTop: 2 }}
              />
              <span style={{ fontSize: 13 }}>
                <strong>{isItemColumn ? "Load all records automatically" : "Auto-link to each row's ITEM record"}</strong>
                <br />
                <span className="muted" style={{ fontSize: 12 }}>
                  {isItemColumn
                    ? "Pulls records straight from the selected module and creates a row for each one, already linked — no need to link every row by hand. Manual per-row linking (🔗) still works too."
                    : "Links every existing row's cell here to whatever record that row's ITEM is already linked to, instead of clicking 🔗 for each row. Only works when this column and ITEM pull from the same module."}
                </span>
              </span>
            </label>
            {isItemColumn && autoPopulate && (
              <div style={{ marginTop: 10 }}>
                <SelectField
                  id="auto_populate_page_size"
                  label="How many records to load"
                  value={String(pageSize)}
                  onChange={(v) => setPageSize(v === "all" ? "all" : (Number(v) as 25 | 50 | 100))}
                >
                  <option value="25">25</option>
                  <option value="50">50</option>
                  <option value="100">100</option>
                  <option value="all">All</option>
                </SelectField>
              </div>
            )}
            {autoPopulateResult && (
              <div style={{ marginTop: 10, fontSize: 12, color: "#15803D", fontWeight: 600 }}>✓ {autoPopulateResult}</div>
            )}
          </div>
        )}

        {/* Description feature — opt-in per column; when enabled, the column
            header shows a ✎ button the user can click to write a single
            free-text note about the whole column. */}
        <div
          style={{
            marginTop: 16,
            padding: "10px 12px",
            background: "#F8FAFC",
            border: "1px solid #E2E8F0",
            borderRadius: 8,
          }}
        >
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={enableDescription}
              onChange={(e) => setEnableDescription(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
            />
            <span style={{ fontSize: 13 }}>
              <strong>Description</strong>
              <br />
              <span className="muted" style={{ fontSize: 12 }}>
                When checked, this column's header shows a{" "}
                <span style={{ fontFamily: "monospace", fontWeight: 600 }}>✎</span> button on hover.
                Clicking it opens a free-text note about this column as a whole — independent
                of any cell's value or status, purely for supplementary context.
              </span>
            </span>
          </label>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            {autoPopulateResult ? "Close" : "Cancel"}
          </button>
          <button type="submit" className="btn btn-primary" disabled={autoPopulating}>
            {autoPopulating ? "Loading…" : "Save Data Source"}
          </button>
        </div>
      </form>

      {roles.length > 0 && (
        <div style={{ borderTop: "1px solid #E2E8F0", marginTop: 20, paddingTop: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Restrict Editing to Roles (optional)</div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
            Leave empty to allow anyone with edit access to this sheet. Selecting one or more roles restricts
            this column's cells — including its value, status color/dot, and description — to only users holding
            one of those roles. The Admin role can always edit every column regardless of this setting.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {roles
              .filter((role) => role.name !== "super_admin")
              .map((role) => (
                <label
                  key={role.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 12,
                    border: "1px solid #E2E8F0",
                    borderRadius: 6,
                    padding: "4px 8px",
                    cursor: "pointer",
                    background: lockedRoleIds.includes(role.id) ? "#EDE9FE" : "#fff",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={lockedRoleIds.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                  />
                  {roleDisplayName(role.name)}
                </label>
              ))}
          </div>
          <button type="button" className="btn btn-secondary" onClick={handleSaveRoleLock} disabled={savingLock}>
            {savingLock ? "Saving…" : "Save Role Lock"}
          </button>
        </div>
      )}
    </SimpleModal>
  );
}



/**
 * Link one row's cell (under a LINKED_LOOKUP column) to a specific record
 * in that column's source module, e.g. picking which Product a row
 * represents so the column can pull that Product's field automatically.
 */
function LinkRecordModal({
  sheetId,
  rowId,
  column,
  onClose,
  onLinked,
  onError,
}: {
  sheetId: string;
  rowId: string;
  column: PlanningColumn;
  onClose: () => void;
  onLinked: () => void;
  onError: (err: unknown) => void;
}) {
  const [recordId, setRecordId] = useState("");

  const apiBase = SOURCE_MODULE_API[column.source_module || ""] || "";

  const recordFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      if (!apiBase) return [];
      const { data } = await apiGet<Record<string, unknown>[]>(
        apiBase + toQueryString({ search: term, page: 1, page_size: 20 }),
        { signal }
      );
      const labelField = SOURCE_MODULE_LABEL_FIELD[column.source_module || ""] || "name";
      return data.map((d) => ({ value: String(d.id), label: String(d[labelField] ?? d.id) }));
    },
    [apiBase, column.source_module] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const recordLabel = useCallback(
    async (id: string) => {
      if (!apiBase) return id;
      const { data } = await apiGet<Record<string, unknown>>(`${apiBase}/${id}`);
      const labelField = SOURCE_MODULE_LABEL_FIELD[column.source_module || ""] || "name";
      return String(data[labelField] ?? id);
    },
    [apiBase, column.source_module] // eslint-disable-line react-hooks/exhaustive-deps
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recordId) return;
    try {
      const endpoint =
        column.id === "item-header-col"
          ? `/planning/sheets/${sheetId}/rows/${rowId}/item-link`
          : `/planning/sheets/${sheetId}/rows/${rowId}/columns/${column.id}/link`;
      await apiPut(endpoint, { record_id: recordId });
      onLinked();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <SimpleModal title={`Link Row — ${column.name}`} onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
          Select a record to link *
        </label>
        <SearchableDropdown
          value={recordId}
          onChange={(v) => setRecordId(v || "")}
          placeholder="Search…"
          fetchOptions={recordFetcher}
          fetchLabelForValue={recordLabel}
        />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Link
          </button>
        </div>
      </form>
    </SimpleModal>
  );
}