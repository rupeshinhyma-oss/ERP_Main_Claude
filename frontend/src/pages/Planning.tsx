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
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, toQueryString } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import type { Role } from "@/types";
import type {
  MumColumnStatusHistoryEntry,
  PlanningAggregateFn,
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

/** One editable cell: click to edit the value, hover to reveal the status swatch + optional description button. */
/**
 * Eye/history button for the Approval Date cell: fetches the row's
 * Mum-series status-color history lazily (only once, on first hover) and
 * shows it in a small popover -- "when Mum45 was blue, when it changed to
 * green, when Mum46 was blue", etc., in chronological order.
 */
function MumStatusHistoryButton({ sheetId, rowId }: { sheetId: string; rowId: string }) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MumColumnStatusHistoryEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);

  async function handleOpen() {
    setOpen(true);
    if (entries !== null) return; // already fetched once; hovering again just re-shows it
    setLoading(true);
    try {
      const { data } = await apiGet<MumColumnStatusHistoryEntry[]>(
        `/planning/sheets/${sheetId}/rows/${rowId}/mum-status-history`
      );
      setEntries(data);
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }

  const rect = anchorRef.current?.getBoundingClientRect();

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onMouseEnter={handleOpen}
        onClick={handleOpen}
        onMouseLeave={() => setOpen(false)}
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
      {open && rect && (
        <div
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          style={{
            position: "fixed",
            top: rect.bottom + 4,
            left: Math.min(rect.left, window.innerWidth - 300),
            zIndex: 60,
            width: 280,
            maxHeight: 260,
            overflowY: "auto",
            background: "#fff",
            border: "1px solid #E2E8F0",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
            padding: 10,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, color: "#64748B", marginBottom: 6, textTransform: "uppercase" }}>
            Mum Column Status History
          </div>
          {loading ? (
            <div className="muted" style={{ fontSize: 12 }}>Loading…</div>
          ) : !entries || entries.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>No status changes on Mum columns yet.</div>
          ) : (
            entries.map((e, i) => {
              const builtinEntry =
                e.new_status && e.new_status !== "custom"
                  ? BUILTIN_STATUS_COLORS[e.new_status as Exclude<PlanningCellStatusColor, "custom">]
                  : undefined;
              const swatch = builtinEntry?.hex ?? null;
              const label = e.new_status ? builtinEntry?.label || e.new_status : "cleared";
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 6,
                    padding: "5px 0",
                    borderBottom: i < entries.length - 1 ? "1px solid #F1F5F9" : "none",
                  }}
                >
                  <span
                    style={{
                      width: 9,
                      height: 9,
                      borderRadius: "50%",
                      background: swatch || "#CBD5E1",
                      flexShrink: 0,
                      marginTop: 3,
                    }}
                  />
                  <div style={{ fontSize: 12, color: "#334155" }}>
                    <strong>{e.column_name}</strong> turned <strong>{label}</strong>
                    <div style={{ fontSize: 11, color: "#94A3B8" }}>
                      {new Date(e.changed_at).toLocaleString()} · {e.changed_by_username}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
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
  enableDescription,
  enableStatusColor,
  description,
  showMumHistory,
  sheetId,
  rowId,
  onSave,
  onOpenStatusPicker,
  onOpenLinkPicker,
  onSaveDescription,
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
  enableDescription?: boolean;
  enableStatusColor?: boolean;
  description?: string | null;
  /** True only for the Approval Date column -- adds the Mum-status-history eye button. */
  showMumHistory?: boolean;
  sheetId?: string;
  rowId?: string;
  onSave: (newValue: string) => void;
  onOpenStatusPicker: (anchor: HTMLElement) => void;
  onOpenLinkPicker: () => void;
  onSaveDescription: (text: string | null) => void;
  isFrozen?: boolean;
  isLastFrozen?: boolean;
  stickyLeft?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [descAnchor, setDescAnchor] = useState<HTMLElement | null>(null);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const swatch = statusSwatchColor(statusColor, customStatusTagId, customTags);
  const isManual = sourceType === "manual";
  const shownValue = isManual ? value : displayValue;
  const hasDescription = !!description;

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
          {enableDescription && !editing && (
            <button
              type="button"
              className="planning-desc-btn"
              onClick={(e) => setDescAnchor(descAnchor ? null : e.currentTarget)}
              title={hasDescription ? `Description: ${description}` : "Add description"}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 11,
                flexShrink: 0,
                color: hasDescription ? "#2563EB" : "#CBD5E1",
                opacity: hasDescription ? 1 : 0.5,
                lineHeight: 1,
                padding: "1px 2px",
              }}
            >
              ✎
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
          {showMumHistory && sheetId && rowId && <MumStatusHistoryButton sheetId={sheetId} rowId={rowId} />}
        </div>
      </div>
      {/* Description popover rendered inside the cell so its z-index stack is local */}
      {descAnchor && (
        <DescriptionPopover
          anchor={descAnchor}
          initialValue={description ?? ""}
          onSave={(text) => onSaveDescription(text || null)}
          onClose={() => setDescAnchor(null)}
        />
      )}
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

  const [addColumnOpen, setAddColumnOpen] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [newColumnType, setNewColumnType] = useState<PlanningColumnDataType>("text");
  const [newColumnPosition, setNewColumnPosition] = useState<string>(""); // "" = append at end

  const [addRowOpen, setAddRowOpen] = useState(false);
  const [newRowRecordId, setNewRowRecordId] = useState("");

  const [statusPicker, setStatusPicker] = useState<{ anchor: HTMLElement; rowId: string; columnId: string } | null>(null);
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
      setHiddenColumnIds((prev) => {
        const next = new Set(prev);
        if (next.has(columnId)) next.delete(columnId);
        else next.add(columnId);
        localStorage.setItem(hiddenColumnsStorageKey(activeSheetId), JSON.stringify([...next]));
        return next;
      });
    },
    [activeSheetId]
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

  // Hidden columns are simply excluded. Frozen (pinned) columns are moved to
  // the front, in their original relative order, so they sit right after the
  // always-frozen ITEM column and stay stuck there while the rest scrolls --
  // same visual result as Excel's freeze panes, without requiring the
  // frozen set to be a contiguous run of leading columns.
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenColumnIds.has(c.id)),
    [columns, hiddenColumnIds]
  );
  const orderedColumns = useMemo(() => {
    const frozen = visibleColumns.filter((c) => frozenColumnIds.has(c.id));
    const rest = visibleColumns.filter((c) => !frozenColumnIds.has(c.id));
    return [...frozen, ...rest];
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

  const cellByRowColumn = useMemo(() => {
    const map = new Map<string, PlanningRow["cells"][number]>();
    for (const row of rows) {
      for (const cell of row.cells) {
        map.set(`${row.id}:${cell.column_id}`, cell);
      }
    }
    return map;
  }, [rows]);

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

  async function handleAddColumn(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSheetId) return;
    const name = newColumnName.trim();
    if (!name) return;

    try {
      const position = newColumnPosition === "" ? null : Number(newColumnPosition);
      await apiPost<PlanningColumn>(`/planning/sheets/${activeSheetId}/columns`, {
        name,
        data_type: newColumnType,
        position,
      });

      setNewColumnName("");
      setNewColumnType("text");
      setNewColumnPosition("");
      setAddColumnOpen(false);
      await loadGrid(activeSheetId);
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
      let maxMum = 0;
      for (const col of columns) {
        const match = col.name.match(/mum\s*(\d+)/i);
        if (match) {
          const num = parseInt(match[1], 10);
          if (!isNaN(num) && num > maxMum) maxMum = num;
        }
      }
      const nextMumNum = maxMum > 0 ? maxMum + 1 : 1;

      const companions: { name: string; data_type: PlanningColumnDataType }[] = [
        { name: `Mum ${nextMumNum}`, data_type: "number" },
        { name: `Mum${nextMumNum} Remarks`, data_type: "text" },
        { name: `NO. OF PKG MUM${nextMumNum}`, data_type: "number" },
        { name: `TOTAL WEIGHT MUM${nextMumNum}`, data_type: "number" },
        { name: `TOTAL CBM MUM${nextMumNum}`, data_type: "number" },
      ];

      for (const companion of companions) {
        await apiPost<PlanningColumn>(`/planning/sheets/${activeSheetId}/columns`, {
          name: companion.name,
          data_type: companion.data_type,
          position: null,
        });
      }

      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    } finally {
      setCreatingNextMum(false);
    }
  }

  async function handleAddRow(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSheetId) return;
    if (!newRowRecordId) return;

    try {
      // The row always needs a `label` (it's the required fallback if the
      // link is ever cleared later); this is a throwaway placeholder
      // that's immediately superseded by the linked record's live value
      // once we reload the grid below.
      const { data: newRow } = await apiPost<PlanningRow>(`/planning/sheets/${activeSheetId}/rows`, { label: "Linked item" });

      if (newRow) {
        await apiPut(`/planning/sheets/${activeSheetId}/rows/${newRow.id}/item-link`, { record_id: newRowRecordId });
      }

      setNewRowRecordId("");
      setAddRowOpen(false);
      // Reload so `label` reflects the live-computed value (compute_row_item_display)
      // instead of the throwaway placeholder.
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeleteColumn(columnId: string) {
    if (!activeSheetId) return;
    if (!window.confirm("Delete this column? This removes every value stored in it.")) return;
    try {
      await apiDelete(`/planning/sheets/${activeSheetId}/columns/${columnId}`);
      setGrid((prev) =>
        prev
          ? {
            ...prev,
            columns: prev.columns.filter((c) => c.id !== columnId),
            rows: prev.rows.map((r) => ({ ...r, cells: r.cells.filter((cell) => cell.column_id !== columnId) })),
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
      await apiPut(`/planning/sheets/${activeSheetId}/rows/${rowId}/columns/${columnId}/value`, { value });
      setGrid((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.id !== rowId) return r;
            const exists = r.cells.some((cell) => cell.column_id === columnId);
            const updatedCells = exists
              ? r.cells.map((cell) =>
                cell.column_id === columnId ? { ...cell, value, display_value: value } : cell
              )
              : [
                ...r.cells,
                { id: null, row_id: rowId, column_id: columnId, value, display_value: value, status_color: null, custom_status_tag_id: null },
              ];
            return { ...r, cells: updatedCells };
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

  async function handleSaveCellDescription(rowId: string, columnId: string, description: string | null) {
    if (!activeSheetId) return;
    try {
      await apiPut(`/planning/sheets/${activeSheetId}/rows/${rowId}/columns/${columnId}/description`, { description });
      setGrid((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          rows: prev.rows.map((r) => {
            if (r.id !== rowId) return r;
            const exists = r.cells.some((cell) => cell.column_id === columnId);
            const updatedCells = exists
              ? r.cells.map((cell) => (cell.column_id === columnId ? { ...cell, description } : cell))
              : [...r.cells, { id: null, row_id: rowId, column_id: columnId, value: null, display_value: null, status_color: null, custom_status_tag_id: null, description }];
            return { ...r, cells: updatedCells };
          }),
        };
      });
    } catch (err) {
      setError(err);
    }
  }

  async function handleSaveRowDescription(rowId: string, description: string | null) {
    if (!activeSheetId) return;
    try {
      await apiPut(`/planning/sheets/${activeSheetId}/rows/${rowId}/description`, { description });
      setGrid((prev) =>
        prev
          ? { ...prev, rows: prev.rows.map((r) => (r.id === rowId ? { ...r, description } : r)) }
          : prev
      );
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
        <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E2E8F0", marginBottom: 16, flexWrap: "wrap" }}>
          {sheets.map((sheet) => (
            <button
              key={sheet.id}
              type="button"
              onClick={() => setActiveSheetId(sheet.id)}
              style={{
                padding: "8px 16px",
                border: "none",
                background: "transparent",
                borderBottom: sheet.id === activeSheetId ? "2px solid #2563EB" : "2px solid transparent",
                color: sheet.id === activeSheetId ? "#2563EB" : "#475569",
                fontWeight: sheet.id === activeSheetId ? 600 : 500,
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              {sheet.name}
            </button>
          ))}
          {sheets.length === 0 && !loading && (
            <div className="muted" style={{ padding: "8px 4px" }}>No sheets yet. Add one to get started.</div>
          )}
        </div>

        {activeSheetId && (
          <>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              {itemColumn.source_type === "linked_lookup" && (
                <Can permission="planning.row.manage">
                  <button type="button" className="btn btn-secondary" onClick={() => setAddRowOpen(true)}>
                    + Row (pick record)
                  </button>
                </Can>
              )}
              <Can permission="planning.column.manage">
                <button type="button" className="btn btn-secondary" onClick={() => setAddColumnOpen(true)}>
                  + Column
                </button>
              </Can>
              <button type="button" className="btn btn-secondary" onClick={() => setColumnsPanelOpen(true)} disabled={columns.length === 0}>
                Columns{hiddenColumnIds.size > 0 ? ` (${hiddenColumnIds.size} hidden)` : ""}
              </button>
              <Can permission="planning.column.manage">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={handleCreateNextMumGroup}
                  disabled={creatingNextMum || !activeSheetId}
                  title="Automatically detect latest Mum number and create next Mum column group (Mum, Remarks, PKG, Weight, CBM)"
                >
                  {creatingNextMum ? "Creating Next Mum…" : "+ Next Mum"}
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
                      onOpenConfigure={() => setConfigureColumn(itemColumn)}
                      isLastFrozen={lastFrozenColumnId === null}
                    />
                    {orderedColumns.map((col) => (
                      <ColumnHeader
                        key={col.id}
                        column={col}
                        canManage={canManageColumns}
                        onRename={(name) => handleRenameColumn(col.id, name)}
                        onDelete={() => handleDeleteColumn(col.id)}
                        onOpenConfigure={() => setConfigureColumn(col)}
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
                          enableDescription={itemColumn.enable_description}
                          description={row.description}
                          onSave={(newLabel) => handleRenameRow(row.id, newLabel)}
                          onOpenLinkPicker={() => setLinkPicker({ rowId: row.id, column: itemColumn })}
                          onSaveDescription={(text) => handleSaveRowDescription(row.id, text)}
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
                              enableDescription={col.enable_description}
                              enableStatusColor={col.enable_status_color}
                              showMumHistory={isApprovalDateColumn(col.name)}
                              sheetId={activeSheetId ?? undefined}
                              rowId={row.id}
                              description={cell?.description}
                              onSave={(value) => handleSaveCellValue(row.id, col.id, value)}
                              onOpenStatusPicker={(anchor) => setStatusPicker({ anchor, rowId: row.id, columnId: col.id })}
                              onOpenLinkPicker={() => setLinkPicker({ rowId: row.id, column: col })}
                              onSaveDescription={(text) => handleSaveCellDescription(row.id, col.id, text)}
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
          <SimpleModal title="Columns" onClose={() => setColumnsPanelOpen(false)}>
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
                      disabled={togglingStatusColorId === col.id}
                      onChange={() => handleToggleColumnStatusColor(col.id, !(col.enable_status_color ?? false))}
                      title={
                        col.enable_status_color
                          ? "Disable status colors for this column (hides the status-dot button)"
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

        {/* Add Column modal */}
        {addColumnOpen && (
          <SimpleModal title="Add Column" onClose={() => setAddColumnOpen(false)}>
            <form onSubmit={handleAddColumn}>
              <TextField
                id="new_column_name"
                label="Column Name *"
                required
                placeholder="e.g. Supplier Name, Quantity, Delivery Date"
                value={newColumnName}
                onChange={setNewColumnName}
              />
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", margin: "12px 0 6px" }}>
                Data Type
              </label>
              <select
                value={newColumnType}
                onChange={(e) => setNewColumnType(e.target.value as PlanningColumnDataType)}
                style={{ width: "100%", padding: 8, border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 13 }}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="boolean_yn">Y/N</option>
              </select>
              <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", margin: "12px 0 6px" }}>
                Insert Position (optional)
              </label>
              <select
                value={newColumnPosition}
                onChange={(e) => setNewColumnPosition(e.target.value)}
                style={{ width: "100%", padding: 8, border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 13 }}
              >
                <option value="">Append at the end</option>
                {columns.map((col, idx) => (
                  <option key={col.id} value={idx}>
                    Before "{col.name}"
                  </option>
                ))}
              </select>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setAddColumnOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Add Column
                </button>
              </div>
            </form>
          </SimpleModal>
        )}

        {/* Add Row modal */}
        {addRowOpen && (
          <SimpleModal title="Add Row (pick a record)" onClose={() => setAddRowOpen(false)}>
            <form onSubmit={handleAddRow}>
              <AddLinkedRowPicker
                sourceModule={itemColumn.source_module}
                recordId={newRowRecordId}
                onChange={setNewRowRecordId}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setAddRowOpen(false);
                    setNewRowRecordId("");
                  }}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  Add Row
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
  onOpenConfigure,
  isFrozen,
  isLastFrozen,
  stickyLeft,
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onOpenConfigure: () => void;
  isFrozen: boolean;
  isLastFrozen: boolean;
  stickyLeft: number | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [hovered, setHovered] = useState(false);

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
              padding: "0 14px",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
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
              onClick={onOpenConfigure}
              title="Configure data source / formula / role lock"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#64748B", fontSize: 12, padding: "1px 3px" }}
            >
              ⚙
            </button>
            <button
              type="button"
              onClick={onDelete}
              title="Delete column"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: "#EF4444", fontSize: 13, padding: "1px 3px" }}
            >
              ×
            </button>
          </div>
        )}
      </div>
    </th>
  );
}

/** Header cell for the first column ("ITEM"). Uses exact same gear function & configuration modal as all other columns. */
function EditableItemHeader({
  column,
  canManage,
  onRename,
  onOpenConfigure,
  isLastFrozen,
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (newTitle: string) => void;
  onOpenConfigure: () => void;
  isLastFrozen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
        {canManage && !editing && hovered && (
          <button
            type="button"
            onClick={onOpenConfigure}
            title="Configure data source / formula / role lock"
            style={{
              position: "absolute",
              right: 0,
              top: "50%",
              transform: "translateY(-50%)",
              border: "none",
              background: "#F8FAFC",
              cursor: "pointer",
              color: "#64748B",
              fontSize: 12,
              padding: "1px 4px",
            }}
          >
            ⚙
          </button>
        )}
      </div>
    </th>
  );
}

/** Row label cell (first column). Clickable and inline-editable just like grid cells, unless the sheet's ITEM column is linked-lookup -- then it's pulled from the linked record instead. */
function EditableRowLabel({
  label,
  canEdit,
  sourceType,
  enableDescription,
  description,
  onSave,
  onOpenLinkPicker,
  onSaveDescription,
  isLastFrozen,
}: {
  label: string;
  canEdit: boolean;
  sourceType: PlanningColumnSourceType;
  enableDescription?: boolean;
  description?: string | null;
  onSave: (newLabel: string) => void;
  onOpenLinkPicker: () => void;
  onSaveDescription: (text: string | null) => void;
  isLastFrozen?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const [descAnchor, setDescAnchor] = useState<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isManual = sourceType === "manual";
  const hasDescription = !!description;

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
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4, paddingRight: enableDescription ? 16 : 0 }}>
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
                ? `Computed (${sourceType}) — click the 🔗 to link this row to a record`
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
        {enableDescription && !editing && (
          <button
            type="button"
            className="planning-desc-btn"
            onClick={(e) => setDescAnchor(descAnchor ? null : e.currentTarget)}
            title={hasDescription ? `Description: ${description}` : "Add description"}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontSize: 11,
              flexShrink: 0,
              color: hasDescription ? "#2563EB" : "#CBD5E1",
              opacity: hasDescription ? 1 : 0.5,
              lineHeight: 1,
              padding: "1px 2px",
            }}
          >
            ✎
          </button>
        )}
      </div>
      {descAnchor && (
        <DescriptionPopover
          anchor={descAnchor}
          initialValue={description ?? ""}
          onSave={(text) => onSaveDescription(text || null)}
          onClose={() => setDescAnchor(null)}
        />
      )}
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

        {/* Description feature — opt-in per column; when enabled, every cell in this
            column shows a hover ✎ button the user can click to write a free-text note
            independent of the cell's value/status. */}
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
                When checked, each cell in this column shows a{" "}
                <span style={{ fontFamily: "monospace", fontWeight: 600 }}>✎</span> button on hover.
                Clicking it opens a free-text note the user can write for that specific cell — independent
                of the cell's value or status, purely for supplementary context.
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
 * Record picker shown inside the "Add Row" modal when the sheet's ITEM
 * column is configured as linked-lookup (Source Module + Field). Lets the
 * admin pick the actual record (e.g. a Product) in the same step as adding
 * the row, instead of typing an unrelated free-text label and only getting
 * real data into the column after a second, separate 🔗 link step.
 */
function AddLinkedRowPicker({
  sourceModule,
  recordId,
  onChange,
}: {
  sourceModule: string | null | undefined;
  recordId: string;
  onChange: (id: string) => void;
}) {
  const apiBase = SOURCE_MODULE_API[sourceModule || ""] || "";

  const recordFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      if (!apiBase) return [];
      const { data } = await apiGet<Record<string, unknown>[]>(
        apiBase + toQueryString({ search: term, page: 1, page_size: 20 }),
        { signal }
      );
      const labelField = SOURCE_MODULE_LABEL_FIELD[sourceModule || ""] || "name";
      return data.map((d) => ({ value: String(d.id), label: String(d[labelField] ?? d.id) }));
    },
    [apiBase, sourceModule]
  );

  const recordLabel = useCallback(
    async (id: string) => {
      if (!apiBase) return id;
      const { data } = await apiGet<Record<string, unknown>>(`${apiBase}/${id}`);
      const labelField = SOURCE_MODULE_LABEL_FIELD[sourceModule || ""] || "name";
      return String(data[labelField] ?? id);
    },
    [apiBase, sourceModule]
  );

  return (
    <div>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 }}>
        Select a record *
      </label>
      <SearchableDropdown
        value={recordId}
        onChange={(v) => onChange(v || "")}
        placeholder="Search…"
        fetchOptions={recordFetcher}
        fetchLabelForValue={recordLabel}
      />
      <p style={{ fontSize: 12, color: "#64748B", marginTop: 6 }}>
        ITEM is set to pull from Source Module + Field, so pick the record this row represents here.
      </p>
    </div>
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