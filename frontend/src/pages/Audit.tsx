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

function DetailItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

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
                  <TableMessageRow colSpan={8}>Loading...</TableMessageRow>
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

      <Modal
        open={Boolean(detail)}
        title="Audit Entry Detail"
        onClose={() => setDetail(null)}
        cardStyle={{ maxWidth: "720px" }}
      >
        {detail && (
          <>
            <div className="detail-grid">
              <DetailItem label="Time" value={new Date(detail.created_at).toLocaleString()} />
              <DetailItem label="User" value={detail.username_snapshot || "System"} />
              <DetailItem label="Action" value={detail.action} />
              <DetailItem label="Module" value={detail.module} />
              <DetailItem label="Entity Type" value={detail.entity_type || "—"} />
              <DetailItem label="Entity ID" value={detail.entity_id || "—"} />
              <DetailItem label="HTTP Method" value={detail.http_method || "—"} />
              <DetailItem label="Endpoint" value={detail.endpoint || "—"} />
              <DetailItem
                label="Response Status"
                value={<StatusCodeBadge code={detail.response_status} />}
              />
              <DetailItem label="IP Address" value={detail.ip_address || "—"} />
              <DetailItem label="Request ID" value={detail.request_id || "—"} />
              <DetailItem label="Description" value={detail.description || "—"} />
            </div>
            <div className="section-title">Old Values</div>
            <div className="detail-pre">{detail.old_values || "—"}</div>
            <div className="section-title">New Values</div>
            <div className="detail-pre">{detail.new_values || "—"}</div>
          </>
        )}
      </Modal>
    </AppShell>
  );
}
