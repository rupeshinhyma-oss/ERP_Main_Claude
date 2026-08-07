/**
 * Trash Management Page.
 *
 * Displays all soft-deleted records across system modules.
 * Allows restoring records back to active state or permanently deleting them from the database.
 */

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Banner } from "@/components/ui";
import { apiGet, apiPost } from "@/lib/api";

interface TrashItem {
  id: string;
  entity_type: string;
  name: string;
  details?: string | null;
  deleted_at?: string | null;
}

export function TrashPage() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [filterModule, setFilterModule] = useState<string>("ALL");
  const [searchQuery, setSearchQuery] = useState<string>("");

  async function loadTrash() {
    try {
      setLoading(true);
      setError(null);
      const res = await apiGet<TrashItem[]>("/trash");
      if (res && res.data) {
        setItems(res.data);
      }
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadTrash();
  }, []);

  const modules = Array.from(new Set(items.map((i) => i.entity_type)));

  const filteredItems = items.filter((item) => {
    if (filterModule !== "ALL" && item.entity_type !== filterModule) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const nameMatch = item.name.toLowerCase().includes(q);
      const typeMatch = item.entity_type.toLowerCase().includes(q);
      const detailsMatch = item.details?.toLowerCase().includes(q);
      if (!nameMatch && !typeMatch && !detailsMatch) return false;
    }
    return true;
  });

  const allFilteredSelected =
    filteredItems.length > 0 && filteredItems.every((i) => selectedIds.has(`${i.entity_type}:${i.id}`));

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      const next = new Set<string>();
      filteredItems.forEach((i) => next.add(`${i.entity_type}:${i.id}`));
      setSelectedIds(next);
    }
  }

  function toggleSelectItem(entityType: string, id: string) {
    const key = `${entityType}:${id}`;
    const next = new Set(selectedIds);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setSelectedIds(next);
  }

  async function handleRestoreSingle(entityType: string, id: string, name: string) {
    setError(null);
    setSuccessMsg(null);
    try {
      await apiPost("/trash/restore", { items: [{ entity_type: entityType, id }] });
      setSuccessMsg(`Successfully restored '${name}' back to active state.`);
      setSelectedIds(new Set());
      await loadTrash();
    } catch (err) {
      setError(err);
    }
  }

  async function handlePermanentDeleteSingle(entityType: string, id: string, name: string) {
    if (!confirm(`Permanently delete '${name}' from database?\n\nWARNING: This cannot be undone!`)) {
      return;
    }
    setError(null);
    setSuccessMsg(null);
    try {
      await apiPost("/trash/permanent-delete", { items: [{ entity_type: entityType, id }] });
      setSuccessMsg(`Permanently deleted '${name}' from database.`);
      setSelectedIds(new Set());
      await loadTrash();
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkRestore() {
    if (selectedIds.size === 0) return;
    setError(null);
    setSuccessMsg(null);

    const payloadItems = Array.from(selectedIds).map((key) => {
      const [entity_type, id] = key.split(":");
      return { entity_type, id };
    });

    try {
      await apiPost("/trash/restore", { items: payloadItems });
      setSuccessMsg(`Successfully restored ${payloadItems.length} selected item(s).`);
      setSelectedIds(new Set());
      await loadTrash();
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkPermanentDelete() {
    if (selectedIds.size === 0) return;
    if (
      !confirm(
        `Permanently delete ${selectedIds.size} selected item(s) from database?\n\nWARNING: This action is irreversible!`
      )
    ) {
      return;
    }
    setError(null);
    setSuccessMsg(null);

    const payloadItems = Array.from(selectedIds).map((key) => {
      const [entity_type, id] = key.split(":");
      return { entity_type, id };
    });

    try {
      await apiPost("/trash/permanent-delete", { items: payloadItems });
      setSuccessMsg(`Permanently deleted ${payloadItems.length} item(s) from database.`);
      setSelectedIds(new Set());
      await loadTrash();
    } catch (err) {
      setError(err);
    }
  }

  async function handleEmptyTrash() {
    if (items.length === 0) return;
    if (
      !confirm(
        "Are you sure you want to EMPTY THE TRASH?\n\nALL soft-deleted items will be PERMANENTLY DELETED from the database!"
      )
    ) {
      return;
    }
    setError(null);
    setSuccessMsg(null);

    try {
      const res = await apiPost<{ deleted_count: number }>("/trash/empty", {});
      const count = res?.data?.deleted_count || 0;
      setSuccessMsg(`Trash emptied. Permanently deleted ${count} item(s).`);
      setSelectedIds(new Set());
      await loadTrash();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <AppShell activeKey="trash">
      <main className="page" style={{ background: "#f8fafc", minHeight: "calc(100vh - 64px)", padding: "24px 32px" }}>
        {/* Page Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
          <div>
            <h1 style={{ color: "#0f172a", fontWeight: 700, fontSize: "22px", margin: 0 }}>Trash</h1>
            <p style={{ color: "#64748b", fontSize: "13.5px", margin: "4px 0 0 0" }}>
              View and manage soft-deleted items across all modules. Permanently delete or restore records to the database.
            </p>
          </div>
          {items.length > 0 && (
            <button
              type="button"
              className="btn btn-danger"
              onClick={handleEmptyTrash}
              style={{
                background: "#dc2626",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "8px 16px",
                fontWeight: 600,
                fontSize: "13.5px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              🗑️ Empty Trash
            </button>
          )}
        </div>

        <Banner error={error} />
        {successMsg && (
          <div className="banner banner-success" style={{ marginBottom: "16px" }}>
            {successMsg}
          </div>
        )}

        {/* Toolbar & Filters */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "10px",
            border: "1px solid #e2e8f0",
            padding: "16px 20px",
            marginBottom: "20px",
            display: "flex",
            flexWrap: "wrap",
            gap: "16px",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            {/* Search Input */}
            <input
              type="text"
              placeholder="Search in trash..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                padding: "8px 14px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "13.5px",
                width: "240px",
                outline: "none",
              }}
            />

            {/* Filter Module Dropdown */}
            <select
              value={filterModule}
              onChange={(e) => setFilterModule(e.target.value)}
              style={{
                padding: "8px 14px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                fontSize: "13.5px",
                background: "#ffffff",
                color: "#0f172a",
                outline: "none",
                cursor: "pointer",
              }}
            >
              <option value="ALL">All Modules ({items.length})</option>
              {modules.map((mod) => (
                <option key={mod} value={mod}>
                  {mod} ({items.filter((i) => i.entity_type === mod).length})
                </option>
              ))}
            </select>
          </div>

          {/* Bulk Action Controls */}
          {selectedIds.size > 0 && (
            <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <span style={{ fontSize: "13px", fontWeight: 600, color: "#0061f2" }}>
                {selectedIds.size} selected
              </span>
              <button
                type="button"
                className="btn"
                onClick={handleBulkRestore}
                style={{
                  background: "#059669",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  padding: "7px 14px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                🔄 Restore Selected
              </button>
              <button
                type="button"
                className="btn"
                onClick={handleBulkPermanentDelete}
                style={{
                  background: "#dc2626",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "6px",
                  padding: "7px 14px",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                🗑️ Delete Selected Permanently
              </button>
            </div>
          )}
        </div>

        {/* Data Table */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "10px",
            border: "1px solid #e2e8f0",
            overflow: "hidden",
            boxShadow: "0 1px 3px rgba(0,0,0,0.05)",
          }}
        >
          {loading ? (
            <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>Loading trash items...</div>
          ) : filteredItems.length === 0 ? (
            <div style={{ padding: "48px", textAlign: "center", color: "#64748b" }}>
              <div style={{ fontSize: "36px", marginBottom: "8px" }}>🗑️</div>
              <div style={{ fontWeight: 600, fontSize: "15px", color: "#334155" }}>Trash is empty</div>
              <div style={{ fontSize: "13px", marginTop: "4px" }}>No soft-deleted records found.</div>
            </div>
          ) : (
            <table className="table" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "12px 16px", width: "40px" }}>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                  <th style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#475569" }}>
                    Module Type
                  </th>
                  <th style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#475569" }}>
                    Name / Title
                  </th>
                  <th style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#475569" }}>
                    Details
                  </th>
                  <th style={{ padding: "12px 16px", fontSize: "13px", fontWeight: 600, color: "#475569" }}>
                    Deleted At
                  </th>
                  <th
                    style={{
                      padding: "12px 16px",
                      fontSize: "13px",
                      fontWeight: 600,
                      color: "#475569",
                      textAlign: "right",
                    }}
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const key = `${item.entity_type}:${item.id}`;
                  const isChecked = selectedIds.has(key);
                  return (
                    <tr
                      key={key}
                      style={{
                        borderBottom: "1px solid #f1f5f9",
                        background: isChecked ? "#f0f9ff" : "transparent",
                      }}
                    >
                      <td style={{ padding: "12px 16px" }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleSelectItem(item.entity_type, item.id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      <td style={{ padding: "12px 16px" }}>
                        <span
                          style={{
                            background: "#e0f2fe",
                            color: "#0369a1",
                            padding: "3px 10px",
                            borderRadius: "12px",
                            fontSize: "12px",
                            fontWeight: 600,
                          }}
                        >
                          {item.entity_type}
                        </span>
                      </td>
                      <td style={{ padding: "12px 16px", fontWeight: 600, color: "#0f172a", fontSize: "13.5px" }}>
                        {item.name}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#64748b", fontSize: "13px" }}>
                        {item.details || "—"}
                      </td>
                      <td style={{ padding: "12px 16px", color: "#64748b", fontSize: "13px" }}>
                        {item.deleted_at ? new Date(item.deleted_at).toLocaleString() : "—"}
                      </td>
                      <td style={{ padding: "12px 16px", textAlign: "right" }}>
                        <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => handleRestoreSingle(item.entity_type, item.id, item.name)}
                            style={{
                              background: "#ecfdf5",
                              color: "#047857",
                              border: "1px solid #a7f3d0",
                              padding: "4px 10px",
                              borderRadius: "4px",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                            title="Restore back to active state"
                          >
                            🔄 Restore
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => handlePermanentDeleteSingle(item.entity_type, item.id, item.name)}
                            style={{
                              background: "#fef2f2",
                              color: "#dc2626",
                              border: "1px solid #fecaca",
                              padding: "4px 10px",
                              borderRadius: "4px",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                            title="Completely delete from database"
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </AppShell>
  );
}
