/**
 * User Accounts & Passwords. Ported from users.html.
 *
 * Row actions are gated twice over: by the caller's own permissions, and by
 * whether the target is a super admin (only another super admin may act on
 * one). Creating an account and resetting a password both surface a
 * server-generated temporary password exactly once, in a dedicated modal.
 */

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { ActionDropdown, type ActionDropdownEntry } from "@/components/ActionDropdown";
import { Banner, Can, Modal, TableMessageRow, dash } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { SelectField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, toQueryString } from "@/lib/api";
import { useAuth, useDebouncedValue } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { friendlyPermissionLabel, groupPermissionsByModule, MODULE_NAMES } from "@/lib/permissionLabels";
import type {
  BulkPermissionOverrideItem,
  Department,
  Designation,
  EffectivePermissionsBreakdown,
  ItemsPage,
  Permission,
  PaginationMeta,
  Role,
  User,
  UserPermissionOverride,
  UserSession,
} from "@/types";

const STATUS_OPTIONS: [string, string][] = [
  ["ACTIVE", "Active"],
  ["INACTIVE", "Inactive"],
  ["SUSPENDED", "Suspended"],
  ["LOCKED", "Locked"],
  ["PASSWORD_CHANGE_REQUIRED", "Password Change Required"],
];

function StatusBadge({ status, isActive }: { status?: string; isActive?: boolean }) {
  const s = (status || "").toUpperCase();
  if (s === "ACTIVE") return <span className="badge badge-active">Active</span>;
  if (s === "INACTIVE") return <span className="badge badge-inactive">Inactive</span>;
  if (s === "SUSPENDED") return <span className="badge badge-suspended">Suspended</span>;
  if (s === "LOCKED") return <span className="badge badge-locked">Locked</span>;
  if (s === "PASSWORD_CHANGE_REQUIRED")
    return <span className="badge badge-pwd-req">Pass Change Req</span>;
  return isActive ? (
    <span className="badge badge-active">Active</span>
  ) : (
    <span className="badge badge-inactive">Inactive</span>
  );
}

const EMPTY_CREATE = {
  first_name: "",
  last_name: "",
  username: "",
  email: "",
  employee_code: "",
  phone: "",
  department_id: "",
  designation_id: "",
  role_id: "",
};

const EMPTY_EDIT = {
  id: "",
  first_name: "",
  last_name: "",
  email: "",
  employee_code: "",
  phone: "",
  department_id: "",
  designation_id: "",
};

