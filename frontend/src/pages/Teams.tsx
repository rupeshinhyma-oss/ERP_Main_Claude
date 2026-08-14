/**
 * Teams. Ported from teams.html + teams.js.
 *
 * Merges the previously-separate Departments/Designations/Users pages into one
 * page with a sub-tab bar. Users is the default landing tab, since "Add Member"
 * -- the page's primary action -- creates a login-capable User + linked
 * Employee in a single POST /members call. Departments and Designations keep
 * their inline create/edit form card; Users stays a list-only view, with full
 * account management living on the Users page.
 *
 * The Add Member flow is deliberately two-step: save, then show the created
 * record together with the password that was set, then confirm. The create
 * response never echoes the password back, so the value typed into the form is
 * carried through to the confirmation step directly.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, Modal, StatusBadge, TableMessageRow, dash } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, toQueryString } from "@/lib/api";
import { useAuth, usePendingGuard, useSrNoJump, isSrNoQuery } from "@/lib/hooks";
import type {
  Department,
  Designation,
  ItemsPage,
  PaginationMeta,
  Role,
  TeamMember,
  User,
} from "@/types";

type TabId = "employees" | "departments" | "designations";

const EMPTY_DEPT = {
  id: "",
  code: "",
  name: "",
  description: "",
  parent_department_id: "",
  manager_id: "",
  status: "active",
};

const EMPTY_DESIG = {
  id: "",
  code: "",
  title: "",
  level: "",
  description: "",
  status: "active",
};

const EMPTY_MEMBER = {
  full_name: "",
  email: "",
  password: "",
  department_id: "",
  designation_id: "",
  role_id: "",
};

/** Employee status colours: only ACTIVE is green; exits and holds read muted. */
function empStatusBadgeClass(status?: string): string {
  if (status === "ACTIVE") return "badge-active";
  if (
    status === "INACTIVE" ||
    status === "SUSPENDED" ||
    status === "TERMINATED" ||
    status === "RESIGNED"
  ) {
    return "badge-inactive";
  }
  return "badge-neutral";
}

