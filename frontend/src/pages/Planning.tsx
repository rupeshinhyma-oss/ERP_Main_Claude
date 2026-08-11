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
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { SearchableDropdown, type DropdownOption } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, API_BASE, toQueryString } from "@/lib/api";
import { Auth } from "@/lib/auth";
import { useAuth } from "@/lib/hooks";
import type { Role } from "@/types";
import type {
  MumColumnStatusHistoryEntry,
  PlanningAggregateFn,
  PlanningCell,
  PlanningCellStatusColor,
  PlanningChangeLogEntry,
  PlanningColumn,
  PlanningColumnDataType,
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

const CELL_MIN_WIDTH = 150;
const ITEM_COL_WIDTH = 240;

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
  return columnName.trim().toLowerCase() === "approval date";
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
function mumGroupNumber(columnName: string, label?: string): number | null {
  const str = (columnName || "").trim();
  if (label) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:${escapedLabel}|mum)\\s*(\\d+)`, "i");
    const match = str.match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      return Number.isNaN(num) ? null : num;
    }
  }
  const match = str.match(/(?:mum|[a-z0-9_-]+)\s*(\d+)/i);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  return Number.isNaN(num) ? null : num;
}

/**
 * Wrap a column name for safe use inside a FORMULA expression.
 *
 * Backend formulas (app.planning.formula) accept bare identifiers only
 * when the column name is already a valid one (e.g. "Mum40"); any column
 * name with spaces or special characters (e.g. "PKG QTY", "Mum 1") must
 * be wrapped in square brackets so the backend's expression rewriter can
 * find and safely mangle it. Wrapping is harmless even for names that
 * would already be valid bare identifiers, so this is always safe to use.
 */
function quoteColumnRef(columnName: string): string {
  return `[${columnName}]`;
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
 * Floating description popover — appears anchored below a cell when the
 * user clicks the ✎ description button. The textarea saves on blur or
 * Ctrl+Enter; Escape closes without saving.
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
  const rect = anchor.getBoundingClientRect();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function commit() {
    onSave(text);
    onClose();
  }

  // Position below the anchor, clamped to viewport width
  const left = Math.min(rect.left, window.innerWidth - 280);
  const top = rect.bottom + 6;

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={() => { onSave(text); onClose(); }} />
      <div
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 56,
          background: "#fff",
          border: "1px solid #CBD5E1",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
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
            if (e.key === "Escape") { onClose(); e.stopPropagation(); }
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) commit();
          }}
          placeholder="Add a note for this cell…"
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
        <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 4, textAlign: "right" }}>Ctrl+Enter to save</div>
      </div>
    </>
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
  onClose,
}: {
  anchor: HTMLElement;
  sheetId: string;
  rowId: string;
  visibleMumGroupNumbers?: Set<number>;
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

  const groupedEntries = useMemo(() => {
    if (!entries || entries.length === 0) return [];
    const latestByGroup = new Map<number, MumColumnStatusHistoryEntry>();
    const unGrouped: MumColumnStatusHistoryEntry[] = [];

    for (const entry of entries) {
      const groupNum = mumGroupNumber(entry.column_name);
      if (groupNum === null) {
        unGrouped.push(entry);
        continue;
      }
      if (visibleMumGroupNumbers && visibleMumGroupNumbers.size > 0 && !visibleMumGroupNumbers.has(groupNum)) {
        continue;
      }
      const existing = latestByGroup.get(groupNum);
      if (!existing || new Date(entry.changed_at).getTime() > new Date(existing.changed_at).getTime()) {
        latestByGroup.set(groupNum, entry);
      }
    }
    const grouped = [...latestByGroup.entries()].sort((a, b) => a[0] - b[0]).map(([groupNum, entry]) => ({ groupNum, entry }));
    const fallbackUnGrouped = unGrouped.map((entry, idx) => ({ groupNum: 9000 + idx, entry }));
    return [...grouped, ...fallbackUnGrouped];
  }, [entries, visibleMumGroupNumbers]);

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 199 }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top: Math.min(rect.bottom + 4, window.innerHeight - 300),
          left: Math.max(10, Math.min(rect.left, window.innerWidth - 320)),
          zIndex: 200,
          width: 300,
          maxHeight: 280,
          overflowY: "auto",
          background: "#fff",
          border: "1px solid #CBD5E1",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
          padding: 12,
          textAlign: "left",
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Mum Column Status History
        </div>
        {loading ? (
          <div className="muted" style={{ fontSize: 12 }}>Loading status history…</div>
        ) : !groupedEntries || groupedEntries.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>No status changes recorded on Mum columns yet.</div>
        ) : (
          groupedEntries.map(({ groupNum, entry: e }, i) => {
            const builtinEntry =
              e.new_status && e.new_status !== "custom"
                ? BUILTIN_STATUS_COLORS[e.new_status as Exclude<PlanningCellStatusColor, "custom">]
                : undefined;
            const swatch = builtinEntry?.hex ?? "#94A3B8";
            const label = e.new_status ? builtinEntry?.label || e.new_status : "Cleared";
            const d = new Date(e.changed_at);
            const day = String(d.getDate()).padStart(2, "0");
            const month = String(d.getMonth() + 1).padStart(2, "0");
            const year = d.getFullYear();
            const hours = String(d.getHours()).padStart(2, "0");
            const minutes = String(d.getMinutes()).padStart(2, "0");
            const formattedTime = isNaN(d.getTime()) ? e.changed_at : `${day}/${month}/${year} ${hours}:${minutes}`;
            return (
              <div
                key={groupNum}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 8,
                  padding: "6px 0",
                  borderBottom: i < groupedEntries.length - 1 ? "1px solid #F1F5F9" : "none",
                }}
              >
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: "50%",
                    background: swatch,
                    flexShrink: 0,
                    marginTop: 3,
                  }}
                />
                <div style={{ fontSize: 12, color: "#334155", flex: 1 }}>
                  <div>
                    <strong style={{ color: "#0F172A" }}>{e.column_name}</strong>:{" "}
                    <span style={{ fontWeight: 600, color: swatch !== "#94A3B8" ? swatch : "#475569" }}>
                      {label}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: "#64748B", marginTop: 2 }}>
                    {formattedTime} · <span style={{ color: "#334155", fontWeight: 500 }}>{e.changed_by_username}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function GridCell({
  value,
  displayValue,
  statusColor,
  customStatusTagId,
  customTags,
  canEdit,
  sourceType,
  enableStatusColor,
  showMumHistory,
  onSave,
  onOpenStatusPicker,
  onOpenMumHistory,
  onOpenLinkPicker,
  isFrozen,
  isLastFrozen,
  stickyLeft,
}: {
  value: string | null | undefined;
  displayValue: string | null | undefined;
  statusColor: PlanningCellStatusColor | null | undefined;
  customStatusTagId: string | null | undefined;
  customTags: PlanningStatusTag[];
  canEdit: boolean;
  sourceType: PlanningColumnSourceType;
  enableStatusColor?: boolean;
  /** True only for the Approval Date column -- adds the Mum-status-history eye button. */
  showMumHistory?: boolean;
  onSave: (newValue: string) => void;
  onOpenStatusPicker: (anchor: HTMLElement) => void;
  onOpenMumHistory?: (anchor: HTMLElement) => void;
  onOpenLinkPicker: () => void;
  isFrozen?: boolean;
  isLastFrozen?: boolean;
  stickyLeft?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const swatch = statusSwatchColor(statusColor, customStatusTagId, customTags);
  const isManual = sourceType === "manual";
  const rawShownValue = isManual ? (value ?? displayValue) : (displayValue ?? value);
  const shownValue = showMumHistory ? formatDaysMonthYear(rawShownValue) : rawShownValue;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== (value ?? "")) onSave(draft);
  }

  const bg = isFrozen ? (!isManual ? "#F8FAFC" : "#fff") : !isManual ? "#F8FAFC" : "#fff";

  return (
    <td
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: isFrozen ? "sticky" : "relative",
        left: isFrozen ? stickyLeft : undefined,
        zIndex: isFrozen ? 3 : undefined,
        minWidth: CELL_MIN_WIDTH,
        width: CELL_MIN_WIDTH,
        maxWidth: CELL_MIN_WIDTH,
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
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 32, padding: "4px 6px" }}>
        {editing && isManual ? (
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
              color: swatch || undefined,
              fontWeight: swatch ? 600 : undefined,
            }}
          />
        ) : (
          <span
            onClick={() => canEdit && isManual && setEditing(true)}
            title={
              !isManual
                ? `Computed (${sourceType}) — not directly editable`
                : statusColor
                  ? statusLabel(statusColor, customStatusTagId, customTags)
                  : undefined
            }
            style={{
              width: "100%",
              cursor: canEdit && isManual ? "text" : "default",
              fontSize: 13,
              minHeight: 18,
              display: "block",
              textAlign: "center",
              fontStyle: !isManual ? "italic" : undefined,
              color: swatch || (!isManual ? "#475569" : undefined),
              fontWeight: swatch ? 600 : undefined,
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
          {canEdit && !editing && enableStatusColor && (hovered || swatch) && (
            <button
              type="button"
              className="planning-status-dot"
              onClick={(e) => onOpenStatusPicker(e.currentTarget)}
              title={statusLabel(statusColor, customStatusTagId, customTags)}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                border: swatch ? "none" : "1px dashed #CBD5E1",
                background: swatch || "transparent",
                flexShrink: 0,
                cursor: "pointer",
                opacity: swatch ? 1 : 0.4,
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
}: {
  anchor: HTMLElement;
  customTags: PlanningStatusTag[];
  onPick: (color: PlanningCellStatusColor | null, customTagId: string | null) => void;
  onClose: () => void;
}) {
  const rect = anchor.getBoundingClientRect();
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 50 }} onClick={onClose} />
      <div
        style={{
          position: "fixed",
          top: rect.bottom + 6,
          left: Math.min(rect.left, window.innerWidth - 220),
          zIndex: 51,
          background: "#fff",
          border: "1px solid #E2E8F0",
          borderRadius: 8,
          boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
          padding: 8,
          width: 210,
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, color: "#64748B", padding: "2px 6px 6px" }}>SET STATUS</div>
        {(Object.entries(BUILTIN_STATUS_COLORS) as [PlanningCellStatusColor, { label: string; hex: string }][]).map(
          ([key, { label, hex }]) => (
            <button
              key={key}
              type="button"
              onClick={() => onPick(key, null)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                padding: "6px 8px",
                border: "none",
                background: "transparent",
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 13,
                textAlign: "left",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#F1F5F9")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: hex, flexShrink: 0 }} />
              {label}
            </button>
          )
        )}
        {customTags.length > 0 && <div style={{ borderTop: "1px solid #EEF2F6", margin: "6px 0" }} />}
        {customTags.map((tag) => (
          <button
            key={tag.id}
            type="button"
            onClick={() => onPick("custom", tag.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              padding: "6px 8px",
              border: "none",
              background: "transparent",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              textAlign: "left",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#F1F5F9")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: tag.hex_color, flexShrink: 0 }} />
            {tag.label}
          </button>
        ))}
        <div style={{ borderTop: "1px solid #EEF2F6", margin: "6px 0" }} />
        <button
          type="button"
          onClick={() => onPick(null, null)}
          style={{
            width: "100%",
            padding: "6px 8px",
            border: "none",
            background: "transparent",
            borderRadius: 6,
            cursor: "pointer",
            fontSize: 13,
            color: "#94A3B8",
            textAlign: "left",
          }}
        >
          Clear status
        </button>
      </div>
    </>
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
  const canManageColumns = hasPermission("planning.column.manage");
  const canEditCells = hasPermission("planning.cell.edit");

  const [sheets, setSheets] = useState<PlanningSheet[]>([]);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [grid, setGrid] = useState<PlanningGrid | null>(null);
  const [itemHeaderTitle, setItemHeaderTitle] = useState("ITEM");
  const [customTags, setCustomTags] = useState<PlanningStatusTag[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const [addSheetOpen, setAddSheetOpen] = useState(false);
  const [newSheetName, setNewSheetName] = useState("");

  const [duplicateSheetSource, setDuplicateSheetSource] = useState<PlanningSheet | null>(null);
  const [duplicateSheetName, setDuplicateSheetName] = useState("");
  const [duplicateSheetLabel, setDuplicateSheetLabel] = useState("");
  const [duplicatingSheet, setDuplicatingSheet] = useState(false);

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

  const loadSheets = useCallback(async () => {
    try {
      const { data } = await apiGet<PlanningSheet[]>("/planning/sheets");
      setSheets(data);
      if (data.length > 0 && !activeSheetId) setActiveSheetId(data[0].id);
    } catch (err) {
      setError(err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadGrid = useCallback(async (sheetId: string) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await apiGet<PlanningGrid>(`/planning/sheets/${sheetId}/grid`);
      setGrid(data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

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
          case "column_description_changed": {
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
            return { ...prev, rows: [...prev.rows, { ...payload, cells: payload.cells ?? [] }] };
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
            return { ...prev, rows: prev.rows.filter((r) => r.id !== payload.row_id) };
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
      socket?.close();
    };
  }, [activeSheetId, applyLiveEvent]);

  useEffect(() => {
    void loadSheets();
    void loadCustomTags();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeSheetId) void loadGrid(activeSheetId);
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

  function isApprovalDateColumn(colName: string): boolean {
    const name = colName.trim().toLowerCase();
    return name === "approval date" || name === "approval_date";
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
    // 3. Before Supplier standard columns
    // 4. Group columns in ascending numeric order (Mum 1, Mum1 Remarks, Mum 2, Mum2 Remarks...)
    // 5. Compulsory 3 summary totals (NO. OF PKG, TOTAL WEIGHT, TOTAL CBM) immediately after group columns
    // 6. Supplier through CBM/PKG columns and remaining columns
    return [
      ...testCols,
      ...approvalCols,
      ...beforeSupplier,
      ...mumMain,
      ...mumTotals,
      ...supplierToCbm,
      ...afterCbm,
    ];
  }

  // Hidden columns are simply excluded. Frozen (pinned) columns are moved to
  // the front, in their original relative order, so they sit right after the
  // always-frozen ITEM column and stay stuck there while the rest scrolls --
  // same visual result as Excel's freeze panes, without requiring the
  // frozen set to be a contiguous run of leading columns.
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenColumnIds.has(c.id)),
    [columns, hiddenColumnIds]
  );
  // Which Mum group numbers are currently visible (not hidden) -- the
  // Approval Date eye popover uses this to exclude hidden Mum groups from
  // its history list, matching the fact that the group's own columns are
  // hidden from the grid too.
  const visibleMumGroupNumbers = useMemo(() => {
    const nums = new Set<number>();
    for (const c of visibleColumns) {
      const groupNum = mumGroupNumber(c.name);
      if (groupNum !== null) nums.add(groupNum);
    }
    return nums;
  }, [visibleColumns]);
  const orderedColumns = useMemo(() => {
    const frozen = visibleColumns.filter((c) => frozenColumnIds.has(c.id));
    const rest = visibleColumns.filter((c) => !frozenColumnIds.has(c.id));
    return [...frozen, ...organizeNonFrozenColumns(rest)];
  }, [visibleColumns, frozenColumnIds]);
  const stickyLeftByColumnId = useMemo(() => {
    const map = new Map<string, number>();
    let left = ITEM_COL_WIDTH;
    for (const col of orderedColumns) {
      if (!frozenColumnIds.has(col.id)) break; // frozen columns are always sorted to the front
      map.set(col.id, left);
      left += CELL_MIN_WIDTH;
    }
    return map;
  }, [orderedColumns, frozenColumnIds]);
  const lastFrozenColumnId = useMemo(() => {
    const frozenInOrder = orderedColumns.filter((c) => frozenColumnIds.has(c.id));
    return frozenInOrder.length > 0 ? frozenInOrder[frozenInOrder.length - 1].id : null;
  }, [orderedColumns, frozenColumnIds]);

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
      if (approvalDateColumnId && row.mum_approval_dates) {
        const existingCell = map.get(`${row.id}:${approvalDateColumnId}`);
        const isAutoFilled = existingCell?.is_auto_approval_date ?? (!existingCell && Object.keys(row.mum_approval_dates).length > 0);
        if (isAutoFilled) {
          const visibleGroupNums = Object.keys(row.mum_approval_dates)
            .map((k) => parseInt(k, 10))
            .filter((n) => !Number.isNaN(n) && visibleMumGroupNumbers.has(n))
            .sort((a, b) => a - b);
          const firstVisibleDate = visibleGroupNums.length > 0 ? row.mum_approval_dates[String(visibleGroupNums[0])] : null;
          if (existingCell) {
            map.set(`${row.id}:${approvalDateColumnId}`, {
              ...existingCell,
              value: firstVisibleDate ?? null,
              display_value: firstVisibleDate ?? null,
            });
          } else if (firstVisibleDate) {
            map.set(`${row.id}:${approvalDateColumnId}`, {
              id: null,
              row_id: row.id,
              column_id: approvalDateColumnId,
              value: firstVisibleDate,
              display_value: firstVisibleDate,
              status_color: null,
              custom_status_tag_id: null,
              is_auto_approval_date: true,
            });
          }
        }
      }
    }
    return map;
  }, [rows, approvalDateColumnId, visibleMumGroupNumbers]);

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
    if (!newSheetName.trim()) return;
    try {
      const { data } = await apiPost<PlanningSheet>("/planning/sheets", { name: newSheetName.trim() });
      setNewSheetName("");
      setAddSheetOpen(false);
      await loadSheets();
      setActiveSheetId(data.id);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeleteSheet(sheetId: string, sheetName: string) {
    if (!window.confirm(`Are you sure you want to delete sheet '${sheetName}'? This will remove the sheet and all its columns and rows.`)) return;
    try {
      await apiDelete(`/planning/sheets/${sheetId}`);
      await loadSheets();
      if (activeSheetId === sheetId) {
        const remaining = sheets.filter((s) => s.id !== sheetId);
        setActiveSheetId(remaining.length > 0 ? remaining[0].id : null);
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
    } catch (err) {
      setError(err);
    }
  }

  function handleOpenDuplicateSheet(sheet: PlanningSheet) {
    setDuplicateSheetSource(sheet);
    setDuplicateSheetName(`${sheet.name} copy`);
    setDuplicateSheetLabel(sheet.mum_group_label || "Mum");
  }

  async function handleDuplicateSheet(e: React.FormEvent) {
    e.preventDefault();
    if (!duplicateSheetSource || !duplicateSheetName.trim() || !duplicateSheetLabel.trim()) return;
    setDuplicatingSheet(true);
    try {
      const { data } = await apiPost<PlanningSheet>(`/planning/sheets/${duplicateSheetSource.id}/duplicate`, {
        name: duplicateSheetName.trim(),
        mum_group_label: duplicateSheetLabel.trim(),
      });
      setDuplicateSheetSource(null);
      setDuplicateSheetName("");
      setDuplicateSheetLabel("");
      await loadSheets();
      setActiveSheetId(data.id);
    } catch (err) {
      setError(err);
    } finally {
      setDuplicatingSheet(false);
    }
  }

  const [creatingNextMum, setCreatingNextMum] = useState(false);

  async function handleCreateNextMumGroup() {
    if (!activeSheetId) return;
    setCreatingNextMum(true);
    setError(null);
    try {
      const mumLabel = grid?.sheet?.mum_group_label || "Mum";
      let maxMum = 0;
      for (const col of columns) {
        const num = mumGroupNumber(col.name, mumLabel);
        if (num !== null && num > maxMum) maxMum = num;
      }
      const nextMumNum = maxMum > 0 ? maxMum + 1 : 1;

      // PKG QTY / UNIT WEIGHT/PKG (KG) / CBM/PKG (KG) / Supplier Name / City
      // are always extracted from Product Master, never typed in -- find
      // each by its LINKED_LOOKUP source_field (product master's
      // packaging_quantity / packaging_gross_weight / packaging_unit_cbm /
      // supplier_name / supplier_city), creating it as a LINKED_LOOKUP
      // column the first time this sheet needs it. Every item's exact
      // supplier/city/packaging numbers come from that exact item's own
      // Product Master record -- editing Product Master updates these
      // columns immediately, with nothing to type or keep in sync by hand.
      async function findOrCreateProductLookupColumn(
        label: string,
        sourceField: string,
        dataType: PlanningColumnDataType,
        position: number | null
      ): Promise<PlanningColumn> {
        const existing = columns.find(
          (c) => c.source_type === "linked_lookup" && c.source_module === "product" && c.source_field === sourceField
        );
        if (existing) return existing;

        const { data: created } = await apiPost<PlanningColumn>(`/planning/sheets/${activeSheetId}/columns`, {
          name: label,
          data_type: dataType,
          position,
        });
        await apiPut(`/planning/sheets/${activeSheetId}/columns/${created.id}/source`, {
          source_type: "linked_lookup",
          source_module: "product",
          source_field: sourceField,
          enable_description: false,
          auto_populate_enabled: true, // bulk-link every row to its ITEM's Product Master record immediately
          auto_populate_limit: null,
        });
        try {
          await apiPost(`/planning/sheets/${activeSheetId}/columns/${created.id}/auto-link`);
        } catch {
          // Non-fatal: existing rows just stay unlinked for this column until
          // the admin reruns "Load all records automatically" from its config modal.
        }
        columns.push({ ...created, source_type: "linked_lookup", source_module: "product", source_field: sourceField });
        return created;
      }

      const supplierCol = columns.find((c) => /supplier/i.test(c.name));
      const supplierNameCol = await findOrCreateProductLookupColumn(
        "Supplier Name",
        "supplier_name",
        "text",
        supplierCol ? supplierCol.position : 0
      );
      const cityCol = await findOrCreateProductLookupColumn(
        "City",
        "supplier_city",
        "text",
        supplierNameCol.position + 1
      );
      const pkgQtyCol = await findOrCreateProductLookupColumn("PKG QTY", "packaging_quantity", "number", null);
      const unitWeightCol = await findOrCreateProductLookupColumn(
        "UNIT WEIGHT/PKG (KG)",
        "packaging_gross_weight",
        "number",
        null
      );
      const cbmPerPkgCol = await findOrCreateProductLookupColumn("CBM/PKG (KG)", "packaging_unit_cbm", "number", null);

      const mumMainPos = cityCol.position + 1;
      const cbmHeaderCol = columns.find((c) => /cbm\s*[\/\.]?\s*pkg/i.test(c.name));
      const mumTotalsPos = cbmHeaderCol ? cbmHeaderCol.position + 1 : null;

      const mumColName = `${mumLabel} ${nextMumNum}`;
      const companions: { name: string; data_type: PlanningColumnDataType; pos: number | null }[] = [
        { name: mumColName, data_type: "number", pos: mumMainPos },
        { name: `${mumLabel}${nextMumNum} Remarks`, data_type: "text", pos: mumMainPos !== null ? mumMainPos + 1 : null },
        { name: `NO. OF PKG ${mumLabel.toUpperCase()}${nextMumNum}`, data_type: "number", pos: mumTotalsPos },
        { name: `TOTAL WEIGHT ${mumLabel.toUpperCase()}${nextMumNum}`, data_type: "number", pos: mumTotalsPos !== null ? mumTotalsPos + 1 : null },
        { name: `TOTAL CBM ${mumLabel.toUpperCase()}${nextMumNum}`, data_type: "number", pos: mumTotalsPos !== null ? mumTotalsPos + 2 : null },
      ];

      const created: PlanningColumn[] = [];
      for (const companion of companions) {
        const { data } = await apiPost<PlanningColumn>(`/planning/sheets/${activeSheetId}/columns`, {
          name: companion.name,
          data_type: companion.data_type,
          position: companion.pos,
        });
        if (data) created.push(data);
      }

      // NO. OF PKG / TOTAL WEIGHT / TOTAL CBM MUM<n> always use one fixed
      // backend formula (Mum<n> / PKG QTY, then x UNIT WEIGHT/PKG or x
      // CBM/PKG) -- the backend recognizes these three names and computes
      // them itself; the formula_expression sent here is just a
      // human-readable label, not something the backend actually evaluates
      // for these columns (see app.planning.service.is_fixed_mum_derived_column).
      const pkgCol = created.find((c) => c.name === `NO. OF PKG MUM${nextMumNum}`);
      const weightCol = created.find((c) => c.name === `TOTAL WEIGHT MUM${nextMumNum}`);
      const cbmCol = created.find((c) => c.name === `TOTAL CBM MUM${nextMumNum}`);

      async function wireFixedFormula(col: PlanningColumn | undefined, label: string) {
        if (!col || !activeSheetId) return;
        try {
          await apiPut(`/planning/sheets/${activeSheetId}/columns/${col.id}/source`, {
            source_type: "formula",
            formula_expression: label,
            enable_description: false,
            auto_populate_enabled: false,
            auto_populate_limit: null,
          });
        } catch {
          // Non-fatal: the column just stays a plain manual number column if the formula couldn't be saved.
        }
      }

      await wireFixedFormula(pkgCol, `${quoteColumnRef(mumColName)} / ${quoteColumnRef(pkgQtyCol.name)}`);
      await wireFixedFormula(weightCol, `NO. OF PKG MUM${nextMumNum} * ${quoteColumnRef(unitWeightCol.name)}`);
      await wireFixedFormula(cbmCol, `NO. OF PKG MUM${nextMumNum} * ${quoteColumnRef(cbmPerPkgCol.name)}`);

      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    } finally {
      setCreatingNextMum(false);
    }
  }

  const [loadingMoreProducts, setLoadingMoreProducts] = useState(false);

  /**
   * "Load more products" -- the ONLY way left to pull additional Product
   * Master rows into the sheet now that the manual per-row 🔗 link icon
   * and the ITEM header's Configure (⚙) modal have both been removed
   * (ITEM is permanently Product Master -> Product Name; see
   * PlanningService.create_sheet). Mirrors Product Master's own default
   * page size of 50 (see MasterPage's pageSize=50): each click asks for
   * 50 more than currently loaded, and the backend's own de-dupe (by
   * linked_record_id) means re-fetching from the top and skipping
   * already-linked products is safe and never creates duplicate rows.
   */
  async function handleLoadMoreProducts() {
    if (!activeSheetId) return;
    setLoadingMoreProducts(true);
    setError(null);
    try {
      const nextLimit = rows.length + 50;
      await apiPost(`/planning/sheets/${activeSheetId}/item-source/auto-populate`, { limit: nextLimit });
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    } finally {
      setLoadingMoreProducts(false);
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

  async function handleDeleteRow(rowId: string) {
    if (!activeSheetId) return;
    if (!window.confirm("Delete this row?")) return;
    try {
      await apiDelete(`/planning/sheets/${activeSheetId}/rows/${rowId}`);
      setGrid((prev) => (prev ? { ...prev, rows: prev.rows.filter((r) => r.id !== rowId) } : prev));
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

  async function handleSaveCellValue(rowId: string, columnId: string, value: string) {
    if (!activeSheetId) return;
    try {
      const { data } = await apiPut<{ cell: PlanningCell; derived_values: Record<string, string | null | Record<string, string>> }>(
        `/planning/sheets/${activeSheetId}/rows/${rowId}/columns/${columnId}/value`,
        { value }
      );
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
              value,
              display_value: value,
              status_color: null,
              custom_status_tag_id: null,
            };
            let updatedCells = exists
              ? r.cells.map((cell) => (cell.column_id === columnId ? { ...cell, ...patched } : cell))
              : [...r.cells, patched];
            // Also patch every derived column (formula totals, and the
            // Approval Date auto-date) for THIS SAME tab -- the acting
            // user doesn't receive their own WebSocket broadcast (see
            // ws_manager's exclude_user_id), so without this the person
            // who actually typed the value would be the one person who
            // has to refresh to see their own Approval Date / totals update.
            updatedCells = updatedCells.map((c) => {
              if (!Object.prototype.hasOwnProperty.call(derived, c.column_id)) return c;
              const nextDisplayValue = derived[c.column_id];
              if (c.column_id === approvalDateColumnId && (c.is_auto_approval_date || !c.value)) {
                return { ...c, display_value: nextDisplayValue, value: nextDisplayValue, is_auto_approval_date: true };
              }
              return { ...c, display_value: nextDisplayValue };
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
    } catch (err) {
      setError(err);
    }
  }

  async function handleSetCellStatus(
    rowId: string,
    columnId: string,
    statusColor: PlanningCellStatusColor | null,
    customTagId: string | null
  ) {
    if (!activeSheetId) return;
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
        <Breadcrumb trail={["Shipment Planning"]} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0 }}>Shipment Planning</h1>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={handleOpenHistory} disabled={!activeSheetId}>
              History
            </button>
            <Can permission="planning.sheet.manage">
              <button type="button" className="btn btn-secondary" onClick={() => setAddSheetOpen(true)}>
                + Sheet
              </button>
            </Can>
          </div>
        </div>

        <Banner error={error} />

        {/* Sheet tabs -- one per branch (Mum Branch, MP Branch, GJ Branch, ...), unlimited. */}
        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E2E8F0", marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
          {sheets.map((sheet) => (
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
              onClick={() => setActiveSheetId(sheet.id)}
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
                    handleOpenDuplicateSheet(sheet);
                  }}
                  title="Duplicate sheet as a new branch (same columns, choose a new group label)"
                  style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94A3B8", fontSize: 12, padding: "0 2px" }}
                >
                  ⧉
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
          {sheets.length === 0 && !loading && (
            <div className="muted" style={{ padding: "8px 4px" }}>No sheets yet. Add one to get started.</div>
          )}
        </div>

        {activeSheetId && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <button type="button" className="btn btn-secondary" onClick={() => setColumnsPanelOpen(true)} disabled={columns.length === 0}>
                Configuration{hiddenColumnIds.size > 0 ? ` (${hiddenColumnIds.size} hidden)` : ""}
              </button>
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
              <Can permission="planning.row.manage">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleLoadMoreProducts}
                  disabled={loadingMoreProducts || !activeSheetId}
                  title="Pull the next 50 products from Product Master as new rows (already-loaded products are skipped)"
                >
                  {loadingMoreProducts ? "Loading…" : "Load More Products"}
                </button>
              </Can>
            </div>

            <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
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
                    />
                    {orderedColumns.map((col) => (
                      <ColumnHeader
                        key={col.id}
                        column={col}
                        canManage={canManageColumns}
                        onRename={(name) => handleRenameColumn(col.id, name)}
                        onDelete={() => handleDeleteColumn(col.id)}
                        onSaveDescription={(text) => handleSaveColumnDescription(col.id, text)}
                        isFrozen={frozenColumnIds.has(col.id)}
                        isLastFrozen={col.id === lastFrozenColumnId}
                        stickyLeft={stickyLeftByColumnId.get(col.id)}
                      />
                    ))}
                    <th style={{ width: 40, borderBottom: "1px solid #E2E8F0" }} />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <TableMessageRow colSpan={orderedColumns.length + 2}>Loading grid…</TableMessageRow>
                  ) : rows.length === 0 ? (
                    <TableMessageRow colSpan={orderedColumns.length + 2}>No rows yet. Add one to get started.</TableMessageRow>
                  ) : (
                    rows.map((row) => (
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
                          return (
                            <GridCell
                              key={col.id}
                              value={cell?.value}
                              displayValue={cell?.display_value}
                              statusColor={cell?.status_color}
                              customStatusTagId={cell?.custom_status_tag_id}
                              customTags={customTags}
                              canEdit={canEditCells}
                              sourceType={col.source_type}
                              enableStatusColor={col.enable_status_color}
                              showMumHistory={isApprovalDateColumn(col.name)}
                              onSave={(value) => handleSaveCellValue(row.id, col.id, value)}
                              onOpenStatusPicker={(anchor) => setStatusPicker({ anchor, rowId: row.id, columnId: col.id })}
                              onOpenMumHistory={(anchor) => setMumHistoryPopover({ anchor, rowId: row.id })}
                              onOpenLinkPicker={() => setLinkPicker({ rowId: row.id, column: col })}
                              isFrozen={frozenColumnIds.has(col.id)}
                              isLastFrozen={col.id === lastFrozenColumnId}
                              stickyLeft={stickyLeftByColumnId.get(col.id)}
                            />
                          );
                        })}
                        <td style={{ borderBottom: "1px solid #F1F5F9", textAlign: "center" }}>
                          <Can permission="planning.row.manage">
                            <button
                              type="button"
                              onClick={() => handleDeleteRow(row.id)}
                              title="Delete row"
                              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94A3B8" }}
                            >
                              ×
                            </button>
                          </Can>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* Columns panel: show/hide + freeze/unfreeze + color-status opt-in, all in one place (needed for hidden columns, since they have no visible header to un-hide from). */}
        {columnsPanelOpen && (
          <SimpleModal title="Configuration" onClose={() => setColumnsPanelOpen(false)}>
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
              {columns.map((col) => (
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
              {columns.length === 0 && <div className="muted" style={{ padding: "10px 4px" }}>No columns yet.</div>}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  if (!activeSheetId) return;
                  setHiddenColumnIds(new Set());
                  const defaultFrozenIds = columns
                    .filter((c) => isTestColumn(c.name) || isApprovalDateColumn(c.name))
                    .map((c) => c.id);
                  setFrozenColumnIds(new Set(defaultFrozenIds));
                  localStorage.removeItem(hiddenColumnsStorageKey(activeSheetId));
                  localStorage.setItem(frozenColumnsStorageKey(activeSheetId), JSON.stringify(defaultFrozenIds));
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
              <TextField
                id="new_sheet_name"
                label="Sheet Name *"
                required
                placeholder="e.g. Mum Branch"
                value={newSheetName}
                onChange={setNewSheetName}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setAddSheetOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Create Sheet
                </button>
              </div>
            </form>
          </SimpleModal>
        )}

        {duplicateSheetSource && (
          <SimpleModal
            title={`Duplicate '${duplicateSheetSource.name}'`}
            onClose={() => setDuplicateSheetSource(null)}
          >
            <form onSubmit={handleDuplicateSheet}>
              <p className="muted" style={{ marginTop: 0, marginBottom: 16, fontSize: 13 }}>
                Creates a new sheet with the exact same columns as{" "}
                <strong>{duplicateSheetSource.name}</strong> -- Supplier Name, City, PKG QTY,
                UNIT WEIGHT/PKG (KG), CBM/PKG (KG), every group and its NO. OF PKG / TOTAL WEIGHT
                / TOTAL CBM totals, all with the same formulas and Product Master links. The only
                thing you choose below is the new sheet's name and its group label -- e.g. "Chen"
                instead of "{duplicateSheetSource.mum_group_label || "Mum"}", so the new sheet's
                groups read "Chen 1", "Chen2 Remarks", "NO. OF PKG CHEN1" instead of "
                {duplicateSheetSource.mum_group_label || "Mum"} 1", etc. Rows aren't copied -- the
                new sheet starts empty, same as creating any other sheet.
              </p>
              <TextField
                id="duplicate_sheet_name"
                label="New Sheet Name *"
                required
                placeholder="e.g. Chennai branch"
                value={duplicateSheetName}
                onChange={setDuplicateSheetName}
              />
              <TextField
                id="duplicate_sheet_label"
                label="Group Label *"
                required
                placeholder="e.g. Chen, MP, GJ"
                hint={`The word used in place of "Mum" for this sheet's groups (e.g. "Chen 1", "NO. OF PKG CHEN1"). Leave as-is to keep the same label as the source sheet.`}
                value={duplicateSheetLabel}
                onChange={setDuplicateSheetLabel}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setDuplicateSheetSource(null)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={duplicatingSheet}>
                  {duplicatingSheet ? "Duplicating..." : "Duplicate Sheet"}
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
          />
        )}

        {mumHistoryPopover && activeSheetId && (
          <MumStatusHistoryPopover
            anchor={mumHistoryPopover.anchor}
            sheetId={activeSheetId}
            rowId={mumHistoryPopover.rowId}
            visibleMumGroupNumbers={visibleMumGroupNumbers}
            onClose={() => setMumHistoryPopover(null)}
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
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onSaveDescription: (text: string | null) => void;
  isFrozen: boolean;
  isLastFrozen: boolean;
  stickyLeft: number | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [hovered, setHovered] = useState(false);
  const [descAnchor, setDescAnchor] = useState<HTMLElement | null>(null);
  const hasDescription = !!column.description;

  function commit() {
    setEditing(false);
    if (draft.trim() && draft.trim() !== column.name) onRename(draft.trim());
    else setDraft(column.name);
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "8px 10px",
        textAlign: "center",
        minWidth: CELL_MIN_WIDTH,
        width: CELL_MIN_WIDTH,
        maxWidth: CELL_MIN_WIDTH,
        boxSizing: "border-box",
        borderBottom: "1px solid #E2E8F0",
        borderRight: isFrozen && isLastFrozen ? "2px solid #CBD5E1" : "1px solid #E2E8F0",
        position: isFrozen ? "sticky" : "relative",
        left: isFrozen ? stickyLeft : undefined,
        zIndex: isFrozen ? 9 : 2,
        background: "#F8FAFC",
        boxShadow: isFrozen && isLastFrozen ? "3px 0 6px -2px rgba(0,0,0,0.15)" : undefined,
      }}
    >
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 24 }}>
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
          <span
            onClick={() => canManage && setEditing(true)}
            style={{
              cursor: canManage ? "text" : "default",
              fontWeight: 600,
              color: "#334155",
              textAlign: "center",
              padding: "0 4px",
              whiteSpace: "normal",
              wordBreak: "break-word",
              lineHeight: "1.2",
              display: "block",
              width: "100%",
            }}
            title={column.name}
          >
            {column.name}
          </span>
        )}
        {sourceBadge && !editing && (
          <span
            title={sourceBadge.title}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#7C3AED",
              background: "#EDE9FE",
              borderRadius: 4,
              padding: "1px 4px",
              marginLeft: 2,
            }}
          >
            {sourceBadge.label}
          </span>
        )}
        {isPureMumColumn(column.name) && column.enable_description && hasDescription && !editing && !hovered && (
          <span
            title={`Description: ${column.description}`}
            style={{ color: "#2563EB", fontSize: 11, marginLeft: 2, flexShrink: 0 }}
          >
            ✎
          </span>
        )}
        {canManage && !editing && hovered && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 2,
              background: "#F8FAFC",
              paddingLeft: 4,
              zIndex: 3,
            }}
          >
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
                }}
              >
                ✎
              </button>
            )}
            {!isSystemColumn(column.name) && (
              <button
                type="button"
                onClick={onDelete}
                title="Delete column"
                style={{ border: "none", background: "transparent", cursor: "pointer", color: "#EF4444", fontSize: 13, padding: "1px 3px" }}
              >
                ×
              </button>
            )}
          </div>
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
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (newTitle: string) => void;
  onSaveDescription: (text: string | null) => void;
  itemDescription?: string | null;
  isLastFrozen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [hovered, setHovered] = useState(false);
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        padding: "8px 10px",
        textAlign: "left",
        minWidth: ITEM_COL_WIDTH,
        width: ITEM_COL_WIDTH,
        maxWidth: ITEM_COL_WIDTH,
        boxSizing: "border-box",
        borderBottom: "1px solid #E2E8F0",
        borderRight: isLastFrozen ? "2px solid #CBD5E1" : "1px solid #E2E8F0",
        position: "sticky",
        left: 0,
        zIndex: 10,
        background: "#F8FAFC",
        boxShadow: isLastFrozen ? "3px 0 6px -2px rgba(0,0,0,0.15)" : undefined,
      }}
    >
      <div style={{ position: "relative", display: "flex", alignItems: "center", minHeight: 24 }}>
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
          <span
            onClick={() => canManage && setEditing(true)}
            title={canManage ? "Click to rename header" : undefined}
            style={{ cursor: canManage ? "pointer" : "default", fontWeight: 600, color: "#334155" }}
          >
            {column.name}
          </span>
        )}
        {sourceBadge && !editing && (
          <span
            title={sourceBadge.title}
            style={{
              fontSize: 10,
              fontWeight: 700,
              color: "#7C3AED",
              background: "#EDE9FE",
              borderRadius: 4,
              padding: "1px 4px",
              marginLeft: 4,
            }}
          >
            {sourceBadge.label}
          </span>
        )}
        {column.enable_description && hasDescription && !editing && !hovered && (
          <span
            title={`Description: ${itemDescription}`}
            style={{ color: "#2563EB", fontSize: 11, marginLeft: 4, flexShrink: 0 }}
          >
            ✎
          </span>
        )}
        {canManage && !editing && hovered && (
          <div
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: 2,
              background: "#F8FAFC",
              paddingLeft: 4,
            }}
          >
            <button
              type="button"
              onClick={(e) => setDescAnchor(descAnchor ? null : e.currentTarget)}
              title={
                !column.enable_description
                  ? "Enable Description in Columns panel to add a note"
                  : hasDescription
                    ? `Description: ${itemDescription}`
                    : "Add a note about this column"
              }
              disabled={!column.enable_description}
              style={{
                border: "none",
                background: "transparent",
                cursor: column.enable_description ? "pointer" : "not-allowed",
                fontSize: 12,
                padding: "1px 3px",
                color: !column.enable_description ? "#CBD5E1" : hasDescription ? "#2563EB" : "#94A3B8",
              }}
            >
              ✎
            </button>
          </div>
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
        padding: "6px 10px",
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
      }}
    >
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
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
            style={{ width: "100%", border: "1px solid #2563EB", borderRadius: 4, padding: "3px 6px", fontSize: 13, fontWeight: 500 }}
          />
        ) : (
          <span
            onClick={() => canEdit && isManual && setEditing(true)}
            title={
              !isManual
                ? `Auto-filled from Product Master (${sourceType})`
                : canEdit
                  ? "Click to edit Item label"
                  : undefined
            }
            style={{
              flex: 1,
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
            Leave empty to allow anyone with the sheet's column-manage permission. Selecting roles restricts this
            column to only those roles, on top of that permission.
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
            {roles.map((role) => (
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
                {role.name}
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