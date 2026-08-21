/**
 * Audit Log. Ported from audit.html.
 *
 * Read-only trail, newest first. The detail modal loads the full entry (the list
 * response truncates the description at 80 characters) and shows the raw
 * old/new value blobs.
 */

import { useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Modal, TableMessageRow } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { apiGet, toQueryString } from "@/lib/api";
import { useDebouncedValue } from "@/lib/hooks";
import type { AuditEntry, PaginationMeta } from "@/types";

const ACTION_OPTIONS: [string, string][] = [
  ["CREATE", "Create"],
  ["UPDATE", "Update"],
  ["DELETE", "Delete"],
  ["LOGIN", "Login"],
  ["LOGIN_FAILED", "Login Failed"],
  ["LOGOUT", "Logout"],
  ["PASSWORD_CHANGE", "Password Change"],
  ["PASSWORD_RESET", "Password Reset"],
  ["ROLE_ASSIGNED", "Role Assigned"],
  ["ROLE_REMOVED", "Role Removed"],
  ["IMPORT", "Import"],
  ["EXPORT", "Export"],
  ["FILE_UPLOAD", "File Upload"],
  ["FILE_DELETE", "File Delete"],
  ["OTHER", "Other"],
];

/** 2xx reads as active, 4xx+ as danger, anything else neutral. */
function StatusCodeBadge({ code }: { code?: number | null }) {
  if (!code) return <span className="badge badge-neutral">—</span>;
  const cls = code >= 200 && code < 300 ? "badge-active" : code >= 400 ? "badge-danger" : "badge-neutral";
  return <span className={`badge ${cls}`}>{code}</span>;
}

function AuditTableSkeletonRows({ count = 8 }: { count?: number }) {
  const descWidths = ["75%", "90%", "60%", "85%", "70%", "65%"];
  return (
    <>
      {Array.from({ length: count }).map((_, idx) => (
        <tr key={`audit-sk-${idx}`}>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "110px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "80px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "65px", height: "20px", borderRadius: "12px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "70px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "75px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div
              className="skeleton-line"
              style={{ width: descWidths[idx % descWidths.length], height: "14px", borderRadius: "4px" }}
            />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "40px", height: "20px", borderRadius: "12px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "45px", height: "24px", borderRadius: "4px" }} />
          </td>
        </tr>
      ))}
    </>
  );
}

function DetailTile({ label, value, icon, isCode = false }: { label: string; value: React.ReactNode; icon?: string; isCode?: boolean }) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        padding: "10px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.02)",
      }}
    >
      <div style={{ fontSize: "11px", fontWeight: 600, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.5px", display: "flex", alignItems: "center", gap: "5px" }}>
        {icon && <span>{icon}</span>}
        <span>{label}</span>
      </div>
      <div
        style={{
          fontSize: isCode ? "12px" : "13.5px",
          fontWeight: isCode ? 500 : 600,
          color: "#0f172a",
          fontFamily: isCode ? "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" : "inherit",
          wordBreak: "break-word",
        }}
      >
        {value || "—"}
      </div>
    </div>
  );
}

function formatJsonValue(val: unknown): string {
  if (val === null || val === undefined || val === "") return "";
  if (typeof val === "object") {
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }
  if (typeof val === "string") {
    try {
      const parsed = JSON.parse(val);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return val;
    }
  }
  return String(val);
}