/** A password input with a show/hide eye toggle. */
function PasswordField({
  id,
  label,
  value,
  onChange,
  hint,
}: {
  id: string;
  label: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
  hint?: React.ReactNode;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          id={id}
          type={visible ? "text" : "password"}
          required
          maxLength={255}
          autoComplete="new-password"
          style={{ paddingRight: "40px", width: "100%" }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="eye-toggle-btn"
          title={visible ? "Hide password" : "Show password"}
          style={{ position: "absolute", right: "6px", top: "50%", transform: "translateY(-50%)" }}
          onClick={() => setVisible((v) => !v)}
        >
          👁
        </button>
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

const PASSWORD_HINT =
  "Min 10 characters, with uppercase, lowercase, a digit, and a special character.";

export function TeamsPage() {
  const { hasPermission } = useAuth();
  const canManagePasswords = hasPermission("settings.manage");

  const [tab, setTab] = useState<TabId>("employees");
  const [error, setError] = useState<unknown>(null);

  // Phase 7: double-submit guards. Row-level deletes (department/designation)
  // share one keyed guard so clicking Delete on one row never disables an
  // unrelated row; each form below gets its own simple boolean since there's
  // only ever one instance of each open at a time.
  const { isPending: isRowActionPending, guard: guardRowAction } = usePendingGuard<string>();
  const [deptSubmitting, setDeptSubmitting] = useState(false);
  const [desigSubmitting, setDesigSubmitting] = useState(false);
  const [memberSubmitting, setMemberSubmitting] = useState(false);
  const [resetSubmitting, setResetSubmitting] = useState(false);

  /* Shared lookups */
  const [departments, setDepartments] = useState<Department[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);

  const departmentName = (id?: string | null) =>
    departments.find((d) => d.id === id)?.name ?? "—";
  const designationTitle = (id?: string | null) => {
    const d = designations.find((x) => x.id === id);
    return d ? d.title || d.name || "—" : "—";
  };
  const employeeName = (id?: string | null) => {
    const e = users.find((x) => x.id === id);
    return e ? e.full_name || e.display_name || e.username : "—";
  };

  const loadSharedLookups = useCallback(async () => {
    try {
      const [deptRes, desigRes, userRes, rolesRes] = await Promise.all([
        apiGet<Department[]>("/departments" + toQueryString({ page: 1, page_size: 100, sort_order: "asc" })),
        apiGet<Designation[]>("/designations" + toQueryString({ page: 1, page_size: 100, sort_order: "asc" })),
        apiGet<ItemsPage<User>>("/users" + toQueryString({ page: 1, page_size: 100 })),
        apiGet<Role[]>("/rbac/roles"),
      ]);
      setDepartments(deptRes.data || []);
      setDesignations(desigRes.data || []);
      setUsers(userRes.data?.items || []);
      setRoles(rolesRes.data || []);
    } catch {
      /* filters/dropdowns degrade gracefully without lookups */
    }
  }, []);

  useEffect(() => {
    void loadSharedLookups();
  }, [loadSharedLookups]);

  /* ================= Users tab ================= */
  const [empRows, setEmpRows] = useState<User[]>([]);
  // Row checkboxes + select-all -- no bulk action reads this selection yet,
  // matching the source's chrome-only checkbox columns.
  const [empSelectedIds, setEmpSelectedIds] = useState<Set<string>>(new Set());
  const [empPagination, setEmpPagination] = useState<PaginationMeta | undefined>();
  const [empLoading, setEmpLoading] = useState(true);
  const [empPage, setEmpPage] = useState(1);
  const [empPageSize, setEmpPageSize] = useState(50);
  const [empSearchInput, setEmpSearchInput] = useState("");
  const [empQuery, setEmpQuery] = useState("");
  const [empDeptFilter, setEmpDeptFilter] = useState("");
  const [empDesigFilter, setEmpDesigFilter] = useState("");
  const [empStatusFilter, setEmpStatusFilter] = useState("");
  const [empReload, setEmpReload] = useState(0);
  const empJump = useSrNoJump();
  const empBodyRef = useRef<HTMLTableSectionElement>(null);

  // A bare integer means "jump to Sr. No. N", not a text search.
  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = empSearchInput.trim();
      if (raw && isSrNoQuery(raw)) {
        const srNo = parseInt(raw, 10);
        if (srNo >= 1) {
          setEmpPage(Math.ceil(srNo / empPageSize));
          setEmpQuery("");
          empJump.request(srNo);
          return;
        }
      }
      empJump.clear();
      setEmpPage(1);
      setEmpQuery(raw);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empSearchInput, empPageSize]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setEmpLoading(true);
      try {
        const { data, meta } = await apiGet<ItemsPage<User>>(
          "/users" +
          toQueryString({
            page: empPage,
            page_size: empPageSize,
            query: empQuery,
            department_id: empDeptFilter,
            designation_id: empDesigFilter,
            status: empStatusFilter,
          })
        );
        if (cancelled) return;
        setEmpRows(data?.items || []);
        setEmpPagination(meta?.pagination);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setEmpLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [empPage, empPageSize, empQuery, empDeptFilter, empDesigFilter, empStatusFilter, empReload]);

  useEffect(() => {
    if (!empLoading) empJump.applyTo(empBodyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [empLoading, empRows]);

  /* ================= Departments tab ================= */
  const [deptRows, setDeptRows] = useState<Department[]>([]);
  const [deptSelectedIds, setDeptSelectedIds] = useState<Set<string>>(new Set());
  const [deptPagination, setDeptPagination] = useState<PaginationMeta | undefined>();
  const [deptLoading, setDeptLoading] = useState(true);
  const [deptPage, setDeptPage] = useState(1);
  const [deptPageSize, setDeptPageSize] = useState(50);
  const [deptSearchInput, setDeptSearchInput] = useState("");
  const [deptSearch, setDeptSearch] = useState("");
  const [deptStatusFilter, setDeptStatusFilter] = useState("");
  const [deptReload, setDeptReload] = useState(0);
  const [deptFormOpen, setDeptFormOpen] = useState(false);
  const [deptForm, setDeptForm] = useState(EMPTY_DEPT);
  const deptJump = useSrNoJump();
  const deptBodyRef = useRef<HTMLTableSectionElement>(null);
  const deptFormRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = deptSearchInput.trim();
      if (raw && isSrNoQuery(raw)) {
        const srNo = parseInt(raw, 10);
        if (srNo >= 1) {
          setDeptPage(Math.ceil(srNo / deptPageSize));
          setDeptSearch("");
          deptJump.request(srNo);
          return;
        }
      }
      deptJump.clear();
      setDeptPage(1);
      setDeptSearch(raw);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptSearchInput, deptPageSize]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDeptLoading(true);
      try {
        const { data, meta } = await apiGet<Department[]>(
          "/departments" +
          toQueryString({
            page: deptPage,
            page_size: deptPageSize,
            sort_order: "asc",
            search: deptSearch,
            status: deptStatusFilter,
          })
        );
        if (cancelled) return;
        setDeptRows(data || []);
        setDeptPagination(meta?.pagination);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setDeptLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deptPage, deptPageSize, deptSearch, deptStatusFilter, deptReload]);

  useEffect(() => {
    if (!deptLoading) deptJump.applyTo(deptBodyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deptLoading, deptRows]);

  function openDeptForm(d: Department | null) {
    setDeptForm(
      d
        ? {
          id: d.id,
          code: d.code,
          name: d.name,
          description: d.description || "",
          parent_department_id: d.parent_department_id || "",
          manager_id: d.manager_id || "",
          status: d.status,
        }
        : EMPTY_DEPT
    );
    setDeptFormOpen(true);
    requestAnimationFrame(() => {
      deptFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function handleDeptSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (deptSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setError(null);
    const payload = {
      code: deptForm.code.trim(),
      name: deptForm.name.trim(),
      description: deptForm.description.trim() || null,
      parent_department_id: deptForm.parent_department_id || null,
      manager_id: deptForm.manager_id || null,
      status: deptForm.status,
    };
    setDeptSubmitting(true);
    try {
      if (deptForm.id) await apiPatch(`/departments/${deptForm.id}`, payload);
      else await apiPost("/departments", payload);
      setDeptFormOpen(false);
      await loadSharedLookups();
      setDeptReload((n) => n + 1);
    } catch (err) {
      setError(err);
    } finally {
      setDeptSubmitting(false);
    }
  }

  async function handleDeptEdit(id: string) {
    try {
      const { data } = await apiGet<Department>(`/departments/${id}`);
      openDeptForm(data);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeptDelete(id: string) {
    if (!confirm("Delete this department? This cannot be undone.")) return;
    await guardRowAction(`delete-dept:${id}`, async () => {
      try {
        await apiDelete(`/departments/${id}`);
        setDeptReload((n) => n + 1);
      } catch (err) {
        setError(err);
      }
    });
  }

  /* ================= Designations tab ================= */
  const [desigRows, setDesigRows] = useState<Designation[]>([]);
  const [desigSelectedIds, setDesigSelectedIds] = useState<Set<string>>(new Set());
  const [desigPagination, setDesigPagination] = useState<PaginationMeta | undefined>();
  const [desigLoading, setDesigLoading] = useState(true);
  const [desigPage, setDesigPage] = useState(1);
  const [desigPageSize, setDesigPageSize] = useState(50);
  const [desigSearchInput, setDesigSearchInput] = useState("");
  const [desigSearch, setDesigSearch] = useState("");
  const [desigStatusFilter, setDesigStatusFilter] = useState("");
  const [desigReload, setDesigReload] = useState(0);
  const [desigFormOpen, setDesigFormOpen] = useState(false);
  const [desigForm, setDesigForm] = useState(EMPTY_DESIG);
  const desigJump = useSrNoJump();
  const desigBodyRef = useRef<HTMLTableSectionElement>(null);
  const desigFormRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = desigSearchInput.trim();
      if (raw && isSrNoQuery(raw)) {
        const srNo = parseInt(raw, 10);
        if (srNo >= 1) {
          setDesigPage(Math.ceil(srNo / desigPageSize));
          setDesigSearch("");
          desigJump.request(srNo);
          return;
        }
      }
      desigJump.clear();
      setDesigPage(1);
      setDesigSearch(raw);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desigSearchInput, desigPageSize]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setDesigLoading(true);
      try {
        const { data, meta } = await apiGet<Designation[]>(
          "/designations" +
          toQueryString({
            page: desigPage,
            page_size: desigPageSize,
            sort_order: "asc",
            search: desigSearch,
            status: desigStatusFilter,
          })
        );
        if (cancelled) return;
        setDesigRows(data || []);
        setDesigPagination(meta?.pagination);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setDesigLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [desigPage, desigPageSize, desigSearch, desigStatusFilter, desigReload]);

  useEffect(() => {
    if (!desigLoading) desigJump.applyTo(desigBodyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desigLoading, desigRows]);

  function openDesigForm(d: Designation | null) {
    setDesigForm(
      d
        ? {
          id: d.id,
          code: d.code,
          title: d.title,
          level: d.level !== null && d.level !== undefined ? String(d.level) : "",
          description: d.description || "",
          status: d.status,
        }
        : EMPTY_DESIG
    );
    setDesigFormOpen(true);
    requestAnimationFrame(() => {
      desigFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  async function handleDesigSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (desigSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setError(null);
    const payload = {
      code: desigForm.code.trim(),
      title: desigForm.title.trim(),
      description: desigForm.description.trim() || null,
      level: desigForm.level === "" ? null : Number(desigForm.level),
      status: desigForm.status,
    };
    setDesigSubmitting(true);
    try {
      if (desigForm.id) await apiPatch(`/designations/${desigForm.id}`, payload);
      else await apiPost("/designations", payload);
      setDesigFormOpen(false);
      await loadSharedLookups();
      setDesigReload((n) => n + 1);
    } catch (err) {
      setError(err);
    } finally {
      setDesigSubmitting(false);
    }
  }

  async function handleDesigEdit(id: string) {
    try {
      const { data } = await apiGet<Designation>(`/designations/${id}`);
      openDesigForm(data);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDesigDelete(id: string) {
    if (!confirm("Delete this designation? This cannot be undone.")) return;
    await guardRowAction(`delete-desig:${id}`, async () => {
      try {
        await apiDelete(`/designations/${id}`);
        setDesigReload((n) => n + 1);
      } catch (err) {
        setError(err);
      }
    });
  }

  /* ================= Add Member modal ================= */
  const [memberOpen, setMemberOpen] = useState(false);
  const [memberForm, setMemberForm] = useState(EMPTY_MEMBER);
  const [memberError, setMemberError] = useState<unknown>(null);
  const [createdMember, setCreatedMember] = useState<(TeamMember & { password: string }) | null>(
    null
  );

  function openMemberModal() {
    setMemberForm(EMPTY_MEMBER);
    setMemberError(null);
    setCreatedMember(null);
    setMemberOpen(true);
  }

  async function handleMemberSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (memberSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setMemberError(null);
    const password = memberForm.password;
    setMemberSubmitting(true);
    try {
      const { data } = await apiPost<TeamMember>("/members", {
        full_name: memberForm.full_name.trim(),
        email: memberForm.email.trim(),
        password,
        department_id: memberForm.department_id || null,
        designation_id: memberForm.designation_id || null,
        role_id: memberForm.role_id || null,
      });
      // The create response never echoes the password back, so carry the value
      // the admin just typed through to the confirmation step.
      setCreatedMember({ ...data, password });
    } catch (err) {
      setMemberError(err);
    } finally {
      setMemberSubmitting(false);
    }
  }

  /* ================= Password reset modal ================= */
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [resetError, setResetError] = useState<unknown>(null);

  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (resetSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setResetError(null);
    if (!resetUserId) return;
    setResetSubmitting(true);
    try {
      await apiPatch(`/members/${resetUserId}/password`, { password: resetPassword });
      setResetUserId(null);
      setResetPassword("");
      setEmpReload((n) => n + 1);
    } catch (err) {
      setResetError(err);
    } finally {
      setResetSubmitting(false);
    }
  }

  const empStartSrNo = (empPage - 1) * empPageSize + 1;
  const deptStartSrNo = (deptPage - 1) * deptPageSize + 1;
  const desigStartSrNo = (desigPage - 1) * desigPageSize + 1;

  return (
    <AppShell activeKey="teams" pageClassName="page-teams">
      <main className="page">
        <Breadcrumb trail={["Teams"]} />
        <div className="page-header">
          <div>
            <h1>Teams</h1>
            <div className="page-subtitle">
              User profiles, departments, and designations for your organization.
            </div>
          </div>
          <div className="page-header-actions">
            {/* Creating a member creates both a User and an Employee. */}
            {hasPermission("user.create") && hasPermission("employee.create") && (
              <button className="btn btn-primary" onClick={openMemberModal}>
                + Add Member
              </button>
            )}
          </div>
        </div>
        <Banner error={error} />

        <div className="subtab-bar">
          <Can permission="user.read">
            <button
              type="button"
              className={`subtab-btn ${tab === "employees" ? "active" : ""}`}
              onClick={() => setTab("employees")}
            >
              Users
            </button>
          </Can>
          <Can permission="department.read">
            <button
              type="button"
              className={`subtab-btn ${tab === "departments" ? "active" : ""}`}
              onClick={() => setTab("departments")}
            >
              Departments
            </button>
          </Can>
          <Can permission="designation.read">
            <button
              type="button"
              className={`subtab-btn ${tab === "designations" ? "active" : ""}`}
              onClick={() => setTab("designations")}
            >
              Designations
            </button>
          </Can>
        </div>

        {/* ============ USERS TAB ============ */}
        <div className={`subtab-panel ${tab === "employees" ? "active" : ""}`}>
          <div className="card">
            <div className="toolbar">
              <input
                type="text"
                placeholder="Search name, code, email, phone, or Sr. No..."
                value={empSearchInput}
                onChange={(e) => setEmpSearchInput(e.target.value)}
              />
              <select
                value={empDeptFilter}
                onChange={(e) => {
                  setEmpPage(1);
                  setEmpDeptFilter(e.target.value);
                }}
              >
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select
                value={empDesigFilter}
                onChange={(e) => {
                  setEmpPage(1);
                  setEmpDesigFilter(e.target.value);
                }}
              >
                <option value="">All designations</option>
                {designations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
              <select
                value={empStatusFilter}
                onChange={(e) => {
                  setEmpPage(1);
                  setEmpStatusFilter(e.target.value);
                }}
              >
                <option value="">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="ON_LEAVE">On leave</option>
                <option value="TERMINATED">Terminated</option>
                <option value="RESIGNED">Resigned</option>
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "40px" }}>
                      <input
                        type="checkbox"
                        className="select-all-checkbox"
                        checked={empRows.length > 0 && empSelectedIds.size === empRows.length}
                        onChange={(e) => {
                          setEmpSelectedIds(
                            e.target.checked ? new Set(empRows.map((u) => u.id)) : new Set()
                          );
                        }}
                      />
                    </th>
                    <th>Sr. No.</th>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Department</th>
                    <th>Designation</th>
                    <th>Status</th>
                    <th>Password</th>
                    <th />
                  </tr>
                </thead>
                <tbody ref={empBodyRef}>
                  {empLoading ? (
                    <TableMessageRow colSpan={9}>Loading...</TableMessageRow>
                  ) : empRows.length === 0 ? (
                    <TableMessageRow colSpan={9}>No user accounts found.</TableMessageRow>
                  ) : (
                    empRows.map((u, index) => (
                      <tr key={u.id}>
                        <td className="cell-checkbox" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="row-checkbox"
                            checked={empSelectedIds.has(u.id)}
                            onChange={(e) => {
                              setEmpSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(u.id);
                                else next.delete(u.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="cell-srno">{empStartSrNo + index}</td>
                        <td>{dash(u.employee_code)}</td>
                        <td>
                          <Link to="/users">
                            {u.full_name || u.display_name || u.username}
                          </Link>
                        </td>
                        <td>
                          {u.department_id
                            ? departmentName(u.department_id)
                            : dash(u.department_name)}
                        </td>
                        <td>
                          {u.designation_id
                            ? designationTitle(u.designation_id)
                            : dash(u.designation_name)}
                        </td>
                        <td>
                          <span className={`badge ${empStatusBadgeClass(u.status)}`}>
                            {u.status}
                          </span>
                        </td>
                        <td>
                          {canManagePasswords && u.id ? (
                            <div className="password-cell">
                              <span className="password-dots">••••••••</span>
                              <button
                                type="button"
                                className="btn btn-small"
                                onClick={() => {
                                  setResetUserId(u.id);
                                  setResetPassword("");
                                  setResetError(null);
                                }}
                              >
                                Reset
                              </button>
                            </div>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="actions">
                          <Link className="btn btn-small" to="/users">
                            Manage
                          </Link>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <Pagination
                pagination={empPagination}
                pageSize={empPageSize}
                onPageChange={setEmpPage}
                onPageSizeChange={(size) => {
                  setEmpPageSize(size);
                  setEmpPage(1);
                }}
              />
            </div>
          </div>
        </div>

        {/* ============ DEPARTMENTS TAB ============ */}
        <div className={`subtab-panel ${tab === "departments" ? "active" : ""}`}>
          <div
            className="page-header-actions"
            style={{ justifyContent: "flex-end", marginBottom: "var(--space-3)" }}
          >
            <Can permission="department.create">
              <button className="btn btn-primary" onClick={() => openDeptForm(null)}>
                + New Department
              </button>
            </Can>
          </div>
          {deptFormOpen && (
            <div className="card" ref={deptFormRef}>
              <div className="section-title" style={{ marginTop: 0 }}>
                {deptForm.id ? "Edit department" : "New department"}
              </div>
              <form onSubmit={handleDeptSubmit}>
                <div className="form-grid">
                  <TextField id="dept_code" label="Code *" required maxLength={50} value={deptForm.code} onChange={(v) => setDeptForm((f) => ({ ...f, code: v }))} />
                  <TextField id="dept_name" label="Name *" required maxLength={150} value={deptForm.name} onChange={(v) => setDeptForm((f) => ({ ...f, name: v }))} />
                  <SelectField id="parent_department_id" label="Parent department" value={deptForm.parent_department_id} onChange={(v) => setDeptForm((f) => ({ ...f, parent_department_id: v }))}>
                    <option value="">— None —</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {`${d.code} — ${d.name}`}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField id="manager_id" label="Manager" value={deptForm.manager_id} onChange={(v) => setDeptForm((f) => ({ ...f, manager_id: v }))}>
                    <option value="">— None —</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {`${u.display_name} (${u.employee_code})`}
                      </option>
                    ))}
                  </SelectField>
                  <SelectField id="dept_status" label="Status" value={deptForm.status} onChange={(v) => setDeptForm((f) => ({ ...f, status: v }))}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </SelectField>
                </div>
                <TextAreaField id="dept_description" label="Description" value={deptForm.description} onChange={(v) => setDeptForm((f) => ({ ...f, description: v }))} />
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={deptSubmitting}>
                    {deptSubmitting ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="btn" onClick={() => setDeptFormOpen(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
          <div className="card">
            <div className="toolbar">
              <input
                type="text"
                placeholder="Search code or name or Sr. No..."
                value={deptSearchInput}
                onChange={(e) => setDeptSearchInput(e.target.value)}
              />
              <select
                value={deptStatusFilter}
                onChange={(e) => {
                  setDeptPage(1);
                  setDeptStatusFilter(e.target.value);
                }}
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "40px" }}>
                      <input
                        type="checkbox"
                        className="select-all-checkbox"
                        checked={deptRows.length > 0 && deptSelectedIds.size === deptRows.length}
                        onChange={(e) => {
                          setDeptSelectedIds(
                            e.target.checked ? new Set(deptRows.map((d) => d.id)) : new Set()
                          );
                        }}
                      />
                    </th>
                    <th>Sr. No.</th>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Parent</th>
                    <th>Manager</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody ref={deptBodyRef}>
                  {deptLoading ? (
                    <TableMessageRow colSpan={8}>Loading...</TableMessageRow>
                  ) : deptRows.length === 0 ? (
                    <TableMessageRow colSpan={8}>No departments found.</TableMessageRow>
                  ) : (
                    deptRows.map((d, index) => (
                      <tr key={d.id}>
                        <td className="cell-checkbox" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="row-checkbox"
                            checked={deptSelectedIds.has(d.id)}
                            onChange={(e) => {
                              setDeptSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(d.id);
                                else next.delete(d.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="cell-srno">{deptStartSrNo + index}</td>
                        <td>{d.code}</td>
                        <td>{d.name}</td>
                        <td>{d.parent_department_id ? departmentName(d.parent_department_id) : "—"}</td>
                        <td>{d.manager_id ? employeeName(d.manager_id) : "—"}</td>
                        <td>
                          <StatusBadge status={d.status} />
                        </td>
                        <td className="actions">
                          <Can permission="department.update">
                            <button className="btn btn-small" onClick={() => handleDeptEdit(d.id)}>
                              Edit
                            </button>
                          </Can>
                          <Can permission="department.delete">
                            <button
                              className="btn btn-small btn-danger"
                              disabled={isRowActionPending(`delete-dept:${d.id}`)}
                              onClick={() => handleDeptDelete(d.id)}
                            >
                              {isRowActionPending(`delete-dept:${d.id}`) ? "Deleting…" : "Delete"}
                            </button>
                          </Can>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <Pagination
                pagination={deptPagination}
                pageSize={deptPageSize}
                onPageChange={setDeptPage}
                onPageSizeChange={(size) => {
                  setDeptPageSize(size);
                  setDeptPage(1);
                }}
              />
            </div>
          </div>
        </div>

        {/* ============ DESIGNATIONS TAB ============ */}
        <div className={`subtab-panel ${tab === "designations" ? "active" : ""}`}>
          <div
            className="page-header-actions"
            style={{ justifyContent: "flex-end", marginBottom: "var(--space-3)" }}
          >
            <Can permission="designation.create">
              <button className="btn btn-primary" onClick={() => openDesigForm(null)}>
                + New Designation
              </button>
            </Can>
          </div>
          {desigFormOpen && (
            <div className="card" ref={desigFormRef}>
              <div className="section-title" style={{ marginTop: 0 }}>
                {desigForm.id ? "Edit designation" : "New designation"}
              </div>
              <form onSubmit={handleDesigSubmit}>
                <div className="form-grid">
                  <TextField id="desig_code" label="Code *" required maxLength={50} value={desigForm.code} onChange={(v) => setDesigForm((f) => ({ ...f, code: v }))} />
                  <TextField id="desig_title" label="Title *" required maxLength={150} value={desigForm.title} onChange={(v) => setDesigForm((f) => ({ ...f, title: v }))} />
                  <TextField id="desig_level" label="Level" type="number" min={0} max={100} value={desigForm.level} onChange={(v) => setDesigForm((f) => ({ ...f, level: v }))} />
                  <SelectField id="desig_status" label="Status" value={desigForm.status} onChange={(v) => setDesigForm((f) => ({ ...f, status: v }))}>
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </SelectField>
                </div>
                <TextAreaField id="desig_description" label="Description" value={desigForm.description} onChange={(v) => setDesigForm((f) => ({ ...f, description: v }))} />
                <div className="form-actions">
                  <button type="submit" className="btn btn-primary" disabled={desigSubmitting}>
                    {desigSubmitting ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className="btn" onClick={() => setDesigFormOpen(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          )}
          <div className="card">
            <div className="toolbar">
              <input
                type="text"
                placeholder="Search code or title or Sr. No..."
                value={desigSearchInput}
                onChange={(e) => setDesigSearchInput(e.target.value)}
              />
              <select
                value={desigStatusFilter}
                onChange={(e) => {
                  setDesigPage(1);
                  setDesigStatusFilter(e.target.value);
                }}
              >
                <option value="">All statuses</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "40px" }}>
                      <input
                        type="checkbox"
                        className="select-all-checkbox"
                        checked={desigRows.length > 0 && desigSelectedIds.size === desigRows.length}
                        onChange={(e) => {
                          setDesigSelectedIds(
                            e.target.checked ? new Set(desigRows.map((d) => d.id)) : new Set()
                          );
                        }}
                      />
                    </th>
                    <th>Sr. No.</th>
                    <th>Code</th>
                    <th>Title</th>
                    <th>Level</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody ref={desigBodyRef}>
                  {desigLoading ? (
                    <TableMessageRow colSpan={7}>Loading...</TableMessageRow>
                  ) : desigRows.length === 0 ? (
                    <TableMessageRow colSpan={7}>No designations found.</TableMessageRow>
                  ) : (
                    desigRows.map((d, index) => (
                      <tr key={d.id}>
                        <td className="cell-checkbox" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="row-checkbox"
                            checked={desigSelectedIds.has(d.id)}
                            onChange={(e) => {
                              setDesigSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(d.id);
                                else next.delete(d.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td className="cell-srno">{desigStartSrNo + index}</td>
                        <td>{d.code}</td>
                        <td>{d.title}</td>
                        <td>{d.level ?? "—"}</td>
                        <td>
                          <StatusBadge status={d.status} />
                        </td>
                        <td className="actions">
                          <Can permission="designation.update">
                            <button className="btn btn-small" onClick={() => handleDesigEdit(d.id)}>
                              Edit
                            </button>
                          </Can>
                          <Can permission="designation.delete">
                            <button
                              className="btn btn-small btn-danger"
                              disabled={isRowActionPending(`delete-desig:${d.id}`)}
                              onClick={() => handleDesigDelete(d.id)}
                            >
                              {isRowActionPending(`delete-desig:${d.id}`) ? "Deleting…" : "Delete"}
                            </button>
                          </Can>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <Pagination
                pagination={desigPagination}
                pageSize={desigPageSize}
                onPageChange={setDesigPage}
                onPageSizeChange={(size) => {
                  setDesigPageSize(size);
                  setDesigPage(1);
                }}
              />
            </div>
          </div>
        </div>
      </main>

      {/* ============ ADD MEMBER MODAL ============ */}
      <Modal
        open={memberOpen}
        title={createdMember ? "Member Added" : "Add Member"}
        onClose={() => setMemberOpen(false)}
        cardStyle={{ maxWidth: "560px" }}
      >
        {!createdMember ? (
          <div>
            <Banner error={memberError} />
            <form onSubmit={handleMemberSubmit}>
              <TextField
                id="member_full_name"
                label={
                  <>
                    Name <span style={{ color: "var(--color-danger)" }}>*</span>
                  </>
                }
                required
                maxLength={200}
                value={memberForm.full_name}
                onChange={(v) => setMemberForm((f) => ({ ...f, full_name: v }))}
              />
              <TextField
                id="member_email"
                label={
                  <>
                    Email <span style={{ color: "var(--color-danger)" }}>*</span>
                  </>
                }
                type="email"
                required
                maxLength={255}
                value={memberForm.email}
                onChange={(v) => setMemberForm((f) => ({ ...f, email: v }))}
              />
              <PasswordField
                id="member_password"
                label={
                  <>
                    Password <span style={{ color: "var(--color-danger)" }}>*</span>
                  </>
                }
                value={memberForm.password}
                onChange={(v) => setMemberForm((f) => ({ ...f, password: v }))}
                hint={PASSWORD_HINT}
              />
              <SelectField
                id="member_department_id"
                label="Department"
                value={memberForm.department_id}
                onChange={(v) => setMemberForm((f) => ({ ...f, department_id: v }))}
              >
                <option value="">— None —</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                id="member_designation_id"
                label="Designation"
                value={memberForm.designation_id}
                onChange={(v) => setMemberForm((f) => ({ ...f, designation_id: v }))}
              >
                <option value="">— None —</option>
                {designations.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </SelectField>
              <SelectField
                id="member_role_id"
                label="System Role"
                value={memberForm.role_id}
                onChange={(v) => setMemberForm((f) => ({ ...f, role_id: v }))}
              >
                <option value="">— Default (Employee) —</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name + (r.is_system ? " (System)" : "")}
                  </option>
                ))}
              </SelectField>
              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={memberSubmitting}>
                  {memberSubmitting ? "Saving…" : "Save"}
                </button>
                <button type="button" className="btn" onClick={() => setMemberOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        ) : (
          <div>
            <div className="temp-password-box">
              <div>
                <strong>Member added.</strong> This password is stored and can be viewed or reset
                later from the Employees list using the eye icon.
              </div>
              <div className="password-value">{createdMember.password}</div>
            </div>
            <div className="detail-grid">
              <div>
                <div className="label">Name</div>
                <div className="value">{createdMember.full_name}</div>
              </div>
              <div>
                <div className="label">Username</div>
                <div className="value">{createdMember.username}</div>
              </div>
              <div>
                <div className="label">Email</div>
                <div className="value">{createdMember.email}</div>
              </div>
              <div>
                <div className="label">Role</div>
                <div className="value">{createdMember.role}</div>
              </div>
              <div>
                <div className="label">Department</div>
                <div className="value">
                  {createdMember.department_id
                    ? departmentName(createdMember.department_id)
                    : "—"}
                </div>
              </div>
              <div>
                <div className="label">Designation</div>
                <div className="value">
                  {createdMember.designation_id
                    ? designationTitle(createdMember.designation_id)
                    : "—"}
                </div>
              </div>
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={async () => {
                  setMemberOpen(false);
                  await loadSharedLookups();
                  setEmpReload((n) => n + 1);
                }}
              >
                Save &amp; Close
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* ============ PASSWORD RESET MODAL ============ */}
      <Modal
        open={Boolean(resetUserId)}
        title="Reset Password"
        onClose={() => setResetUserId(null)}
        cardStyle={{ maxWidth: "440px" }}
      >
        <Banner error={resetError} />
        <form onSubmit={handleResetSubmit}>
          <PasswordField
            id="reset_password"
            label={
              <>
                New Password <span style={{ color: "var(--color-danger)" }}>*</span>
              </>
            }
            value={resetPassword}
            onChange={setResetPassword}
            hint={PASSWORD_HINT}
          />
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={resetSubmitting}>
              {resetSubmitting ? "Resetting…" : "Reset Password"}
            </button>
            <button type="button" className="btn" onClick={() => setResetUserId(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}