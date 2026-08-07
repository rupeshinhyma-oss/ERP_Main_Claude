/**
 * Effective Permissions Inspector. Ported from effective-permissions.html.
 *
 * Read-only audit view that explains *why* a user has each permission: what
 * their roles grant, what individual overrides add or revoke, and the final
 * computed set. The tracing table at the bottom is filtered and paginated
 * entirely client-side, since the whole breakdown arrives in one response.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { apiGet } from "@/lib/api";
import type { EffectivePermissionsBreakdown, ItemsPage, User } from "@/types";

const PAGE_SIZE = 20;

export function sourceBadgeClass(source: string): string {
  if (source === "Individual User") return "source-user";
  if (source === "Super Administrator") return "source-admin";
  return "source-role";
}

function InfoItem({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="info-label">{label}</div>
      <div className="info-value">{value}</div>
    </div>
  );
}

export function EffectivePermissionsPage() {
  const [params] = useSearchParams();
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [breakdown, setBreakdown] = useState<EffectivePermissionsBreakdown | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [error, setError] = useState<unknown>(null);

  const [tableSearch, setTableSearch] = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [tablePage, setTablePage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await apiGet<ItemsPage<User>>("/users?limit=200");
        setUsers(res.data.items || []);
        // Deep-link support: ?user_id=… selects and loads that user directly.
        const userParam = params.get("user_id");
        if (userParam) setSelectedUserId(userParam);
      } catch (err) {
        setError(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedUserId) {
      setBreakdown(null);
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setTablePage(1);
    (async () => {
      try {
        const res = await apiGet<EffectivePermissionsBreakdown>(
          `/rbac/users/${selectedUserId}/effective-permissions`
        );
        if (cancelled) return;
        setBreakdown(res.data);
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err);
        setStatus("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedUserId]);

  const sources = breakdown?.permission_sources || [];
  const modules = useMemo(
    () => Array.from(new Set(sources.map((s) => s.module))).sort(),
    [sources]
  );

  const filtered = useMemo(() => {
    const q = tableSearch.toLowerCase();
    return sources.filter((item) => {
      const matchesQ =
        item.code.toLowerCase().includes(q) || item.module.toLowerCase().includes(q);
      const matchesModule = !moduleFilter || item.module === moduleFilter;
      const matchesSource = !sourceFilter || item.source === sourceFilter;
      return matchesQ && matchesModule && matchesSource;
    });
  }, [sources, tableSearch, moduleFilter, sourceFilter]);

  const pageItems = filtered.slice((tablePage - 1) * PAGE_SIZE, tablePage * PAGE_SIZE);

  const info = breakdown?.user_info;
  const rolePerms = breakdown?.role_permissions || [];
  const userGrants = breakdown?.user_grants || [];
  const userDenies = breakdown?.user_denies || [];
  const effectivePerms = breakdown?.effective_permissions || [];
  const rolesText = (info?.system_roles || []).join(", ") || "User";

  return (
    <AppShell activeKey="effective-permissions" pageClassName="page-effective-permissions">
      <main className="page">
        <Breadcrumb trail={["Effective Permissions"]} />
        <div className="page-header">
          <div>
            <h1>Effective Permissions Inspector</h1>
            <div className="page-subtitle">
              Read-only audit view explaining exact permission sources across Assigned System
              Roles and Individual User Overrides.
            </div>
          </div>
        </div>
        <Banner error={error} />

        <div className="info-card" style={{ borderLeft: "4px solid var(--color-primary, #3182ce)" }}>
          <label
            style={{
              display: "block",
              fontSize: "13px",
              fontWeight: 600,
              marginBottom: "6px",
              color: "#334155",
            }}
          >
            Select User Account to Inspect:
          </label>
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            style={{
              width: "100%",
              maxWidth: "540px",
              padding: "10px",
              border: "1px solid #cbd5e0",
              borderRadius: "6px",
              fontSize: "14px",
            }}
          >
            <option value="">Select User...</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {`${u.username} (${u.email}) - Status: ${u.status}`}
              </option>
            ))}
          </select>
        </div>

        {status === "idle" && (
          <p className="muted">Select a user account above to view their effective access report.</p>
        )}
        {status === "loading" && (
          <p className="muted">Calculating effective permissions and tracing sources...</p>
        )}
        {status === "ready" && !info && (
          <p className="muted">No access data available for selected user.</p>
        )}

        {status === "ready" && info && (
          <>
            <div className="info-card">
              <div className="section-header-title">👤 User Information</div>
              <div className="info-grid">
                <InfoItem label="Employee Name" value={info.employee_name} />
                <InfoItem label="Username" value={info.username} />
                <InfoItem label="Department" value={info.department} />
                <InfoItem label="Designation" value={info.designation} />
                <InfoItem label="Assigned Role(s)" value={rolesText} />
                <InfoItem
                  label="Account Status"
                  value={
                    <span
                      className={`badge ${
                        info.status === "ACTIVE" ? "badge-success" : "badge-warning"
                      }`}
                    >
                      {info.status}
                    </span>
                  }
                />
              </div>
            </div>

            <div className="info-card">
              <div className="section-header-title">
                <span>🛡️ Role Permissions ({rolePerms.length})</span>
                <span
                  style={{ fontSize: "12px", fontWeight: "normal", color: "var(--color-muted)" }}
                >
                  Inherited across assigned System &amp; Custom Roles
                </span>
              </div>
              <div>
                {rolePerms.length ? (
                  rolePerms.map((c) => (
                    <span className="chip chip-role" key={c}>
                      {c}
                    </span>
                  ))
                ) : (
                  <p className="muted" style={{ fontSize: "13px" }}>
                    No permissions inherited from assigned roles.
                  </p>
                )}
              </div>
            </div>

            <div className="info-card">
              <div className="section-header-title">⚡ Individual User Permission Overrides</div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "16px",
                  marginTop: "8px",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "#166534",
                      marginBottom: "6px",
                    }}
                  >
                    Extra Granted Permissions ({userGrants.length})
                  </div>
                  <div>
                    {userGrants.length ? (
                      userGrants.map((c) => (
                        <span className="chip chip-grant" key={c}>
                          ✓ GRANT: {c}
                        </span>
                      ))
                    ) : (
                      <span className="muted" style={{ fontSize: "13px" }}>
                        None
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: "12px",
                      fontWeight: 700,
                      color: "#991b1b",
                      marginBottom: "6px",
                    }}
                  >
                    Extra Revoked Permissions ({userDenies.length})
                  </div>
                  <div>
                    {userDenies.length ? (
                      userDenies.map((c) => (
                        <span className="chip chip-deny" key={c}>
                          ✗ DENY: {c}
                        </span>
                      ))
                    ) : (
                      <span className="muted" style={{ fontSize: "13px" }}>
                        None
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="info-card">
              <div className="section-header-title">
                <span>🔑 Final Calculated Effective Permissions ({effectivePerms.length})</span>
                <span
                  style={{ fontSize: "12px", fontWeight: "normal", color: "var(--color-muted)" }}
                >
                  Exact permission set authorized by backend
                </span>
              </div>
              <div style={{ marginTop: "8px" }}>
                {effectivePerms.length ? (
                  effectivePerms.map((c) => (
                    <span className="chip chip-effective" key={c}>
                      {c}
                    </span>
                  ))
                ) : (
                  <p className="muted" style={{ fontSize: "13px" }}>
                    No permissions authorized for this user account.
                  </p>
                )}
              </div>
            </div>

            <div className="info-card">
              <div className="section-header-title">🔍 Debug &amp; Permission Tracing Log</div>
              <div className="filter-bar">
                <input
                  type="text"
                  placeholder="Search permission code or module..."
                  style={{ flex: 1, maxWidth: "320px" }}
                  value={tableSearch}
                  onChange={(e) => {
                    setTablePage(1);
                    setTableSearch(e.target.value);
                  }}
                />
                <select
                  style={{ maxWidth: "200px" }}
                  value={moduleFilter}
                  onChange={(e) => {
                    setTablePage(1);
                    setModuleFilter(e.target.value);
                  }}
                >
                  <option value="">All Modules</option>
                  {modules.map((m) => (
                    <option key={m} value={m}>
                      {m.toUpperCase()}
                    </option>
                  ))}
                </select>
                <select
                  style={{ maxWidth: "200px" }}
                  value={sourceFilter}
                  onChange={(e) => {
                    setTablePage(1);
                    setSourceFilter(e.target.value);
                  }}
                >
                  <option value="">All Permission Sources</option>
                  <option value="System Role">System Role</option>
                  <option value="Individual User">Individual User</option>
                  <option value="Super Administrator">Super Administrator</option>
                </select>
              </div>

              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ width: "40px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={pageItems.length > 0 && pageItems.every((item) => selectedIds.includes(item.code))}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedIds(pageItems.map((item) => item.code));
                          else setSelectedIds([]);
                        }}
                        style={{ cursor: "pointer", width: "16px", height: "16px" }}
                      />
                    </th>
                    <th>Permission Code</th>
                    <th>Module</th>
                    <th>Inherited Role(s)</th>
                    <th>Override Status</th>
                    <th>Calculated Source</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="muted" style={{ textAlign: "center" }}>
                        No permissions found.
                      </td>
                    </tr>
                  ) : (
                    pageItems.map((item) => (
                      <tr key={item.code}>
                        <td style={{ width: "40px", textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={selectedIds.includes(item.code)}
                            onChange={(e) => {
                              if (e.target.checked) setSelectedIds((prev) => [...prev, item.code]);
                              else setSelectedIds((prev) => prev.filter((i) => i !== item.code));
                            }}
                            style={{ cursor: "pointer", width: "16px", height: "16px" }}
                          />
                        </td>
                        <td>
                          <strong style={{ fontFamily: "monospace", color: "#0f172a" }}>
                            {item.code}
                          </strong>
                        </td>
                        <td>
                          <span
                            className="badge badge-neutral"
                            style={{ textTransform: "capitalize" }}
                          >
                            {item.module}
                          </span>
                        </td>
                        <td>{(item.role_names || []).join(", ") || "—"}</td>
                        <td>
                          {item.override_type === "Granted" ? (
                            <span className="badge badge-success">✓ Granted</span>
                          ) : item.override_type === "Revoked" ? (
                            <span className="badge badge-danger">✗ Revoked</span>
                          ) : (
                            <span className="badge badge-neutral">None</span>
                          )}
                        </td>
                        <td>
                          <span className={`source-badge ${sourceBadgeClass(item.source)}`}>
                            {item.source}
                          </span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <div style={{ marginTop: "16px" }}>
                <Pagination
                  pagination={{
                    total_items: filtered.length,
                    total_records: filtered.length,
                    total_pages: Math.ceil(filtered.length / PAGE_SIZE) || 1,
                    current_page: tablePage,
                    page_size: PAGE_SIZE,
                  }}
                  pageSize={PAGE_SIZE}
                  onPageChange={setTablePage}
                />
              </div>
            </div>
          </>
        )}
      </main>
    </AppShell>
  );
}
