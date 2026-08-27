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
import { Banner, Can, Modal, TableMessageRow } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { SelectField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, toQueryString } from "@/lib/api";
import { useAuth, useDebouncedValue, usePendingGuard } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { friendlyPermissionLabel, groupPermissionsByModule, MODULE_NAMES } from "@/lib/permissionLabels";
import type {
  BulkPermissionOverrideItem,
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

/**
 * Role names that are reserved by the system -- mirrors
 * `app.rbac.service.RESERVED_ROLE_NAMES` on the backend. "super_admin" is
 * the single hardcoded bootstrap admin account's role (shown to users as
 * "Admin") and cannot be assigned to anyone else. "user" is the default
 * role every other new account gets automatically. "admin" is blocked too,
 * so a same-named duplicate role can't be recreated after being retired.
 */
const RESERVED_ROLE_NAMES = new Set(["super_admin", "user", "admin"]);



function UserTableSkeletonRows({ count = 8 }: { count?: number }) {
  const nameWidths = ["75%", "60%", "85%", "70%", "90%", "65%"];
  const userWidths = ["60%", "50%", "70%", "55%", "65%", "45%"];
  const emailWidths = ["80%", "70%", "85%", "75%", "90%", "65%"];

  return (
    <>
      {Array.from({ length: count }).map((_, idx) => (
        <tr key={`user-sk-row-${idx}`}>
          <td style={{ textAlign: "center", padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "16px", height: "16px", borderRadius: "4px", margin: "0 auto" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
              <div className="skeleton-circle" style={{ width: "32px", height: "32px" }} />
              <div
                className="skeleton-line"
                style={{ width: nameWidths[idx % nameWidths.length], height: "15px", borderRadius: "4px" }}
              />
            </div>
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div
              className="skeleton-line"
              style={{ width: userWidths[idx % userWidths.length], height: "14px", borderRadius: "4px" }}
            />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div
              className="skeleton-line"
              style={{ width: emailWidths[idx % emailWidths.length], height: "14px", borderRadius: "4px" }}
            />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "65px", height: "20px", borderRadius: "12px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "55px", height: "20px", borderRadius: "12px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "80px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px", textAlign: "center" }}>
            <div className="skeleton-line" style={{ width: "32px", height: "32px", borderRadius: "4px", margin: "0 auto" }} />
          </td>
        </tr>
      ))}
    </>
  );
}

/** Friendly display name for a role name coming back from the API. */
function roleDisplayName(name: string): string {
  if (name === "super_admin") return "Admin";
  // "employee" was the old internal name for the default role in an
  // earlier version of the seed script; "user" is the current one.
  // Both are shown the same way in case an older database still has it.
  if (name === "employee" || name === "user") return "User";
  return name;
}

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

function getUserInitials(u: User | string | null): string {
  if (!u) return "U";
  if (typeof u === "string") {
    const parts = u.trim().split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return u.slice(0, 2).toUpperCase() || "U";
  }
  if (u.first_name && u.last_name) {
    return (u.first_name[0] + u.last_name[0]).toUpperCase();
  }
  const name = u.full_name || u.display_name || u.employee_name || u.username || "";
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase() || "U";
}

function renderDetailField(
  label: string,
  value: React.ReactNode | string | number | null | undefined,
  options?: { fullWidth?: boolean; isCode?: boolean }
) {
  const isBlank = value === null || value === undefined || value === "";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "4px",
        gridColumn: options?.fullWidth ? "1 / -1" : undefined,
        padding: "10px 14px",
        background: "#ffffff",
        borderRadius: "6px",
        border: "1px solid #e2e8f0",
        minHeight: "56px",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          fontSize: "11px",
          fontWeight: 700,
          color: "#64748b",
          textTransform: "uppercase",
          letterSpacing: "0.5px",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "13px",
          fontWeight: 600,
          color: isBlank ? "#94a3b8" : "#0f172a",
          wordBreak: "break-word",
          lineHeight: 1.4,
          fontStyle: isBlank ? "italic" : "normal",
        }}
      >
        {isBlank ? (
          "—"
        ) : options?.isCode ? (
          <code style={{ background: "#f1f5f9", padding: "2px 6px", borderRadius: "4px", fontSize: "12.5px" }}>
            {String(value)}
          </code>
        ) : (
          value
        )}
      </div>
    </div>
  );
}

function renderDetailSection(icon: string, title: string, children: React.ReactNode, extra?: React.ReactNode) {
  return (
    <div style={{ marginBottom: "20px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "10px",
          paddingBottom: "6px",
          borderBottom: "1.5px solid #e2e8f0",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color: "#1e293b" }}>
          <span>{icon}</span>
          <span>{title}</span>
        </div>
        {extra}
      </div>
      {children}
    </div>
  );
}

const EMPTY_CREATE = {
  first_name: "",
  last_name: "",
  display_name: "",
  username: "",
  email: "",
  employee_code: "",
  phone: "",
  password: "",
  role_id: "",
};

const EMPTY_EDIT = {
  id: "",
  username: "",
  first_name: "",
  middle_name: "",
  last_name: "",
  display_name: "",
  employee_code: "",
  email: "",
  phone: "",
  manager_id: "",
  date_of_birth: "",
  gender: "",
  date_of_joining: "",
  employment_type: "FULL_TIME",
  employment_status: "ACTIVE",
  address: "",
  city: "",
  state: "",
  country: "",
  postal_code: "",
  emergency_contact: "",
  notes: "",
};