function JsonViewer({ title, value, emptyMessage }: { title: string; value: unknown; emptyMessage: string }) {
  const [copied, setCopied] = useState(false);
  const formatted = formatJsonValue(value);

  const handleCopy = () => {
    if (!formatted) return;
    navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: "0.5px" }}>
          {title}
        </span>
        {formatted && (
          <button
            type="button"
            onClick={handleCopy}
            style={{
              background: "#f1f5f9",
              border: "1px solid #cbd5e1",
              borderRadius: "4px",
              padding: "3px 10px",
              fontSize: "11.5px",
              fontWeight: 600,
              color: copied ? "#16a34a" : "#475569",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "4px",
            }}
          >
            {copied ? "✓ Copied" : "📋 Copy JSON"}
          </button>
        )}
      </div>
      {formatted ? (
        <pre
          style={{
            background: "#0f172a",
            color: "#38bdf8",
            padding: "14px 16px",
            borderRadius: "8px",
            fontSize: "12px",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            lineHeight: 1.55,
            maxHeight: "320px",
            overflow: "auto",
            margin: 0,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            border: "1px solid #1e293b",
            boxShadow: "inset 0 1px 3px rgba(0,0,0,0.3)",
          }}
        >
          {formatted}
        </pre>
      ) : (
        <div
          style={{
            background: "#f8fafc",
            border: "1px dashed #cbd5e1",
            borderRadius: "8px",
            padding: "14px 16px",
            color: "#94a3b8",
            fontSize: "13px",
            fontStyle: "italic",
          }}
        >
          {emptyMessage}
        </div>
      )}
    </div>
  );
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const [searchInput, setSearchInput] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [moduleInput, setModuleInput] = useState("");
  const search = useDebouncedValue(searchInput, 300);
  const moduleFilter = useDebouncedValue(moduleInput, 300);

  const [detail, setDetail] = useState<AuditEntry | null>(null);
  const firstLoad = useRef(true);

  // Any filter change returns to page 1 (skipped on the very first render).
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    setCurrentPage(1);
  }, [search, actionFilter, moduleFilter]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const params = {
        page: currentPage,
        page_size: pageSize,
        sort_by: "created_at",
        sort_order: "desc",
        search,
        action: actionFilter,
        module: moduleFilter,
      };
      try {
        const { data, meta } = await apiGet<AuditEntry[]>("/audit" + toQueryString(params));
        if (cancelled) return;
        setRows(data || []);
        setPagination(meta?.pagination);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setRows([]);
        setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPage, pageSize, search, actionFilter, moduleFilter]);

  async function openDetail(id: string) {
    try {
      const { data } = await apiGet<AuditEntry>(`/audit/${id}`);
      setDetail(data);
    } catch (err) {
      setError(err);
    }
  }

  return (
    <AppShell activeKey="audit" pageClassName="page-audit">
      <main className="page">
        <Breadcrumb trail={["Audit Log"]} />
        <div className="page-header">
          <div>
            <h1>Audit Log</h1>
            <div className="page-subtitle">
              A read-only trail of every create, update, delete, login, import, and export
              action.
            </div>
          </div>
        </div>
        <Banner error={error} />

        <div className="card">
          <div className="toolbar">
            <input
              type="text"
              placeholder="Search module, entity type, endpoint, description..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
              <option value="">All actions</option>
              {ACTION_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Filter by module (e.g. suppliers)"
              style={{ maxWidth: "220px" }}
              value={moduleInput}
              onChange={(e) => setModuleInput(e.target.value)}
            />
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Action</th>
                  <th>Module</th>
                  <th>Entity</th>
                  <th>Description</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <AuditTableSkeletonRows count={8} />
                ) : rows.length === 0 ? (
                  <TableMessageRow colSpan={8}>No audit entries found.</TableMessageRow>
                ) : (
                  rows.map((entry) => (
                    <tr key={entry.id}>
                      <td>{new Date(entry.created_at).toLocaleString()}</td>
                      <td>{entry.username_snapshot || "System"}</td>
                      <td>
                        <span className="badge badge-neutral">{entry.action}</span>
                      </td>
                      <td>{entry.module}</td>
                      <td>
                        {entry.entity_type ? entry.entity_type : "—"}
                        {entry.entity_id && (
                          <>
                            <br />
                            <span className="cell-secondary">{entry.entity_id}</span>
                          </>
                        )}
                      </td>
                      <td>{entry.description ? entry.description.slice(0, 80) : "—"}</td>
                      <td>
                        <StatusCodeBadge code={entry.response_status} />
                      </td>
                      <td className="actions">
                        <button className="btn btn-small" onClick={() => openDetail(entry.id)}>
                          View
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <Pagination
              pagination={pagination}
              pageSize={pageSize}
              onPageChange={setCurrentPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setCurrentPage(1);
              }}
            />
          </div>
        </div>
      </main>

      {/* Audit Entry Detail Drawer */}
      <Modal
        open={Boolean(detail)}
        title="🔍 Audit Entry Detail"
        onClose={() => setDetail(null)}
        cardStyle={{
          maxWidth: "760px",
          width: "100%",
          height: "100vh",
          maxHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          padding: 0,
        }}
      >
        {detail && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "calc(100vh - 65px)", overflow: "hidden" }}>
            {/* Scrollable Detail Body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "20px" }}>
              {/* Header Hero Banner */}
              <div
                style={{
                  background: "linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)",
                  border: "1px solid #e2e8f0",
                  borderRadius: "10px",
                  padding: "16px 20px",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "10px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                    <span className="badge badge-active" style={{ fontSize: "12px", fontWeight: 700, padding: "3px 10px" }}>
                      {detail.action}
                    </span>
                    <span style={{ fontSize: "12.5px", background: "#ffffff", border: "1px solid #cbd5e1", padding: "2px 8px", borderRadius: "6px", color: "#334155", fontWeight: 600 }}>
                      📦 {detail.module}
                    </span>
                    {detail.entity_type && (
                      <span style={{ fontSize: "12.5px", background: "#ffffff", border: "1px solid #cbd5e1", padding: "2px 8px", borderRadius: "6px", color: "#334155", fontWeight: 600 }}>
                        🏷️ {detail.entity_type}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <StatusCodeBadge code={detail.response_status} />
                  </div>
                </div>

                {detail.description && (
                  <div style={{ fontSize: "13.5px", color: "#1e293b", fontWeight: 500, lineHeight: 1.45, marginTop: "6px" }}>
                    {detail.description}
                  </div>
                )}
              </div>

              {/* Metadata Grid */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                  gap: "12px",
                }}
              >
                <DetailTile label="User" value={detail.username_snapshot || "System"} icon="👤" />
                <DetailTile label="Time" value={new Date(detail.created_at).toLocaleString()} icon="📅" />
                <DetailTile label="HTTP Method" value={detail.http_method || "—"} icon="⚡" isCode />
                <DetailTile label="IP Address" value={detail.ip_address || "—"} icon="🌐" isCode />
                <DetailTile label="Entity ID" value={detail.entity_id || "—"} icon="🆔" isCode />
                <DetailTile label="Request ID" value={detail.request_id || "—"} icon="🔗" isCode />
                <DetailTile label="Endpoint" value={detail.endpoint || "—"} icon="📍" isCode />
              </div>

              {/* Old Values */}
              <JsonViewer
                title="Old Values"
                value={detail.old_values}
                emptyMessage="No previous state recorded for this entry."
              />

              {/* New Values */}
              <JsonViewer
                title="New Values"
                value={detail.new_values}
                emptyMessage="No modified state payload for this entry."
              />
            </div>

            {/* Sticky Drawer Footer */}
            <div
              style={{
                padding: "14px 24px",
                background: "#ffffff",
                borderTop: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "flex-end",
              }}
            >
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: "8px 20px" }}
                onClick={() => setDetail(null)}
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
