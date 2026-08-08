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
import { BUILTIN_STATUS_COLORS } from "@/types/planning";

const CELL_MIN_WIDTH = 140;

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

/** One editable cell: click to edit the value, hover to reveal the status swatch. */
function GridCell({
  value,
  displayValue,
  statusColor,
  customStatusTagId,
  customTags,
  canEdit,
  sourceType,
  onSave,
  onOpenStatusPicker,
  onOpenLinkPicker,
}: {
  value: string | null | undefined;
  displayValue: string | null | undefined;
  statusColor: PlanningCellStatusColor | null | undefined;
  customStatusTagId: string | null | undefined;
  customTags: PlanningStatusTag[];
  canEdit: boolean;
  sourceType: PlanningColumnSourceType;
  onSave: (newValue: string) => void;
  onOpenStatusPicker: (anchor: HTMLElement) => void;
  onOpenLinkPicker: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const swatch = statusSwatchColor(statusColor, customStatusTagId, customTags);
  const isManual = sourceType === "manual";
  const shownValue = isManual ? value : displayValue;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function commit() {
    setEditing(false);
    if (draft !== (value ?? "")) onSave(draft);
  }

  return (
    <td
      style={{
        position: "relative",
        minWidth: CELL_MIN_WIDTH,
        padding: 0,
        borderLeft: swatch ? `3px solid ${swatch}` : "3px solid transparent",
        background: swatch ? `${swatch}14` : !isManual ? "#F8FAFC" : undefined,
      }}
      className="planning-cell"
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 6px" }}>
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
            style={{ width: "100%", border: "1px solid #2563EB", borderRadius: 4, padding: "3px 5px", fontSize: 13 }}
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
              flex: 1,
              cursor: canEdit && isManual ? "text" : "default",
              fontSize: 13,
              minHeight: 18,
              display: "block",
              fontStyle: !isManual ? "italic" : undefined,
              color: !isManual ? "#475569" : undefined,
            }}
          >
            {shownValue || ""}
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
        {canEdit && !editing && (
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
  const [newRowLabel, setNewRowLabel] = useState("");

  const [statusPicker, setStatusPicker] = useState<{ anchor: HTMLElement; rowId: string; columnId: string } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<PlanningChangeLogEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [configureColumn, setConfigureColumn] = useState<PlanningColumn | null>(null);
  const [linkPicker, setLinkPicker] = useState<{ rowId: string; column: PlanningColumn } | null>(null);

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
  const rows = grid?.rows ?? [];

  const cellByRowColumn = useMemo(() => {
    const map = new Map<string, PlanningRow["cells"][number]>();
    for (const row of rows) {
      for (const cell of row.cells) {
        map.set(`${row.id}:${cell.column_id}`, cell);
      }
    }
    return map;
  }, [rows]);

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
    if (!activeSheetId || !newColumnName.trim()) return;
    try {
      await apiPost(`/planning/sheets/${activeSheetId}/columns`, {
        name: newColumnName.trim(),
        data_type: newColumnType,
        position: newColumnPosition === "" ? null : Number(newColumnPosition),
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

  async function handleAddRow(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSheetId || !newRowLabel.trim()) return;
    try {
      await apiPost(`/planning/sheets/${activeSheetId}/rows`, { label: newRowLabel.trim() });
      setNewRowLabel("");
      setAddRowOpen(false);
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
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeleteRow(rowId: string) {
    if (!activeSheetId) return;
    if (!window.confirm("Delete this row?")) return;
    try {
      await apiDelete(`/planning/sheets/${activeSheetId}/rows/${rowId}`);
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    }
  }

  async function handleRenameColumn(columnId: string, name: string) {
    if (!activeSheetId || !name.trim()) return;
    try {
      await apiPatch(`/planning/sheets/${activeSheetId}/columns/${columnId}`, { name: name.trim() });
      await loadGrid(activeSheetId);
    } catch (err) {
      setError(err);
    }
  }

  async function handleSaveCellValue(rowId: string, columnId: string, value: string) {
    if (!activeSheetId) return;
    try {
      await apiPut(`/planning/sheets/${activeSheetId}/rows/${rowId}/columns/${columnId}/value`, { value });
      await loadGrid(activeSheetId);
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
      await loadGrid(activeSheetId);
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
              <Can permission="planning.row.manage">
                <button type="button" className="btn btn-secondary" onClick={() => setAddRowOpen(true)}>
                  + Row
                </button>
              </Can>
              <Can permission="planning.column.manage">
                <button type="button" className="btn btn-secondary" onClick={() => setAddColumnOpen(true)}>
                  + Column
                </button>
              </Can>
            </div>

            <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#F8FAFC" }}>
                    <th style={{ padding: "8px 10px", textAlign: "left", minWidth: 220, borderBottom: "1px solid #E2E8F0" }}>Item</th>
                    {columns.map((col) => (
                      <ColumnHeader
                        key={col.id}
                        column={col}
                        canManage={canManageColumns}
                        onRename={(name) => handleRenameColumn(col.id, name)}
                        onDelete={() => handleDeleteColumn(col.id)}
                        onOpenConfigure={() => setConfigureColumn(col)}
                      />
                    ))}
                    <th style={{ width: 40, borderBottom: "1px solid #E2E8F0" }} />
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <TableMessageRow colSpan={columns.length + 2}>Loading grid…</TableMessageRow>
                  ) : rows.length === 0 ? (
                    <TableMessageRow colSpan={columns.length + 2}>No rows yet. Add one to get started.</TableMessageRow>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.id}>
                        <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9", fontWeight: 500 }}>{row.label}</td>
                        {columns.map((col) => {
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
                              onSave={(value) => handleSaveCellValue(row.id, col.id, value)}
                              onOpenStatusPicker={(anchor) => setStatusPicker({ anchor, rowId: row.id, columnId: col.id })}
                              onOpenLinkPicker={() => setLinkPicker({ rowId: row.id, column: col })}
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

        {/* Add Sheet modal */}
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
                placeholder="e.g. Mum 43"
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
          <SimpleModal title="Add Row" onClose={() => setAddRowOpen(false)}>
            <form onSubmit={handleAddRow}>
              <TextField
                id="new_row_label"
                label="Row Label *"
                required
                placeholder="e.g. ISL350XDAN Flow Wrap machine"
                value={newRowLabel}
                onChange={setNewRowLabel}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setAddRowOpen(false)}>
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

        {configureColumn && activeSheetId && (
          <ConfigureColumnModal
            sheetId={activeSheetId}
            column={configureColumn}
            onClose={() => setConfigureColumn(null)}
            onSaved={() => {
              setConfigureColumn(null);
              void loadGrid(activeSheetId);
            }}
            onError={setError}
          />
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
}: {
  column: PlanningColumn;
  canManage: boolean;
  onRename: (name: string) => void;
  onDelete: () => void;
  onOpenConfigure: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(column.name);

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
    <th style={{ padding: "8px 10px", textAlign: "left", minWidth: CELL_MIN_WIDTH, borderBottom: "1px solid #E2E8F0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
            style={{ width: "100%", border: "1px solid #2563EB", borderRadius: 4, padding: "2px 5px", fontSize: 13 }}
          />
        ) : (
          <span
            onClick={() => canManage && setEditing(true)}
            style={{ cursor: canManage ? "text" : "default", fontWeight: 600, color: "#334155" }}
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
            }}
          >
            {sourceBadge.label}
          </span>
        )}
        {canManage && !editing && (
          <button
            type="button"
            onClick={onOpenConfigure}
            title="Configure data source / formula / role lock"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#94A3B8", fontSize: 12 }}
          >
            ⚙
          </button>
        )}
        {canManage && !editing && (
          <button
            type="button"
            onClick={onDelete}
            title="Delete column"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#CBD5E1", marginLeft: "auto" }}
          >
            ×
          </button>
        )}
      </div>
    </th>
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
  onError,
}: {
  sheetId: string;
  column: PlanningColumn;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [sourceType, setSourceType] = useState<PlanningColumnSourceType>(column.source_type);
  const [sourceModule, setSourceModule] = useState(column.source_module || "");
  const [sourceField, setSourceField] = useState(column.source_field || "");
  const [aggregateFn, setAggregateFn] = useState<PlanningAggregateFn | "">(column.source_aggregate_fn || "");
  const [formulaExpression, setFormulaExpression] = useState(column.formula_expression || "");
  const [modules, setModules] = useState<SourceModuleInfo[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [lockedRoleIds, setLockedRoleIds] = useState<string[]>([]);
  const [savingLock, setSavingLock] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiGet<SourceModuleInfo[]>("/planning/source-modules");
        setModules(data);
      } catch (err) {
        onError(err);
      }
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
    try {
      await apiPut(`/planning/sheets/${sheetId}/columns/${column.id}/source`, {
        source_type: sourceType,
        source_module: sourceType === "linked_lookup" || sourceType === "aggregate" ? sourceModule || null : null,
        source_field: sourceType === "linked_lookup" || sourceType === "aggregate" ? sourceField || null : null,
        source_aggregate_fn: sourceType === "aggregate" ? aggregateFn || null : null,
        source_aggregate_filters: null,
        formula_expression: sourceType === "formula" ? formulaExpression || null : null,
      });
      onSaved();
    } catch (err) {
      onError(err);
    }
  }

  async function handleSaveRoleLock() {
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
          <option value="aggregate">Aggregate (one computed value from another module)</option>
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

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save Data Source
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

  const moduleApiBase: Record<string, string> = {
    product: "/masters/products",
    supplier: "/suppliers",
    buyer: "/buyers",
  };
  const moduleLabelField: Record<string, string> = {
    product: "product_name",
    supplier: "company_name",
    buyer: "company_name",
  };

  const apiBase = moduleApiBase[column.source_module || ""] || "";

  const recordFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      if (!apiBase) return [];
      const { data } = await apiGet<Record<string, unknown>[]>(
        apiBase + toQueryString({ search: term, page: 1, page_size: 20 }),
        { signal }
      );
      const labelField = moduleLabelField[column.source_module || ""] || "name";
      return data.map((d) => ({ value: String(d.id), label: String(d[labelField] ?? d.id) }));
    },
    [apiBase, column.source_module] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const recordLabel = useCallback(
    async (id: string) => {
      if (!apiBase) return id;
      const { data } = await apiGet<Record<string, unknown>>(`${apiBase}/${id}`);
      const labelField = moduleLabelField[column.source_module || ""] || "name";
      return String(data[labelField] ?? id);
    },
    [apiBase, column.source_module] // eslint-disable-line react-hooks/exhaustive-deps
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!recordId) return;
    try {
      await apiPut(`/planning/sheets/${sheetId}/rows/${rowId}/columns/${column.id}/link`, { record_id: recordId });
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