export function UsersPage() {
  const { hasPermission, isSuperAdmin } = useAuth();
  const showToast = useToast();

  const [rows, setRows] = useState<User[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [reloadCounter, setReloadCounter] = useState(0);
  const query = useDebouncedValue(searchInput, 300);

  const [roles, setRoles] = useState<Role[]>([]);
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

  // Phase 7: double-submit guards. Row-scoped actions (force-logout, reset
  // password, admin-role toggle) share one keyed guard so acting on one row
  // never disables another; the three single-instance modal forms
  // (create/edit/assign-role) get their own simple booleans.
  const { isPending: isRowActionPending, guard: guardRowAction } = usePendingGuard<string>();
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<unknown>(null);
  const [assignRoleSubmitting, setAssignRoleSubmitting] = useState(false);

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
      // Targeted action complete: no full list reload
      return data;
    } catch (err) {
      setError(err);
    }
  }

  async function handleForceLogout(userId: string, username: string) {
    if (!confirm(`Force logout user '${username}' from all devices?`)) return;
    await guardRowAction(`force-logout:${userId}`, async () => {
      try {
        const { data } = await apiPost<{ revoked_sessions?: number }>(
          `/users/${userId}/force-logout`
        );
        alert(`Successfully revoked ${data.revoked_sessions || 0} active session(s).`);
      } catch (err) {
        setError(err);
      }
    });
  }

  async function handleResetPassword(userId: string, username: string) {
    if (
      !confirm(`Reset password for user '${username}'? This will generate a new temporary password.`)
    )
      return;
    await guardRowAction(`reset-password:${userId}`, async () => {
      try {
        const { data } = await apiPost<{ temporary_password: string }>(
          `/users/${userId}/reset-password`
        );
        setTempPassword(data.temporary_password);
      } catch (err) {
        setError(err);
      }
    });
  }

  async function handleDeleteUser(userId: string, username: string, email: string) {
    if (
      !confirm(
        `Are you sure you want to delete user '${username}' (${email || "no email"})?\n\nThis will remove the user account, terminate active sessions, and unassign roles.`
      )
    )
      return;
    await guardRowAction(`delete:${userId}`, async () => {
      try {
        await apiDelete(`/users/${userId}`);
        showToast(`User '${username}' was deleted successfully.`, "success");
        setRows((prev) => prev.filter((u) => u.id !== userId));
        setPagination((prev) =>
          prev ? { ...prev, total_records: Math.max(0, (prev.total_records || 0) - 1) } : prev
        );
      } catch (err) {
        setError(err);
      }
    });
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
      username: user.username || "",
      first_name: user.first_name || "",
      middle_name: user.middle_name || "",
      last_name: user.last_name || "",
      display_name: user.display_name || "",
      employee_code: user.employee_code || "",
      email: user.email || "",
      phone: user.phone || "",
      manager_id: user.manager_id || "",
      date_of_birth: user.date_of_birth ? user.date_of_birth.split("T")[0] : "",
      gender: user.gender || "",
      date_of_joining: user.date_of_joining ? user.date_of_joining.split("T")[0] : "",
      employment_type: user.employment_type || "FULL_TIME",
      employment_status: user.employment_status || "ACTIVE",
      address: user.address || "",
      city: user.city || "",
      state: user.state || "",
      country: user.country || "",
      postal_code: user.postal_code || "",
      emergency_contact: user.emergency_contact || "",
      notes: user.notes || "",
    });
    setEditError(null);
    setEditOpen(true);
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (createSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setError(null);
    setCreateSubmitting(true);
    try {
      const { data } = await apiPost<User>("/users", {
        first_name: createForm.first_name.trim(),
        last_name: createForm.last_name.trim(),
        display_name: createForm.display_name.trim(),
        username: createForm.username.trim() || null,
        email: createForm.email.trim(),
        employee_code: createForm.employee_code.trim() || null,
        phone: createForm.phone.trim(),
        password: createForm.password,
        role_ids: createForm.role_id ? [createForm.role_id] : [],
      });
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE);
      if (data) {
        setRows((prev) => [data, ...prev]);
        setPagination((prev) => (prev ? { ...prev, total_records: (prev.total_records || 0) + 1 } : prev));
        if (data.temporary_password) setTempPassword(data.temporary_password);
      } else {
        reload();
      }
    } catch (err) {
      setError(err);
    } finally {
      setCreateSubmitting(false);
    }
  }

  async function handleEditSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (editSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setEditError(null);
    setEditSubmitting(true);
    try {
      const existingUser = rows.find((u) => u.id === editForm.id);
      const payload: Record<string, unknown> = {
        version: existingUser?.version,
        username: editForm.username.trim() || null,
        first_name: editForm.first_name.trim() || null,
        middle_name: editForm.middle_name.trim() || null,
        last_name: editForm.last_name.trim() || null,
        display_name: editForm.display_name.trim() || null,
        email: editForm.email.trim(),
        employee_code: editForm.employee_code.trim() || null,
        phone: editForm.phone.trim() || null,
        manager_id: editForm.manager_id || null,
        date_of_birth: editForm.date_of_birth || null,
        gender: editForm.gender || null,
        date_of_joining: editForm.date_of_joining || null,
        employment_type: editForm.employment_type || null,
        employment_status: editForm.employment_status || null,
        address: editForm.address.trim() || null,
        city: editForm.city.trim() || null,
        state: editForm.state.trim() || null,
        country: editForm.country.trim() || null,
        postal_code: editForm.postal_code.trim() || null,
        emergency_contact: editForm.emergency_contact.trim() || null,
        notes: editForm.notes.trim() || null,
      };

      const { data: updatedUser } = await apiPatch<User>(`/users/${editForm.id}`, payload);
      setEditOpen(false);
      showToast(`User profile updated successfully.`, "success");
      if (updatedUser) {
        setRows((prev) => prev.map((u) => (u.id === editForm.id ? { ...u, ...updatedUser } : u)));
        if (viewUser && viewUser.id === editForm.id) {
          setViewUser((prev) => (prev ? { ...prev, ...updatedUser } : updatedUser));
        }
      } else {
        reload();
      }
    } catch (err) {
      setEditError(err);
    } finally {
      setEditSubmitting(false);
    }
  }

  async function handleAssignRole(e: React.FormEvent) {
    e.preventDefault();
    if (assignRoleSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    if (!roleModalUserId) return;
    setAssignRoleSubmitting(true);
    try {
      await apiPost(`/users/${roleModalUserId}/roles`, { role_id: assignRoleId });
      setRoleModalUserId(null);
      setAssignRoleId("");
      reload();
    } catch (err) {
      setError(err);
    } finally {
      setAssignRoleSubmitting(false);
    }
  }

  /**
   * Removes a legacy admin-style role assignment from a user.
   *
   * Note: there is no corresponding "grant admin" action anymore -- the
   * Admin (super_admin) role can only ever be held by the single hardcoded
   * bootstrap admin account (enforced server-side in
   * app.users.service.UserService.assign_role), so offering to grant it to
   * an arbitrary user here would just produce a confusing 403. This action
   * exists purely to let an operator clean up a user who still holds the
   * old duplicate "admin" role from before that role was retired.
   */
  async function removeAdminRole(userId: string, username: string) {
    if (!confirm(`Revoke Administrator privileges from '${username}'?`)) return;
    await guardRowAction(`admin-role:${userId}`, async () => {
      try {
        const { data: allRoles } = await apiGet<Role[]>("/rbac/roles");
        const adminRoles = allRoles.filter((r) => r.name === "admin" || r.name === "super_admin");
        if (!adminRoles.length) {
          setError(new Error("No admin-style role found on this system to remove."));
          return;
        }
        for (const role of adminRoles) {
          try {
            await apiDelete(`/users/${userId}/roles/${role.id}`);
          } catch (err) {
            // If the user simply doesn't have this particular role, that's
            // fine -- keep trying the others. Any other failure (e.g. "last
            // active Super Administrator") should still surface.
            const status = (err as { status?: number })?.status;
            if (status !== 404) throw err;
          }
        }
        showToast(`Admin privileges revoked from '${username}'.`, "success");
        reload();
      } catch (err) {
        setError(err);
      }
    });
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
      let perms = allPermissions;
      if (!perms || perms.length === 0) {
        const permsRes = await apiGet<Permission[]>("/rbac/permissions");
        perms = permsRes.data || [];
        setAllPermissions(perms);
      }
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

  const canManage = hasPermission("user.action") || isSuperAdmin;

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
                  <th>Department</th>
                  <th>Status</th>
                  <th>Last Login</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <UserTableSkeletonRows count={8} />
                ) : rows.length === 0 ? (
                  <TableMessageRow colSpan={8}>No user accounts found.</TableMessageRow>
                ) : (
                  rows.map((u) => {
                    const statusUpper = (u.status || "").toUpperCase();
                    const isTargetSuperAdmin = Boolean(u.roles?.includes("super_admin"));
                    const hasAdminRole = Boolean(u.roles?.includes("super_admin") || u.roles?.includes("admin"));
                    const canActOnTarget = !isTargetSuperAdmin || isSuperAdmin;
                    const displayName =
                      u.full_name || u.display_name || u.employee_name || u.username;

                    const actions: ActionDropdownEntry[] = [];
                    if (canManage) {
                      actions.push({
                        key: "view",
                        label: "👁️ View Details",
                        onClick: () => openViewUser(u.id),
                      });
                      if (canActOnTarget) {
                        actions.push({
                          key: "edit",
                          label: "✏️ Edit Profile",
                          onClick: () => openEditUser(u),
                        });
                        const resettingPassword = isRowActionPending(`reset-password:${u.id}`);
                        actions.push({
                          key: "reset-password",
                          label: resettingPassword ? "🔑 Resetting..." : "🔑 Reset Password",
                          onClick: () => handleResetPassword(u.id, u.username),
                        });
                        const changingAdminRole = isRowActionPending(`admin-role:${u.id}`);
                        if (hasAdminRole && !isTargetSuperAdmin) {
                          actions.push({
                            key: "remove-admin",
                            label: changingAdminRole ? "🛡️ Removing..." : "🛡️ Remove Legacy Admin Role",
                            danger: true,
                            onClick: () => removeAdminRole(u.id, u.username),
                          });
                        }
                        actions.push({
                          key: "assign-role",
                          label: "🛡️ Assign Department",
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

                        actions.push("divider");
                        if (statusUpper === "ACTIVE") {
                          actions.push({
                            key: "deactivate",
                            label: "⏸️ Inactive",
                            onClick: () =>
                              runAction(
                                `/users/${u.id}/deactivate`,
                                `Set user '${u.username}' to Inactive? This will block their login and revoke all active sessions.`
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
                        if (statusUpper === "SUSPENDED") {
                          actions.push({
                            key: "unsuspend",
                            label: "⚡ Unsuspend Account",
                            onClick: () =>
                              runAction(
                                `/users/${u.id}/unsuspend`,
                                `Unsuspend account for user '${u.username}'? This will restore active login status.`
                              ),
                          });
                        } else {
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
                          label: isRowActionPending(`force-logout:${u.id}`)
                            ? "🚪 Logging out..."
                            : "🚪 Force Logout All",
                          danger: true,
                          onClick: () => handleForceLogout(u.id, u.username),
                        });
                        if (!isTargetSuperAdmin) {
                          actions.push({
                            key: "delete-user",
                            label: isRowActionPending(`delete:${u.id}`)
                              ? "🗑️ Deleting..."
                              : "🗑️ Delete User",
                            danger: true,
                            onClick: () => handleDeleteUser(u.id, u.username, u.email),
                          });
                        }
                      }
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
                            Array.from(new Set(u.roles.map((r) => roleDisplayName(r)))).map((r) => (
                              <span className="badge badge-neutral" key={r}>
                                {r}
                              </span>
                            ))
                          ) : (
                            <em>No Department</em>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={u.status} isActive={u.is_active} />
                        </td>
                        <td>
                          {u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "Never"}
                        </td>
                        <td className="actions" style={{ textAlign: "right" }}>
                          {canManage && actions.length > 0 ? (
                            <ActionDropdown items={actions} />
                          ) : null}
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
            <TextField
              id="first_name"
              label="First Name *"
              required
              maxLength={100}
              placeholder="e.g. John"
              value={createForm.first_name}
              onChange={(v) =>
                setCreateForm((f) => {
                  const autoDisplay = `${f.first_name} ${f.last_name}`.trim();
                  const displayFollowsAuto = !f.display_name || f.display_name === autoDisplay;
                  const nextAutoDisplay = `${v} ${f.last_name}`.trim();
                  return {
                    ...f,
                    first_name: v,
                    display_name: displayFollowsAuto ? nextAutoDisplay : f.display_name,
                  };
                })
              }
            />
            <TextField
              id="last_name"
              label="Last Name"
              maxLength={100}
              placeholder="e.g. Doe"
              value={createForm.last_name}
              onChange={(v) =>
                setCreateForm((f) => {
                  const autoDisplay = `${f.first_name} ${f.last_name}`.trim();
                  const displayFollowsAuto = !f.display_name || f.display_name === autoDisplay;
                  const nextAutoDisplay = `${f.first_name} ${v}`.trim();
                  return {
                    ...f,
                    last_name: v,
                    display_name: displayFollowsAuto ? nextAutoDisplay : f.display_name,
                  };
                })
              }
            />
            <TextField
              id="display_name"
              label="Display Name *"
              required
              maxLength={200}
              placeholder="Shown everywhere in the system (e.g. John Doe)"
              value={createForm.display_name}
              onChange={(v) => setCreateForm((f) => ({ ...f, display_name: v }))}
            />
            <TextField id="username" label="Username (optional)" minLength={3} maxLength={100} placeholder="Leave blank to auto-generate" value={createForm.username} onChange={(v) => setCreateForm((f) => ({ ...f, username: v }))} />
            <TextField id="email" label="Work Email *" type="email" required placeholder="e.g. john@inhyma.com" value={createForm.email} onChange={(v) => setCreateForm((f) => ({ ...f, email: v }))} />
            <TextField id="employee_code" label="Employee Code" disableAutoCapitalize placeholder="e.g. EMP-001" value={createForm.employee_code} onChange={(v) => setCreateForm((f) => ({ ...f, employee_code: v }))} />
            <TextField id="phone" label="Mobile Number *" required placeholder="+256..." value={createForm.phone} onChange={(v) => setCreateForm((f) => ({ ...f, phone: v }))} />
            <TextField id="password" label="Password *" type="password" required minLength={1} placeholder="Set the user's initial password" value={createForm.password} onChange={(v) => setCreateForm((f) => ({ ...f, password: v }))} />
            <SelectField
              id="role_id"
              label="Assign Initial Department"
              value={createForm.role_id}
              onChange={(v) => setCreateForm((f) => ({ ...f, role_id: v }))}
              style={{ gridColumn: "span 2" }}
            >
              <option value="">-- Default: User --</option>
              {roles
                .filter((r) => r.name !== "super_admin")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleDisplayName(r.name) + (RESERVED_ROLE_NAMES.has(r.name) ? " (System)" : "")}
                  </option>
                ))}
            </SelectField>
            <span className="muted" style={{ fontSize: "12px", gridColumn: "span 2", marginTop: "-8px" }}>
              Leave unselected to assign the default "User" department automatically. The Admin
              department is reserved for the system's bootstrap account and cannot be assigned here.
            </span>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={createSubmitting}>
              {createSubmitting ? "Creating…" : "Create User Account"}
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
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span>✏️</span>
            <span>Edit User Profile & HR Details</span>
          </div>
        }
        onClose={() => {
          setEditOpen(false);
          setEditError(null);
        }}
        cardStyle={{ width: "100%", maxWidth: "720px", padding: 0 }}
      >
        <form onSubmit={handleEditSubmit}>
          <div
            style={{
              padding: "20px 24px",
              maxHeight: "calc(100vh - 170px)",
              overflowY: "auto",
              background: "#f8fafc",
            }}
          >
            {editError ? (
              <div style={{ marginBottom: "16px" }}>
                <Banner error={editError} />
              </div>
            ) : null}

            {/* Section 1: Basic & Identity Details */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px 18px", marginBottom: "16px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "14px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span>👤</span>
                <span>Basic & Identity Details</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px", marginBottom: "14px" }}>
                <TextField id="editFirstName" label="First Name" maxLength={100} value={editForm.first_name} onChange={(v) => setEditForm((f) => ({ ...f, first_name: v }))} placeholder="e.g. John" />
                <TextField id="editMiddleName" label="Middle Name" maxLength={100} value={editForm.middle_name} onChange={(v) => setEditForm((f) => ({ ...f, middle_name: v }))} placeholder="e.g. Robert" />
                <TextField id="editLastName" label="Last Name" maxLength={100} value={editForm.last_name} onChange={(v) => setEditForm((f) => ({ ...f, last_name: v }))} placeholder="e.g. Doe" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px" }}>
                <TextField id="editUsername" label="Username *" minLength={3} maxLength={100} required disableAutoCapitalize value={editForm.username} onChange={(v) => setEditForm((f) => ({ ...f, username: v }))} placeholder="e.g. john.doe" />
                <TextField id="editDisplayName" label="Display Name" maxLength={200} value={editForm.display_name} onChange={(v) => setEditForm((f) => ({ ...f, display_name: v }))} placeholder="e.g. John Doe" />
                <TextField id="editEmployeeCode" label="Employee Code" maxLength={50} disableAutoCapitalize value={editForm.employee_code} onChange={(v) => setEditForm((f) => ({ ...f, employee_code: v }))} placeholder="e.g. EMP-001" />
              </div>
            </div>

            {/* Section 2: Contact Information */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px 18px", marginBottom: "16px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "14px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span>📞</span>
                <span>Contact Information</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
                <TextField id="editEmail" label="Work Email *" type="email" required value={editForm.email} onChange={(v) => setEditForm((f) => ({ ...f, email: v }))} placeholder="e.g. john@inhyma.com" />
                <TextField id="editPhone" label="Mobile / Phone Number *" required maxLength={30} value={editForm.phone} onChange={(v) => setEditForm((f) => ({ ...f, phone: v }))} placeholder="e.g. +91 9876543210" />
              </div>
              <div>
                <TextField id="editEmergencyContact" label="Emergency Contact (Name / Phone)" maxLength={255} value={editForm.emergency_contact} onChange={(v) => setEditForm((f) => ({ ...f, emergency_contact: v }))} placeholder="e.g. Jane Doe (+91 9876543210)" />
              </div>
            </div>

            {/* Section 3: Employment & HR Profile */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px 18px", marginBottom: "16px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "14px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span>💼</span>
                <span>Employment & HR Profile</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
                <SelectField
                  id="editManager"
                  label="Reporting Manager"
                  value={editForm.manager_id}
                  onChange={(v) => setEditForm((f) => ({ ...f, manager_id: v }))}
                >
                  <option value="">-- None (No Manager) --</option>
                  {rows
                    .filter((u) => u.id !== editForm.id)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.full_name || u.display_name || u.employee_name || u.username} ({u.username})
                      </option>
                    ))}
                </SelectField>
                <SelectField
                  id="editGender"
                  label="Gender"
                  value={editForm.gender}
                  onChange={(v) => setEditForm((f) => ({ ...f, gender: v }))}
                >
                  <option value="">-- Select Gender --</option>
                  <option value="MALE">Male</option>
                  <option value="FEMALE">Female</option>
                  <option value="OTHER">Other</option>
                  <option value="PREFER_NOT_TO_SAY">Prefer Not to Say</option>
                </SelectField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
                <SelectField
                  id="editEmploymentType"
                  label="Employment Type"
                  value={editForm.employment_type}
                  onChange={(v) => setEditForm((f) => ({ ...f, employment_type: v }))}
                >
                  <option value="FULL_TIME">Full Time</option>
                  <option value="PART_TIME">Part Time</option>
                  <option value="CONTRACT">Contract</option>
                  <option value="INTERN">Intern</option>
                  <option value="TEMPORARY">Temporary</option>
                </SelectField>
                <SelectField
                  id="editEmploymentStatus"
                  label="Employment Status"
                  value={editForm.employment_status}
                  onChange={(v) => setEditForm((f) => ({ ...f, employment_status: v }))}
                >
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                  <option value="ON_LEAVE">On Leave</option>
                  <option value="TERMINATED">Terminated</option>
                  <option value="RESIGNED">Resigned</option>
                </SelectField>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <TextField id="editDateOfJoining" label="Date of Joining" type="date" value={editForm.date_of_joining} onChange={(v) => setEditForm((f) => ({ ...f, date_of_joining: v }))} />
                <TextField id="editDateOfBirth" label="Date of Birth" type="date" value={editForm.date_of_birth} onChange={(v) => setEditForm((f) => ({ ...f, date_of_birth: v }))} />
              </div>
            </div>

            {/* Section 4: Address & Location */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px 18px", marginBottom: "16px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "14px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span>📍</span>
                <span>Address & Location Details</span>
              </div>
              <div style={{ marginBottom: "14px" }}>
                <TextField id="editAddress" label="Street Address" value={editForm.address} onChange={(v) => setEditForm((f) => ({ ...f, address: v }))} placeholder="Full street address..." />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px", marginBottom: "14px" }}>
                <TextField id="editCity" label="City" maxLength={100} value={editForm.city} onChange={(v) => setEditForm((f) => ({ ...f, city: v }))} placeholder="e.g. Shanghai" />
                <TextField id="editState" label="State / Province" maxLength={100} value={editForm.state} onChange={(v) => setEditForm((f) => ({ ...f, state: v }))} placeholder="e.g. Zhejiang" />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "14px" }}>
                <TextField id="editCountry" label="Country" maxLength={100} value={editForm.country} onChange={(v) => setEditForm((f) => ({ ...f, country: v }))} placeholder="e.g. China" />
                <TextField id="editPostalCode" label="Postal / PIN Code" maxLength={20} value={editForm.postal_code} onChange={(v) => setEditForm((f) => ({ ...f, postal_code: v }))} placeholder="e.g. 310000" />
              </div>
            </div>

            {/* Section 5: Internal Notes */}
            <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.03)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", fontWeight: 700, color: "#1e293b", marginBottom: "14px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                <span>📝</span>
                <span>Internal Administrator Notes</span>
              </div>
              <div>
                <TextField id="editNotes" label="Internal Notes" value={editForm.notes} onChange={(v) => setEditForm((f) => ({ ...f, notes: v }))} placeholder="Optional administrator notes on this user account..." />
              </div>
            </div>
          </div>

          <div
            style={{
              padding: "14px 24px",
              borderTop: "1px solid #e2e8f0",
              background: "#ffffff",
              display: "flex",
              justifyContent: "flex-end",
              gap: "12px",
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditOpen(false);
                setEditError(null);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={editSubmitting}>
              {editSubmitting ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </Modal>

      {/* View User Details */}
      <Modal
        open={viewLoading || Boolean(viewUser)}
        title={
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span>👤</span>
            <span>User Account & Profile Details</span>
          </div>
        }
        onClose={() => {
          setViewUser(null);
          setViewSessions(null);
        }}
        cardStyle={{ width: "100%", maxWidth: "700px", padding: 0 }}
      >
        {!viewUser ? (
          <div style={{ padding: "40px", textAlign: "center", color: "#64748b" }}>
            <div className="skeleton-line" style={{ width: "60px", height: "60px", borderRadius: "50%", margin: "0 auto 16px" }} />
            <div className="skeleton-line" style={{ width: "200px", height: "20px", margin: "0 auto 8px" }} />
            <div className="skeleton-line" style={{ width: "140px", height: "14px", margin: "0 auto" }} />
          </div>
        ) : (
          <>
            {/* Header Profile Hero Card */}
            <div
              style={{
                padding: "20px 24px",
                background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
                color: "#ffffff",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: "16px",
                borderBottom: "1px solid #334155",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
                <div
                  style={{
                    width: "52px",
                    height: "52px",
                    borderRadius: "12px",
                    background: "linear-gradient(135deg, #0061f2, #60a5fa)",
                    color: "#ffffff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "20px",
                    fontWeight: 700,
                    boxShadow: "0 4px 12px rgba(0, 97, 242, 0.4)",
                    letterSpacing: "1px",
                    flexShrink: 0,
                  }}
                >
                  {getUserInitials(viewUser)}
                </div>
                <div>
                  <div style={{ fontSize: "17px", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px" }}>
                    <span>{viewUser.full_name || viewUser.display_name || viewUser.employee_name || viewUser.username}</span>
                  </div>
                  <div style={{ fontSize: "12.5px", color: "#94a3b8", display: "flex", alignItems: "center", gap: "8px", marginTop: "3px" }}>
                    <span>@{viewUser.username}</span>
                    <span>•</span>
                    <span>{viewUser.email}</span>
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                <StatusBadge status={viewUser.status} isActive={viewUser.is_active} />
              </div>
            </div>

            {/* Scrollable Body with Exhaustive DB Details */}
            <div
              style={{
                padding: "20px 24px",
                maxHeight: "calc(100vh - 220px)",
                overflowY: "auto",
                background: "#f8fafc",
              }}
            >
              {/* Section 1: Basic & Identity Information */}
              {renderDetailSection(
                "👤",
                "Basic & Identity Details",
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  {renderDetailField("Full Name", viewUser.full_name)}
                  {renderDetailField("Display Name", viewUser.display_name)}
                  {renderDetailField("First Name", viewUser.first_name)}
                  {renderDetailField("Middle Name", viewUser.middle_name)}
                  {renderDetailField("Last Name", viewUser.last_name)}
                  {renderDetailField("Username", viewUser.username, { isCode: true })}
                  {renderDetailField("Employee Code", viewUser.employee_code, { isCode: true })}
                </div>
              )}

              {/* Section 2: Contact Information */}
              {renderDetailSection(
                "📞",
                "Contact Details",
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  {renderDetailField("Work Email", viewUser.email)}
                  {renderDetailField("Mobile / Phone Number", viewUser.phone)}
                  {renderDetailField("Emergency Contact", viewUser.emergency_contact)}
                </div>
              )}

              {/* Section 3: Employment & HR Profile */}
              {renderDetailSection(
                "💼",
                "Employment & HR Profile",
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  {renderDetailField("Reporting Manager", viewUser.manager_name)}
                  {renderDetailField(
                    "Employment Type",
                    viewUser.employment_type ? viewUser.employment_type.replace(/_/g, " ").toUpperCase() : null
                  )}
                  {renderDetailField(
                    "Employment Status",
                    viewUser.employment_status ? viewUser.employment_status.replace(/_/g, " ").toUpperCase() : null
                  )}
                  {renderDetailField(
                    "Date of Joining",
                    viewUser.date_of_joining ? new Date(viewUser.date_of_joining).toLocaleDateString() : null
                  )}
                  {renderDetailField(
                    "Date of Birth",
                    viewUser.date_of_birth ? new Date(viewUser.date_of_birth).toLocaleDateString() : null
                  )}
                  {renderDetailField("Gender", viewUser.gender ? viewUser.gender.toUpperCase() : null)}
                </div>
              )}

              {/* Section 4: Address & Location */}
              {renderDetailSection(
                "📍",
                "Address & Location Details",
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  {renderDetailField("Street Address", viewUser.address, { fullWidth: true })}
                  {renderDetailField("City", viewUser.city)}
                  {renderDetailField("State / Province", viewUser.state)}
                  {renderDetailField("Country", viewUser.country)}
                  {renderDetailField("Postal / PIN Code", viewUser.postal_code)}
                </div>
              )}

              {/* Section 5: Account Security & Authentication */}
              {renderDetailSection(
                "🛡️",
                "Account Security & Authentication",
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "10px" }}>
                  {renderDetailField(
                    "Account Status",
                    <StatusBadge status={viewUser.status} isActive={viewUser.is_active} />
                  )}
                  {renderDetailField("Is Active", viewUser.is_active ? "Yes" : "No")}
                  {renderDetailField(
                    "Must Change Password",
                    viewUser.must_change_password ? "Yes (Required on next login)" : "No"
                  )}
                  {renderDetailField("Failed Login Attempts", viewUser.failed_login_count ?? 0)}
                  {renderDetailField(
                    "Last Login",
                    viewUser.last_login_at ? new Date(viewUser.last_login_at).toLocaleString() : "Never (No logins yet)"
                  )}
                  {renderDetailField(
                    "Password Last Changed",
                    viewUser.password_changed_at ? new Date(viewUser.password_changed_at).toLocaleString() : null
                  )}
                  {renderDetailField(
                    "Account Locked Until",
                    viewUser.locked_until ? new Date(viewUser.locked_until).toLocaleString() : null
                  )}
                  {renderDetailField("Record Version", `v${viewUser.version ?? 1}`, { isCode: true })}
                  {renderDetailField(
                    "Created By",
                    viewUser.created_by_username || (viewUser.created_by ? String(viewUser.created_by) : null)
                  )}
                  {renderDetailField(
                    "Created At",
                    viewUser.created_at ? new Date(viewUser.created_at).toLocaleString() : null
                  )}
                  {renderDetailField(
                    "Last Updated At",
                    viewUser.updated_at ? new Date(viewUser.updated_at).toLocaleString() : null
                  )}
                </div>
              )}

              {/* Section 6: Assigned Departments & Access */}
              {renderDetailSection(
                "🔐",
                "Assigned Departments & Access",
                <div
                  style={{
                    padding: "12px 14px",
                    background: "#ffffff",
                    borderRadius: "6px",
                    border: "1px solid #e2e8f0",
                  }}
                >
                  {viewUser.roles && viewUser.roles.length > 0 ? (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                      {viewUser.roles.map((r) => (
                        <span
                          key={r}
                          style={{
                            background: "#eff6ff",
                            color: "#1e40af",
                            border: "1px solid #bfdbfe",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12.5px",
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                          }}
                        >
                          <span>🛡️</span> {roleDisplayName(r)}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ color: "#94a3b8", fontStyle: "italic", fontSize: "13px" }}>— (No departments assigned)</span>
                  )}
                </div>
              )}

              {/* Section 7: Active Login Sessions */}
              {renderDetailSection(
                "💻",
                "Active Login Sessions",
                <div
                  style={{
                    padding: "12px 14px",
                    background: "#ffffff",
                    borderRadius: "6px",
                    border: "1px solid #e2e8f0",
                  }}
                >
                  {viewSessions && viewSessions.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                      {viewSessions.map((s, i) => (
                        <div
                          key={i}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "8px 12px",
                            background: "#f8fafc",
                            borderRadius: "6px",
                            border: "1px solid #e2e8f0",
                            fontSize: "12.5px",
                          }}
                        >
                          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            <span style={{ color: "#16a34a", fontSize: "10px" }}>🟢</span>
                            <span style={{ fontWeight: 600, color: "#1e293b" }}>IP:</span>
                            <code style={{ background: "#e2e8f0", padding: "1px 6px", borderRadius: "4px" }}>
                              {s.ip_address || "Unknown IP"}
                            </code>
                            <span style={{ color: "#94a3b8" }}>|</span>
                            <span style={{ color: "#475569" }}>{s.user_agent || "Unknown Device"}</span>
                          </div>
                          <span style={{ color: "#16a34a", fontWeight: 600, fontSize: "11px", textTransform: "uppercase" }}>
                            Active
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span style={{ color: "#94a3b8", fontStyle: "italic", fontSize: "13px" }}>— (No active login sessions)</span>
                  )}
                </div>
              )}

              {/* Section 8: Internal Notes */}
              {renderDetailSection(
                "📝",
                "Internal Administrator Notes",
                <div
                  style={{
                    padding: "12px 14px",
                    background: "#ffffff",
                    borderRadius: "6px",
                    border: "1px solid #e2e8f0",
                    fontSize: "13px",
                    lineHeight: 1.5,
                  }}
                >
                  {viewUser.notes ? (
                    <div style={{ color: "#1e293b", whiteSpace: "pre-wrap" }}>{viewUser.notes}</div>
                  ) : (
                    <span style={{ color: "#94a3b8", fontStyle: "italic" }}>— (No internal notes recorded)</span>
                  )}
                </div>
              )}
            </div>

            {/* Footer Action Buttons */}
            <div
              style={{
                padding: "14px 24px",
                borderTop: "1px solid #e2e8f0",
                background: "#ffffff",
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              {canManage && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const u = viewUser;
                    setViewUser(null);
                    setViewSessions(null);
                    openEditUser(u);
                  }}
                >
                  ✏️ Edit Profile
                </button>
              )}
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
          </>
        )}
      </Modal>

      {/* Assign Department */}
      <Modal
        open={Boolean(roleModalUserId)}
        title="Assign Department"
        onClose={() => setRoleModalUserId(null)}
        cardStyle={{ maxWidth: "500px" }}
      >
        <form onSubmit={handleAssignRole}>
          <div className="field" style={{ marginBottom: "16px" }}>
            <label htmlFor="assignRoleId">Select Department to Assign</label>
            <select
              id="assignRoleId"
              required
              value={assignRoleId}
              onChange={(e) => setAssignRoleId(e.target.value)}
            >
              <option value="">-- Select Department --</option>
              {roles
                .filter((r) => r.name !== "super_admin")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleDisplayName(r.name) + (RESERVED_ROLE_NAMES.has(r.name) ? " (System)" : "")}
                  </option>
                ))}
            </select>
            <span className="muted" style={{ fontSize: "12px", marginTop: "4px", display: "block" }}>
              The Admin department is reserved for the system's bootstrap account and cannot be assigned here.
            </span>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={assignRoleSubmitting}>
              {assignRoleSubmitting ? "Assigning…" : "Assign Department"}
            </button>
            <button type="button" className="btn" onClick={() => setRoleModalUserId(null)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Permission Overrides (per-user checkbox grid) */}
      {/* Permission Overrides (per-user checkbox grid right slide-over drawer) */}
      <Modal
        open={Boolean(overridesUserId)}
        title={`🔑 Manage Permission Overrides — ${overridesUsername}`}
        onClose={() => setOverridesUserId(null)}
        cardStyle={{ maxWidth: "820px", width: "100%", height: "100vh", maxHeight: "100vh", display: "flex", flexDirection: "column", padding: 0 }}
      >
        {overridesLoading || !overridesBreakdown ? (
          <div className="muted" style={{ textAlign: "center", padding: "40px" }}>
            Loading user permissions...
          </div>
        ) : overridesBreakdown.is_super_admin ? (
          <div className="muted" style={{ padding: "20px 24px" }}>
            This user is a Super Administrator and always has every permission — individual
            overrides do not apply.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "calc(100vh - 65px)", overflow: "hidden" }}>
            {/* Scrollable Body */}
            <div style={{ flex: 1, overflowY: "auto", padding: "18px 24px", display: "flex", flexDirection: "column", gap: "16px" }}>
              {/* User Info & Assigned Roles Summary Banner */}
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "8px" }}>
                  <div>
                    <span style={{ fontWeight: 600, color: "#0f172a", fontSize: "14px" }}>User: {overridesUsername}</span>
                    {overridesBreakdown.user_info?.employee_name && (
                      <span style={{ color: "#64748b", fontSize: "13px", marginLeft: "8px" }}>
                        ({overridesBreakdown.user_info.employee_name})
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>Assigned Departments:</span>
                    {(overridesBreakdown.user_info?.system_roles || []).length > 0 ? (
                      (overridesBreakdown.user_info?.system_roles || []).map((r) => (
                        <span key={r} className="badge" style={{ background: "#dbeafe", color: "#1d4ed8", fontWeight: 600, fontSize: "11px", padding: "2px 8px" }}>
                          🛡️ {roleDisplayName(r)}
                        </span>
                      ))
                    ) : (
                      <span className="badge" style={{ background: "#f1f5f9", color: "#64748b", fontSize: "11px" }}>No Departments</span>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: "12px", color: "#475569", marginTop: "8px", lineHeight: 1.4 }}>
                  💡 Permissions marked <span className="chip-role" style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px" }}>FROM DEPARTMENT</span> are inherited from assigned departments. Check extra permissions to grant direct overrides (<span className="chip-grant" style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px" }}>+ EXTRA GRANTED</span>). Uncheck department permissions to deny them (<span className="chip-deny" style={{ fontSize: "10px", padding: "1px 6px", borderRadius: "4px" }}>✕ DIRECT DENIED</span>).
                </div>
              </div>

              {/* Search & Bulk Action Toolbar */}
              <div
                style={{
                  display: "flex",
                  gap: "10px",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ position: "relative", flex: 1, minWidth: "240px" }}>
                  <input
                    type="text"
                    placeholder="🔍 Search permission code or description..."
                    style={{
                      width: "100%",
                      padding: "8px 30px 8px 12px",
                      border: "1px solid #cbd5e1",
                      borderRadius: "6px",
                      fontSize: "13.5px",
                      background: "#ffffff",
                      boxSizing: "border-box",
                    }}
                    value={overridesSearch}
                    onChange={(e) => setOverridesSearch(e.target.value)}
                  />
                  {overridesSearch && (
                    <button
                      type="button"
                      onClick={() => setOverridesSearch("")}
                      style={{
                        position: "absolute",
                        right: 8,
                        top: "50%",
                        transform: "translateY(-50%)",
                        background: "none",
                        border: "none",
                        color: "#94a3b8",
                        cursor: "pointer",
                        fontSize: 14,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
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
                      setOverridesChecked(new Set(overridesBreakdown.role_permissions || []));
                    }}
                  >
                    🔄 Reset to Departments
                  </button>
                </div>
              </div>

              {/* Permission Groups */}
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
                  const checkedCountInMod = items.filter((p) => overridesChecked.has(p.code)).length;

                  return (
                    <div className="permission-group" key={modKey}>
                      <div className="permission-group-header">
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <span className="permission-group-title">
                            {MODULE_NAMES[modKey] || modKey.toUpperCase()}
                          </span>
                          <span style={{ fontSize: 11, background: "#e2e8f0", color: "#475569", padding: "1px 6px", borderRadius: 10, fontWeight: 600 }}>
                            {checkedCountInMod} / {items.length} active
                          </span>
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
                            <label
                              key={p.code}
                              style={{
                                border: checked
                                  ? isRoleGranted
                                    ? "1px solid #bfdbfe"
                                    : "1px solid #86efac"
                                  : isRoleGranted
                                    ? "1px solid #fca5a5"
                                    : "1px solid #e2e8f0",
                                background: checked
                                  ? isRoleGranted
                                    ? "#eff6ff"
                                    : "#f0fdf4"
                                  : isRoleGranted
                                    ? "#fef2f2"
                                    : "#ffffff",
                              }}
                            >
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
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
                                  <span style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
                                    {friendlyPermissionLabel(p.code)}
                                  </span>
                                  {checked && !isRoleGranted && (
                                    <span className="chip-grant" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4 }}>
                                      + EXTRA GRANTED
                                    </span>
                                  )}
                                  {!checked && isRoleGranted && (
                                    <span className="chip-deny" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4 }}>
                                      ✕ DIRECT DENIED
                                    </span>
                                  )}
                                  {checked && isRoleGranted && (
                                    <span className="chip-role" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4 }}>
                                      FROM DEPARTMENT
                                    </span>
                                  )}
                                </div>
                                <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", marginTop: 2 }}>
                                  {p.code}
                                </div>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* Sticky Drawer Footer */}
            {(() => {
              const roleGranted = new Set(overridesBreakdown.role_permissions || []);
              let extraGrants = 0;
              let roleInherited = 0;
              let directDenies = 0;
              for (const code of overridesChecked) {
                if (roleGranted.has(code)) roleInherited++;
                else extraGrants++;
              }
              for (const code of roleGranted) {
                if (!overridesChecked.has(code)) directDenies++;
              }

              return (
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "16px 24px",
                    background: "#ffffff",
                    borderTop: "1px solid #e2e8f0",
                    flexWrap: "wrap",
                    gap: 12,
                  }}
                >
                  <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: "12.5px" }}>
                    <span style={{ fontWeight: 600, color: "#0f172a" }}>
                      {overridesChecked.size} active permission{overridesChecked.size === 1 ? "" : "s"}
                    </span>
                    {roleInherited > 0 && (
                      <span className="chip-role" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>
                        {roleInherited} from department
                      </span>
                    )}
                    {extraGrants > 0 && (
                      <span className="chip-grant" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>
                        +{extraGrants} extra direct grant{extraGrants === 1 ? "" : "s"}
                      </span>
                    )}
                    {directDenies > 0 && (
                      <span className="chip-deny" style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4 }}>
                        -{directDenies} denied
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 12 }}>
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
              );
            })()}
          </div>
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