export function UsersPage() {
  const { hasPermission, isSuperAdmin } = useAuth();
  const showToast = useToast();

  const [rows, setRows] = useState<User[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [reloadCounter, setReloadCounter] = useState(0);
  const query = useDebouncedValue(searchInput, 300);

  const [roles, setRoles] = useState<Role[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [designations, setDesignations] = useState<Designation[]>([]);
  const [allPermissions, setAllPermissions] = useState<Permission[]>([]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState(EMPTY_EDIT);
  const [viewUser, setViewUser] = useState<User | null>(null);
  const [viewSessions, setViewSessions] = useState<UserSession[] | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [roleModalUserId, setRoleModalUserId] = useState<string | null>(null);
  const [assignRoleId, setAssignRoleId] = useState("");
  const [tempPassword, setTempPassword] = useState<string | null>(null);

  /* Per-user permission overrides modal (checkbox grid, opened from the row
     action menu) -- same bulk-diff pattern as Rbac.tsx's Individual User
     Overrides tab, duplicated here rather than shared as one component
     because the two pages open it from very different contexts (a page-level
     user picker vs. a per-row menu) and want different surrounding chrome. */
  const [overridesUserId, setOverridesUserId] = useState<string | null>(null);
  const [overridesUsername, setOverridesUsername] = useState("");
  const [overridesBreakdown, setOverridesBreakdown] =
    useState<EffectivePermissionsBreakdown | null>(null);
  const [overridesChecked, setOverridesChecked] = useState<Set<string>>(new Set());
  const [overridesSearch, setOverridesSearch] = useState("");
  const [overridesLoading, setOverridesLoading] = useState(false);
  const [overridesSaving, setOverridesSaving] = useState(false);

  // Row checkboxes + select-all -- no bulk action reads this selection yet,
  // matching the source's chrome-only checkbox column.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const reload = useCallback(() => setReloadCounter((n) => n + 1), []);

  /* --- Lookups --- */
  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiGet<Role[]>("/rbac/roles");
        setRoles(data || []);
      } catch {
        /* the role selects simply stay empty */
      }
    })();
    (async () => {
      try {
        const { data } = await apiGet<Permission[]>("/rbac/permissions");
        setAllPermissions(data || []);
      } catch {
        /* the overrides modal degrades to "no permissions found" */
      }
    })();
    (async () => {
      try {
        const [deptRes, desigRes] = await Promise.all([
          apiGet<Department[]>("/departments?page=1&page_size=100"),
          apiGet<Designation[]>("/designations?page=1&page_size=100"),
        ]);
        setDepartments(deptRes.data || []);
        setDesignations(desigRes.data || []);
      } catch {
        /* ditto for department/designation selects */
      }
    })();
  }, []);

  /* --- List --- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const url =
          "/users" +
          toQueryString({
            page: currentPage,
            page_size: pageSize,
            query,
            status: statusFilter,
          });
        const { data, meta } = await apiGet<ItemsPage<User>>(url);
        if (cancelled) return;
        setRows(data.items || []);
        setPagination(meta?.pagination);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPage, pageSize, query, statusFilter, reloadCounter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [query, statusFilter]);

  /* --- Actions --- */
  async function runAction(path: string, confirmMessage?: string, onDone?: () => void) {
    if (confirmMessage && !confirm(confirmMessage)) return;
    try {
      const { data } = await apiPost<{ revoked_sessions?: number }>(path);
      onDone?.();
      reload();
      return data;
    } catch (err) {
      setError(err);
    }
  }

  async function handleForceLogout(userId: string, username: string) {
    if (!confirm(`Force logout user '${username}' from all devices?`)) return;
    try {
      const { data } = await apiPost<{ revoked_sessions?: number }>(
        `/users/${userId}/force-logout`
      );
      alert(`Successfully revoked ${data.revoked_sessions || 0} active session(s).`);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleResetPassword(userId: string, username: string) {
    if (
      !confirm(`Reset password for user '${username}'? This will generate a new temporary password.`)
    )
      return;
    try {
      const { data } = await apiPost<{ temporary_password: string }>(
        `/users/${userId}/reset-password`
      );
      setTempPassword(data.temporary_password);
    } catch (err) {
      setError(err);
    }
  }

  async function openViewUser(userId: string) {
    setViewLoading(true);
    setViewUser(null);
    setViewSessions(null);
    try {
      const { data } = await apiGet<User>(`/users/${userId}`);
      setViewUser(data);
      try {
        const sessRes = await apiGet<UserSession[]>(`/users/${userId}/sessions`);
        setViewSessions(sessRes.data || []);
      } catch {
        setViewSessions([]);
      }
    } catch (err) {
      setError(err);
    } finally {
      setViewLoading(false);
    }
  }

  function openEditUser(user: User) {
    setEditForm({
      id: user.id,
      first_name: user.first_name || "",
      last_name: user.last_name || "",
      email: user.email || "",
      employee_code: user.employee_code || "",
      phone: user.phone || "",
      department_id: user.department_id || "",
      designation_id: user.designation_id || "",
    });
    setEditOpen(true);
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { data } = await apiPost<User>("/users", {
        first_name: createForm.first_name.trim(),
        last_name: createForm.last_name.trim(),
        username: createForm.username.trim(),
        email: createForm.email.trim(),
        employee_code: createForm.employee_code.trim() || null,
        phone: createForm.phone.trim() || null,
        department_id: createForm.department_id || null,
        designation_id: createForm.designation_id || null,
        role_ids: createForm.role_id ? [createForm.role_id] : [],
      });
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
      reload();
      if (data.temporary_password) setTempPassword(data.temporary_password);
    } catch (err) {
      setError(err);
    }
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiPatch(`/users/${editForm.id}`, {
        first_name: editForm.first_name.trim() || null,
        last_name: editForm.last_name.trim() || null,
        email: editForm.email.trim(),
        employee_code: editForm.employee_code.trim() || null,
        phone: editForm.phone.trim() || null,
        department_id: editForm.department_id || null,
        designation_id: editForm.designation_id || null,
      });
      setEditOpen(false);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleAssignRole(e: React.FormEvent) {
    e.preventDefault();
    if (!roleModalUserId) return;
    try {
      await apiPost(`/users/${roleModalUserId}/roles`, { role_id: assignRoleId });
      setRoleModalUserId(null);
      setAssignRoleId("");
      reload();
    } catch (err) {
      setError(err);
    }
  }

  /** Quick-toggle: grant/revoke the "admin" system role without opening the full Assign Role modal. */
  async function setAdminRole(userId: string, username: string) {
    if (!confirm(`Grant Administrator privileges to '${username}'?`)) return;
    try {
      const { data: allRoles } = await apiGet<Role[]>("/rbac/roles");
      const adminRole = allRoles.find((r) => r.name === "admin");
      if (!adminRole) {
        setError(new Error("Admin role not found in system."));
        return;
      }
      await apiPost(`/users/${userId}/roles`, { role_id: adminRole.id });
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function removeAdminRole(userId: string, username: string) {
    if (!confirm(`Revoke Administrator privileges from '${username}'?`)) return;
    try {
      const { data: allRoles } = await apiGet<Role[]>("/rbac/roles");
      const adminRole = allRoles.find((r) => r.name === "admin");
      if (!adminRole) {
        setError(new Error("Admin role not found in system."));
        return;
      }
      await apiDelete(`/users/${userId}/roles/${adminRole.id}`);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  /** Open the checkbox-grid permission-overrides modal for one user. */
  async function openUserOverridesModal(userId: string, username: string) {
    setOverridesUserId(userId);
    setOverridesUsername(username);
    setOverridesSearch("");
    setOverridesLoading(true);
    setOverridesBreakdown(null);
    setOverridesChecked(new Set());
    try {
      const [effRes, userPermsRes] = await Promise.all([
        apiGet<EffectivePermissionsBreakdown>(`/rbac/users/${userId}/effective-permissions`),
        apiGet<UserPermissionOverride[]>(`/rbac/users/${userId}/permissions`),
      ]);
      setOverridesBreakdown(effRes.data);

      // Checked = explicit GRANT, or role-inherited and not explicitly
      // DENYed -- mirrors the backend's own override-wins-over-role
      // resolution order, so the grid opens showing exactly the effective set.
      const overrideMap = new Map((userPermsRes.data || []).map((o) => [o.code, o.is_granted]));
      const roleGranted = new Set(effRes.data.role_permissions || []);
      const initialChecked = new Set<string>();
      for (const code of new Set([...overrideMap.keys(), ...roleGranted])) {
        const override = overrideMap.get(code);
        const checked = override === true || (override === undefined && roleGranted.has(code));
        if (checked) initialChecked.add(code);
      }
      setOverridesChecked(initialChecked);
    } catch (err) {
      setError(err);
    } finally {
      setOverridesLoading(false);
    }
  }

  /** Bulk-diff save: see handleSaveUserOverrides in Rbac.tsx for the same logic, explained in detail there. */
  async function handleSaveUserOverrides() {
    if (!overridesUserId || !overridesBreakdown) return;
    setOverridesSaving(true);
    try {
      const roleGranted = new Set(overridesBreakdown.role_permissions || []);
      const overrides: BulkPermissionOverrideItem[] = [];
      for (const p of allPermissions) {
        const checked = overridesChecked.has(p.code);
        const isRoleGranted = roleGranted.has(p.code);
        if (checked && !isRoleGranted) {
          overrides.push({ permission_id: p.id, is_granted: true });
        } else if (!checked && isRoleGranted) {
          overrides.push({ permission_id: p.id, is_granted: false });
        }
      }
      await apiPut(`/rbac/users/${overridesUserId}/permissions/bulk`, { overrides });
      showToast("Permissions updated for user.", "success");
      setOverridesUserId(null);
    } catch (err) {
      setError(err);
    } finally {
      setOverridesSaving(false);
    }
  }

  const canViewUser = hasPermission("user.view");
  const canUpdateUser = hasPermission("user.update");
  const canManage = hasPermission("settings.manage");

  const departmentOptions = departments.map((d) => (
    <option key={d.id} value={d.id}>
      {d.name}
    </option>
  ));
  const designationOptions = designations.map((d) => (
    <option key={d.id} value={d.id}>
      {d.title || d.name}
    </option>
  ));

  return (
    <AppShell activeKey="users" pageClassName="page-users">
      <main className="page">
        <Breadcrumb trail={["System", "User Accounts & Passwords"]} />
        <div className="page-header">
          <div>
            <h1>User Accounts &amp; Passwords</h1>
            <div className="page-subtitle">
              Manage employee login credentials, assign roles, enforce account status, and manage
              sessions.
            </div>
          </div>
          <div className="page-header-actions">
            <Can permission="user.create">
              <button className="btn btn-primary" onClick={() => setCreateOpen(true)}>
                + Create User Account
              </button>
            </Can>
          </div>
        </div>
        <Banner error={error} />

        <div className="card">
          <div className="toolbar">
            <input
              type="text"
              placeholder="Search username, email, employee code..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
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
                      checked={rows.length > 0 && selectedIds.size === rows.length}
                      onChange={(e) => {
                        setSelectedIds(e.target.checked ? new Set(rows.map((u) => u.id)) : new Set());
                      }}
                    />
                  </th>
                  <th>Employee</th>
                  <th>Username</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Department</th>
                  <th>Designation</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <TableMessageRow colSpan={10}>Loading user accounts...</TableMessageRow>
                ) : rows.length === 0 ? (
                  <TableMessageRow colSpan={10}>No user accounts found.</TableMessageRow>
                ) : (
                  rows.map((u) => {
                    const statusUpper = (u.status || "").toUpperCase();
                    const isTargetSuperAdmin =
                      u.username === "admin" || Boolean(u.roles?.includes("super_admin"));
                    const hasAdminRole = Boolean(u.roles?.includes("admin"));
                    // Only a super admin may act on another super admin.
                    const canModifyTarget =
                      canUpdateUser && (!isTargetSuperAdmin || isSuperAdmin);
                    const displayName =
                      u.full_name || u.display_name || u.employee_name || u.username;

                    const actions: ActionDropdownEntry[] = [];
                    if (canViewUser) {
                      actions.push({
                        key: "view",
                        label: "👁️ View Details",
                        onClick: () => openViewUser(u.id),
                      });
                    }
                    if (canModifyTarget && !isTargetSuperAdmin) {
                      actions.push({
                        key: "edit",
                        label: "✏️ Edit Profile",
                        onClick: () => openEditUser(u),
                      });
                    }
                    if (canModifyTarget && canManage) {
                      actions.push({
                        key: "reset-password",
                        label: "🔑 Reset Password",
                        onClick: () => handleResetPassword(u.id, u.username),
                      });
                      if (hasAdminRole) {
                        actions.push({
                          key: "remove-admin",
                          label: "🛡️ Remove Admin",
                          danger: true,
                          onClick: () => removeAdminRole(u.id, u.username),
                        });
                      } else {
                        actions.push({
                          key: "set-admin",
                          label: "⚡ Set Admin",
                          onClick: () => setAdminRole(u.id, u.username),
                        });
                      }
                      actions.push({
                        key: "assign-role",
                        label: "🛡️ Assign Role",
                        onClick: () => {
                          setRoleModalUserId(u.id);
                          setAssignRoleId("");
                        },
                      });
                      actions.push({
                        key: "permission-overrides",
                        label: "🔑 Permission Overrides",
                        onClick: () => openUserOverridesModal(u.id, u.username),
                      });
                    }
                    if (canModifyTarget && canManage) {
                      actions.push("divider");
                      if (statusUpper === "ACTIVE") {
                        actions.push({
                          key: "deactivate",
                          label: "⏸️ Deactivate",
                          onClick: () =>
                            runAction(
                              `/users/${u.id}/deactivate`,
                              `Deactivate user '${u.username}'? This will block their login and revoke all active sessions.`
                            ),
                        });
                      }
                      if (statusUpper === "INACTIVE" || statusUpper === "PENDING") {
                        actions.push({
                          key: "activate",
                          label: "▶️ Activate",
                          onClick: () => runAction(`/users/${u.id}/activate`),
                        });
                      }
                      if (statusUpper !== "SUSPENDED") {
                        actions.push({
                          key: "suspend",
                          label: "⚡ Suspend Account",
                          onClick: () =>
                            runAction(
                              `/users/${u.id}/suspend`,
                              `Suspend account for user '${u.username}'? This will block login and revoke all sessions.`
                            ),
                        });
                      }
                      if (statusUpper === "LOCKED") {
                        actions.push({
                          key: "unlock",
                          label: "🔓 Unlock Account",
                          onClick: () => runAction(`/users/${u.id}/unlock`),
                        });
                      }
                      actions.push({
                        key: "force-logout",
                        label: "🚪 Force Logout All",
                        danger: true,
                        onClick: () => handleForceLogout(u.id, u.username),
                      });
                    }

                    return (
                      <tr key={u.id}>
                        <td className="cell-checkbox" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="row-checkbox"
                            checked={selectedIds.has(u.id)}
                            onChange={(e) => {
                              setSelectedIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(u.id);
                                else next.delete(u.id);
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td>
                          <strong>{displayName}</strong>
                        </td>
                        <td>
                          <strong className="cell-primary">{u.username}</strong>
                        </td>
                        <td>{u.email}</td>
                        <td>
                          {u.roles && u.roles.length ? (
                            // "employee" is the legacy internal name for the base role;
                            // shown to admins as "user" everywhere else in the UI.
                            Array.from(
                              new Set(u.roles.map((r) => (r === "employee" ? "user" : r)))
                            ).map((r) => (
                              <span className="badge badge-neutral" key={r}>
                                {r}
                              </span>
                            ))
                          ) : (
                            <em>No Role</em>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={u.status} isActive={u.is_active} />
                        </td>
                        <td>{dash(u.department_name)}</td>
                        <td>{dash(u.designation_name)}</td>
                        <td>
                          {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}
                        </td>
                        <td className="actions" style={{ textAlign: "right" }}>
                          <ActionDropdown items={actions} />
                        </td>
                      </tr>
                    );
                  })
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

      {/* Create User Account */}
      <Modal
        open={createOpen}
        title="Create User Account"
        onClose={() => setCreateOpen(false)}
        cardStyle={{ maxWidth: "650px" }}
      >
        <form onSubmit={handleCreateSubmit}>
          <div className="form-grid">
            <TextField id="first_name" label="First Name *" required maxLength={100} placeholder="e.g. John" value={createForm.first_name} onChange={(v) => setCreateForm((f) => ({ ...f, first_name: v }))} />
            <TextField id="last_name" label="Last Name *" required maxLength={100} placeholder="e.g. Doe" value={createForm.last_name} onChange={(v) => setCreateForm((f) => ({ ...f, last_name: v }))} />
            <TextField id="username" label="Username *" required minLength={3} maxLength={100} placeholder="e.g. john.doe" value={createForm.username} onChange={(v) => setCreateForm((f) => ({ ...f, username: v }))} />
            <TextField id="email" label="Work Email *" type="email" required placeholder="e.g. john@inhyma.com" value={createForm.email} onChange={(v) => setCreateForm((f) => ({ ...f, email: v }))} />
            <TextField id="employee_code" label="Employee Code" placeholder="e.g. EMP-001" value={createForm.employee_code} onChange={(v) => setCreateForm((f) => ({ ...f, employee_code: v }))} />
            <TextField id="phone" label="Mobile Number" placeholder="+256..." value={createForm.phone} onChange={(v) => setCreateForm((f) => ({ ...f, phone: v }))} />
            <SelectField id="department_id" label="Department" value={createForm.department_id} onChange={(v) => setCreateForm((f) => ({ ...f, department_id: v }))}>
              <option value="">-- Select Department --</option>
              {departmentOptions}
            </SelectField>
            <SelectField id="designation_id" label="Designation" value={createForm.designation_id} onChange={(v) => setCreateForm((f) => ({ ...f, designation_id: v }))}>
              <option value="">-- Select Designation --</option>
              {designationOptions}
            </SelectField>
            <SelectField
              id="role_id"
              label="Assign Initial Role"
              value={createForm.role_id}
              onChange={(v) => setCreateForm((f) => ({ ...f, role_id: v }))}
              style={{ gridColumn: "span 2" }}
            >
              <option value="">-- Select System Role --</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name + (r.is_system ? " (System)" : "")}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              Create User Account
            </button>
            <button type="button" className="btn" onClick={() => setCreateOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Edit User Profile */}
      <Modal
        open={editOpen}
        title="Edit User Profile"
        onClose={() => setEditOpen(false)}
        cardStyle={{ maxWidth: "600px" }}
      >
        <form onSubmit={handleEditSubmit}>
          <div className="form-grid">
            <TextField id="editFirstName" label="First Name" maxLength={100} value={editForm.first_name} onChange={(v) => setEditForm((f) => ({ ...f, first_name: v }))} />
            <TextField id="editLastName" label="Last Name" maxLength={100} value={editForm.last_name} onChange={(v) => setEditForm((f) => ({ ...f, last_name: v }))} />
            <TextField id="editEmail" label="Work Email" type="email" required value={editForm.email} onChange={(v) => setEditForm((f) => ({ ...f, email: v }))} />
            <TextField id="editEmployeeCode" label="Employee Code" value={editForm.employee_code} onChange={(v) => setEditForm((f) => ({ ...f, employee_code: v }))} />
            <TextField id="editPhone" label="Mobile Number" value={editForm.phone} onChange={(v) => setEditForm((f) => ({ ...f, phone: v }))} />
            <SelectField id="editDepartmentId" label="Department" value={editForm.department_id} onChange={(v) => setEditForm((f) => ({ ...f, department_id: v }))}>
              <option value="">-- Select Department --</option>
              {departmentOptions}
            </SelectField>
            <SelectField
              id="editDesignationId"
              label="Designation"
              value={editForm.designation_id}
              onChange={(v) => setEditForm((f) => ({ ...f, designation_id: v }))}
              style={{ gridColumn: "span 2" }}
            >
              <option value="">-- Select Designation --</option>
              {designationOptions}
            </SelectField>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              Save Changes
            </button>
            <button type="button" className="btn" onClick={() => setEditOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* View User Details */}
      <Modal
        open={viewLoading || Boolean(viewUser)}
        title="User Account Details"
        onClose={() => {
          setViewUser(null);
          setViewSessions(null);
        }}
        cardStyle={{ maxWidth: "600px" }}
      >
        <div style={{ padding: "10px 0" }}>
          {!viewUser ? (
            <div className="muted">Loading details...</div>
          ) : (
            <>
              <div className="detail-grid">
                <div>
                  <span className="detail-label">Username:</span> {viewUser.username}
                </div>
                <div>
                  <span className="detail-label">Work Email:</span> {viewUser.email}
                </div>
                <div>
                  <span className="detail-label">Employee Code:</span>{" "}
                  {dash(viewUser.employee_code)}
                </div>
                <div>
                  <span className="detail-label">Full Name:</span>{" "}
                  {dash(viewUser.full_name || viewUser.display_name || viewUser.employee_name)}
                </div>
                <div>
                  <span className="detail-label">Department:</span>{" "}
                  {dash(viewUser.department_name)}
                </div>
                <div>
                  <span className="detail-label">Designation:</span>{" "}
                  {dash(viewUser.designation_name)}
                </div>
                <div>
                  <span className="detail-label">Status:</span>{" "}
                  <StatusBadge status={viewUser.status} isActive={viewUser.is_active} />
                </div>
                <div>
                  <span className="detail-label">Failed Logins:</span>{" "}
                  {viewUser.failed_login_count || 0}
                </div>
                <div>
                  <span className="detail-label">Last Login:</span>{" "}
                  {viewUser.last_login_at
                    ? new Date(viewUser.last_login_at).toLocaleString()
                    : "Never"}
                </div>
                <div>
                  <span className="detail-label">Must Change Pass:</span>{" "}
                  {viewUser.must_change_password ? "Yes" : "No"}
                </div>
              </div>
              <div style={{ marginTop: "16px" }}>
                <span className="detail-label">Assigned Roles:</span>
                <div style={{ marginTop: "4px" }}>
                  {viewUser.roles && viewUser.roles.length
                    ? viewUser.roles.map((r) => (
                        <span className="badge badge-neutral" key={r}>
                          {r}
                        </span>
                      ))
                    : "None"}
                </div>
              </div>
              <div style={{ marginTop: "16px" }}>
                <span className="detail-label">Active Login Sessions:</span>
                <div style={{ marginTop: "4px", fontSize: "13px" }}>
                  {viewSessions && viewSessions.length ? (
                    viewSessions.map((s, i) => (
                      <div key={i}>
                        IP: <code>{s.ip_address || "Unknown"}</code> — Device:{" "}
                        <em>{s.user_agent || "Unknown"}</em> (Active)
                      </div>
                    ))
                  ) : (
                    <p className="muted">No active sessions.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <div className="form-actions" style={{ justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setViewUser(null);
              setViewSessions(null);
            }}
          >
            Close
          </button>
        </div>
      </Modal>

      {/* Assign Role */}
      <Modal
        open={Boolean(roleModalUserId)}
        title="Assign Role"
        onClose={() => setRoleModalUserId(null)}
        cardStyle={{ maxWidth: "500px" }}
      >
        <form onSubmit={handleAssignRole}>
          <div className="field" style={{ marginBottom: "16px" }}>
            <label htmlFor="assignRoleId">Select Role to Assign</label>
            <select
              id="assignRoleId"
              required
              value={assignRoleId}
              onChange={(e) => setAssignRoleId(e.target.value)}
            >
              <option value="">-- Select System Role --</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name + (r.is_system ? " (System)" : "")}
                </option>
              ))}
            </select>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              Assign Role
            </button>
            <button type="button" className="btn" onClick={() => setRoleModalUserId(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Permission Overrides (per-user checkbox grid) */}
      <Modal
        open={Boolean(overridesUserId)}
        title={`🔑 Manage Permission Overrides — ${overridesUsername}`}
        onClose={() => setOverridesUserId(null)}
        cardStyle={{ maxWidth: "920px", width: "92vw", maxHeight: "90vh" }}
      >
        {overridesLoading || !overridesBreakdown ? (
          <div className="muted" style={{ textAlign: "center", padding: "40px" }}>
            Loading user permissions...
          </div>
        ) : overridesBreakdown.is_super_admin ? (
          <div className="muted" style={{ padding: "20px 0" }}>
            This user is a Super Administrator and always has every permission — individual
            overrides do not apply.
          </div>
        ) : (
          <>
            <div
              style={{
                display: "flex",
                gap: "12px",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                marginBottom: "16px",
              }}
            >
              <input
                type="text"
                placeholder="🔍 Search permission code or description..."
                style={{
                  flex: 1,
                  minWidth: "250px",
                  padding: "8px 12px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "6px",
                  fontSize: "13.5px",
                }}
                value={overridesSearch}
                onChange={(e) => setOverridesSearch(e.target.value)}
              />
              <div style={{ display: "flex", gap: "8px" }}>
                <button
                  type="button"
                  className="btn btn-small"
                  style={{ background: "#dcfce7", color: "#166534", border: "1px solid #bbf7d0", fontWeight: 600 }}
                  onClick={() => setOverridesChecked(new Set(allPermissions.map((p) => p.code)))}
                >
                  🟢 Grant All
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  style={{ background: "#fee2e2", color: "#991b1b", border: "1px solid #fca5a5", fontWeight: 600 }}
                  onClick={() => setOverridesChecked(new Set())}
                >
                  🔴 Deny All
                </button>
                <button
                  type="button"
                  className="btn btn-small"
                  style={{ background: "#f1f5f9", color: "#475569", border: "1px solid #cbd5e1", fontWeight: 600 }}
                  onClick={() => {
                    // Reset to exactly what the assigned roles grant, discarding
                    // every direct override.
                    setOverridesChecked(new Set(overridesBreakdown.role_permissions || []));
                  }}
                >
                  🔄 Reset Defaults
                </button>
              </div>
            </div>

            <div style={{ maxHeight: "52vh", overflowY: "auto", paddingRight: "6px" }}>
              {(() => {
                const groups = groupPermissionsByModule(allPermissions);
                const q = overridesSearch.trim().toLowerCase();
                const roleGranted = new Set(overridesBreakdown.role_permissions || []);
                const modKeys = Object.keys(groups)
                  .sort()
                  .filter((modKey) =>
                    !q
                      ? true
                      : groups[modKey].some(
                          (p) =>
                            p.code.toLowerCase().includes(q) ||
                            (p.description || "").toLowerCase().includes(q) ||
                            modKey.toLowerCase().includes(q)
                        )
                  );

                if (modKeys.length === 0) {
                  return (
                    <div className="muted" style={{ textAlign: "center", padding: "40px" }}>
                      No permissions match your search query.
                    </div>
                  );
                }

                return modKeys.map((modKey) => {
                  const items = q
                    ? groups[modKey].filter(
                        (p) =>
                          p.code.toLowerCase().includes(q) ||
                          (p.description || "").toLowerCase().includes(q) ||
                          modKey.toLowerCase().includes(q)
                      )
                    : groups[modKey];
                  const allCheckedInMod = items.every((p) => overridesChecked.has(p.code));

                  return (
                    <div className="permission-group" key={modKey}>
                      <div className="permission-group-header">
                        <div className="permission-group-title">
                          {MODULE_NAMES[modKey] || modKey.toUpperCase()}
                        </div>
                        <button
                          type="button"
                          className="toggle-btn"
                          onClick={() => {
                            setOverridesChecked((prev) => {
                              const next = new Set(prev);
                              items.forEach((p) => {
                                if (allCheckedInMod) next.delete(p.code);
                                else next.add(p.code);
                              });
                              return next;
                            });
                          }}
                        >
                          {allCheckedInMod ? "Deselect Group" : "Select Group"}
                        </button>
                      </div>
                      <div className="permission-checks">
                        {items.map((p) => {
                          const checked = overridesChecked.has(p.code);
                          const isRoleGranted = roleGranted.has(p.code);
                          return (
                            <label key={p.code}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  setOverridesChecked((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(p.code)) next.delete(p.code);
                                    else next.add(p.code);
                                    return next;
                                  });
                                }}
                              />
                              <span>
                                {friendlyPermissionLabel(p.code)}
                                {checked && !isRoleGranted && (
                                  <span
                                    className="chip chip-grant"
                                    style={{ marginLeft: "6px", fontSize: "10px", padding: "1px 6px" }}
                                  >
                                    DIRECT GRANT
                                  </span>
                                )}
                                {!checked && isRoleGranted && (
                                  <span
                                    className="chip chip-deny"
                                    style={{ marginLeft: "6px", fontSize: "10px", padding: "1px 6px" }}
                                  >
                                    DIRECT DENY
                                  </span>
                                )}
                                {checked && isRoleGranted && (
                                  <span
                                    className="chip"
                                    style={{
                                      marginLeft: "6px",
                                      fontSize: "10px",
                                      padding: "1px 6px",
                                      background: "#e2e8f0",
                                      color: "#334155",
                                    }}
                                  >
                                    FROM ROLE
                                  </span>
                                )}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: "16px",
                paddingTop: "16px",
                borderTop: "1px solid #e2e8f0",
              }}
            >
              <div style={{ fontSize: "13px", color: "#64748b", fontWeight: 500 }}>
                {overridesChecked.size} permission{overridesChecked.size === 1 ? "" : "s"} selected
              </div>
              <div style={{ display: "flex", gap: "12px" }}>
                <button type="button" className="btn" onClick={() => setOverridesUserId(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={overridesSaving}
                  onClick={() => void handleSaveUserOverrides()}
                >
                  {overridesSaving ? "Saving..." : "Save Permission Overrides"}
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>

      {/* Generated password */}
      <Modal
        open={Boolean(tempPassword)}
        title="🔑 Password Generated"
        onClose={() => setTempPassword(null)}
        cardStyle={{ maxWidth: "500px", textAlign: "center" }}
      >
        <p>A new temporary login password has been created for this account:</p>
        <div className="pass-display">{tempPassword}</div>
        <p className="muted" style={{ marginTop: "12px", fontSize: "13px" }}>
          Please copy and share this password with the employee. They will be prompted to change
          it on their first login.
        </p>
        <div className="form-actions" style={{ justifyContent: "center", marginTop: "20px" }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (tempPassword) navigator.clipboard.writeText(tempPassword);
              alert("Password copied to clipboard!");
            }}
          >
            Copy Password
          </button>
          <button type="button" className="btn" onClick={() => setTempPassword(null)}>
            Close
          </button>
        </div>
      </Modal>
    </AppShell>
  );
}
