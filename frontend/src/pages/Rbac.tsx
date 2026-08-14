/**
 * Role & Permission Management. Ported from rbac.html.
 *
 * Three tabs: role defaults, per-user overrides, and an effective-permissions
 * inspector. Saving a role reconciles its permission set by diffing desired
 * against current and issuing only the needed grant/revoke calls -- the backend
 * exposes add and remove endpoints rather than a bulk replace.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, Modal } from "@/components/ui";
import { SelectField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { useAuth, usePendingGuard } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import { sourceBadgeClass } from "./EffectivePermissions";
import type {
  BulkPermissionOverrideItem,
  EffectivePermissionsBreakdown,
  ItemsPage,
  Permission,
  Role,
  User,
  UserPermissionOverride,
} from "@/types";

import { friendlyPermissionLabel, groupPermissionsByModule, MODULE_NAMES } from "@/lib/permissionLabels";

type TabId = "tab-roles" | "tab-users" | "tab-effective";

export function RbacPage() {
  const [params] = useSearchParams();
  const { hasPermission, isSuperAdmin } = useAuth();
  const showToast = useToast();
  const canManage = hasPermission("settings.manage");

  const [activeTab, setActiveTab] = useState<TabId>("tab-roles");
  const [allPermissions, setAllPermissions] = useState<Permission[]>([]);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [roleSearch, setRoleSearch] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [rolePageSize, setRolePageSize] = useState(50);

  /* Role modal */
  const [roleModalOpen, setRoleModalOpen] = useState(false);
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [checkedCodes, setCheckedCodes] = useState<Set<string>>(new Set());

  /* Clone modal */
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneSourceId, setCloneSourceId] = useState("");
  const [cloneTargetId, setCloneTargetId] = useState("");
  // Phase 7: double-submit guards. Role delete is per-row (keyed) so
  // deleting one role never disables another; the role-save and clone
  // modals are single-instance, so a plain boolean is enough for each.
  const { isPending: isRowActionPending, guard: guardRowAction } = usePendingGuard<string>();
  const [roleSubmitting, setRoleSubmitting] = useState(false);
  const [cloneSubmitting, setCloneSubmitting] = useState(false);

  /* Users tab */
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userBreakdown, setUserBreakdown] = useState<EffectivePermissionsBreakdown | null>(null);
  const [userTabStatus, setUserTabStatus] = useState<"idle" | "loading" | "ready">("idle");
  // Checkbox grid: which permission codes are currently checked (starts equal
  // to the effective set -- role grants plus/minus overrides -- and tracks
  // edits locally until Save Changes commits them as a bulk diff).
  const [checkedUserCodes, setCheckedUserCodes] = useState<Set<string>>(new Set());
  const [savingUserOverrides, setSavingUserOverrides] = useState(false);

  /* Effective tab */
  const [effectiveUserId, setEffectiveUserId] = useState("");
  const [effectiveBreakdown, setEffectiveBreakdown] =
    useState<EffectivePermissionsBreakdown | null>(null);
  const [effectiveStatus, setEffectiveStatus] = useState<"idle" | "loading" | "ready">("idle");
  const [tableSearch, setTableSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  const loadRoles = useCallback(async () => {
    setRolesLoading(true);
    try {
      const res = await apiGet<Role[]>("/rbac/roles");
      setAllRoles(res.data || []);
    } catch (err) {
      setError(err);
    } finally {
      setRolesLoading(false);
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const res = await apiGet<ItemsPage<User>>("/users?limit=200");
      setAllUsers(res.data.items || []);
    } catch (err) {
      setError(err);
    }
  }, []);

  /* --- Init: permissions, roles, users, then URL deep-linking --- */
  useEffect(() => {
    (async () => {
      try {
        const permsRes = await apiGet<Permission[]>("/rbac/permissions");
        setAllPermissions(permsRes.data || []);
        await Promise.all([loadRoles(), loadUsers()]);

        const tabParam = params.get("tab");
        if (tabParam === "tab-effective" || tabParam === "effective") setActiveTab("tab-effective");
        else if (tabParam === "tab-users" || tabParam === "users") setActiveTab("tab-users");

        const userParam = params.get("user_id");
        if (userParam) {
          if (tabParam === "tab-effective" || tabParam === "effective") {
            setEffectiveUserId(userParam);
          } else {
            setSelectedUserId(userParam);
          }
        }
      } catch (err) {
        setError(err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const codeToId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of allPermissions) map[p.code] = p.id;
    return map;
  }, [allPermissions]);

  const permissionGroups = useMemo(
    () => groupPermissionsByModule(allPermissions),
    [allPermissions]
  );

  /* --- Users tab loader --- */
  const refreshUserTab = useCallback(
    async (userId: string) => {
      if (!userId) {
        setUserBreakdown(null);
        setCheckedUserCodes(new Set());
        setUserTabStatus("idle");
        return;
      }
      setUserTabStatus("loading");
      try {
        const [effRes, userPermsRes] = await Promise.all([
          apiGet<EffectivePermissionsBreakdown>(`/rbac/users/${userId}/effective-permissions`),
          apiGet<UserPermissionOverride[]>(`/rbac/users/${userId}/permissions`),
        ]);
        setUserBreakdown(effRes.data);
        const overrides = userPermsRes.data || [];

        // A code is checked if it's explicitly GRANTed, or if it's role-
        // inherited and not explicitly DENYed. This mirrors the backend's own
        // resolution order (explicit override wins, role grant is the
        // fallback) so the grid opens showing exactly the effective set.
        const overrideMap = new Map(overrides.map((o) => [o.code, o.is_granted]));
        const roleGranted = new Set(effRes.data.role_permissions || []);
        const initialChecked = new Set<string>();
        for (const code of new Set([...overrideMap.keys(), ...roleGranted])) {
          const override = overrideMap.get(code);
          const checked = override === true || (override === undefined && roleGranted.has(code));
          if (checked) initialChecked.add(code);
        }
        setCheckedUserCodes(initialChecked);
        setUserTabStatus("ready");
      } catch (err) {
        setError(err);
        setUserTabStatus("idle");
      }
    },
    []
  );

  useEffect(() => {
    void refreshUserTab(selectedUserId);
  }, [selectedUserId, refreshUserTab]);

  /* --- Effective tab loader --- */
  useEffect(() => {
    if (!effectiveUserId) {
      setEffectiveBreakdown(null);
      setEffectiveStatus("idle");
      return;
    }
    let cancelled = false;
    setEffectiveStatus("loading");
    (async () => {
      try {
        const res = await apiGet<EffectivePermissionsBreakdown>(
          `/rbac/users/${effectiveUserId}/effective-permissions`
        );
        if (cancelled) return;
        setEffectiveBreakdown(res.data);
        setEffectiveStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setError(err);
        setEffectiveStatus("idle");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [effectiveUserId]);

  /* --- Role modal --- */
  function openRoleModal(role: Role | null) {
    setEditingRole(role);
    setRoleName(role ? role.name : "");
    setRoleDescription(role ? role.description || "" : "");
    setCheckedCodes(new Set(role?.permissions || []));
    setRoleModalOpen(true);
  }

  function toggleCode(code: string) {
    setCheckedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function toggleModule(modKey: string) {
    const items = permissionGroups[modKey] || [];
    const anyUnchecked = items.some((p) => !checkedCodes.has(p.code));
    setCheckedCodes((prev) => {
      const next = new Set(prev);
      items.forEach((p) => {
        if (anyUnchecked) next.add(p.code);
        else next.delete(p.code);
      });
      return next;
    });
  }

  async function handleRoleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (roleSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setError(null);
    const name = roleName.trim();
    const description = roleDescription.trim() || null;
    const desiredCodes = checkedCodes;

    setRoleSubmitting(true);
    try {
      let roleId = editingRole?.id || "";
      if (roleId) {
        await apiPatch(`/rbac/roles/${roleId}`, { name, description });
      } else {
        const newRole = await apiPost<Role>("/rbac/roles", {
          name,
          description,
          permission_codes: [],
        });
        roleId = newRole.data.id;
      }

      // Reconcile: grant what's newly checked, revoke what was unchecked.
      const roleRes = await apiGet<Role>(`/rbac/roles/${roleId}`);
      const currentCodes = new Set(roleRes.data.permissions || []);
      for (const code of [...desiredCodes].filter((c) => !currentCodes.has(c))) {
        await apiPost(`/rbac/roles/${roleId}/permissions`, { permission_id: codeToId[code] });
      }
      for (const code of [...currentCodes].filter((c) => !desiredCodes.has(c))) {
        await apiDelete(`/rbac/roles/${roleId}/permissions/${codeToId[code]}`);
      }

      await loadRoles();
      setRoleModalOpen(false);
    } catch (err) {
      setError(err);
    } finally {
      setRoleSubmitting(false);
    }
  }

  async function handleDeleteRole(roleId: string) {
    if (!confirm("Delete this system role?")) return;
    await guardRowAction(`delete-role:${roleId}`, async () => {
      try {
        await apiDelete(`/rbac/roles/${roleId}`);
        await loadRoles();
      } catch (err) {
        setError(err);
      }
    });
  }

  async function handleClone(e: React.FormEvent) {
    e.preventDefault();
    if (cloneSubmitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setCloneSubmitting(true);
    try {
      const res = await apiPost<{ cloned_count: number }>("/rbac/clone-permissions", {
        source_type: "role",
        source_id: cloneSourceId,
        target_type: "role",
        target_id: cloneTargetId,
      });
      alert(`Successfully cloned ${res.data.cloned_count} permission(s).`);
      setCloneOpen(false);
      void loadRoles();
    } catch (err) {
      setError(err);
    } finally {
      setCloneSubmitting(false);
    }
  }

  /**
   * Diff the checkbox grid's current state against what's role-granted, and
   * send only the overrides actually needed:
   *  - checked + NOT role-granted   -> explicit GRANT (the role alone wouldn't give it)
   *  - unchecked + role-granted     -> explicit DENY (revokes what the role would give)
   *  - checked + role-granted       -> no override needed, the role already grants it
   *  - unchecked + NOT role-granted -> no override needed, already absent
   *
   * The backend's bulk endpoint replaces this user's entire override set with
   * exactly what's sent, so the diff must include every override that should
   * exist afterward, not just what changed since the last save.
   */
  async function handleSaveUserOverrides() {
    if (!selectedUserId || !userBreakdown) return;
    setSavingUserOverrides(true);
    try {
      const roleGranted = new Set(userBreakdown.role_permissions || []);
      const overrides: BulkPermissionOverrideItem[] = [];
      for (const p of allPermissions) {
        const checked = checkedUserCodes.has(p.code);
        const isRoleGranted = roleGranted.has(p.code);
        if (checked && !isRoleGranted) {
          overrides.push({ permission_id: p.id, is_granted: true });
        } else if (!checked && isRoleGranted) {
          overrides.push({ permission_id: p.id, is_granted: false });
        }
      }
      await apiPut(`/rbac/users/${selectedUserId}/permissions/bulk`, { overrides });
      showToast("Permissions updated for user.", "success");
      await refreshUserTab(selectedUserId);
    } catch (err) {
      setError(err);
    } finally {
      setSavingUserOverrides(false);
    }
  }

  const filteredRoles = useMemo(() => {
    const q = roleSearch.toLowerCase();
    return allRoles.filter(
      (r) =>
        r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)
    );
  }, [allRoles, roleSearch]);

  const userOptions = allUsers.map((u) => (
    <option key={u.id} value={u.id}>
      {`${u.username} (${u.email}) - Status: ${u.status}`}
    </option>
  ));

  const effectiveSources = effectiveBreakdown?.permission_sources || [];
  const filteredEffectiveSources = useMemo(() => {
    const q = tableSearch.toLowerCase();
    return effectiveSources.filter((item) => {
      const matchesQ =
        item.code.toLowerCase().includes(q) || item.module.toLowerCase().includes(q);
      const matchesSource = !sourceFilter || item.source === sourceFilter;
      return matchesQ && matchesSource;
    });
  }, [effectiveSources, tableSearch, sourceFilter]);


  return (
    <AppShell activeKey="rbac" pageClassName="page-rbac">
      <main className="page">
        <Breadcrumb trail={["Roles & Permissions"]} />
        <div className="page-header">
          <div>
            <h1>Role &amp; Permission Management</h1>
            <div className="page-subtitle">
              Configure Role-Based Access Controls (RBAC) and Individual User Permission
              Overrides.
            </div>
          </div>
          <div className="page-header-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <Can permission="settings.manage">
              <button
                className="btn btn-primary"
                style={{ background: "#0061f2", color: "#ffffff", padding: "8px 16px", borderRadius: "4px", fontWeight: 600 }}
                onClick={() => openRoleModal(null)}
              >
                + ADD NEW
              </button>
            </Can>
            <Can permission="settings.manage">
              <button
                className="btn"
                style={{ background: "#10b981", color: "#ffffff", padding: "8px 16px", borderRadius: "4px", fontWeight: 600, border: "none" }}
                onClick={async () => {
                  if (!selectedRoleIds.length) {
                    showToast("Please select at least one role to delete", "info");
                    return;
                  }
                  if (confirm(`Are you sure you want to delete ${selectedRoleIds.length} selected role(s)?`)) {
                    for (const id of selectedRoleIds) {
                      try {
                        await apiDelete(`/rbac/roles/${id}`);
                      } catch {
                        // skip errors for protected roles
                      }
                    }
                    setSelectedRoleIds([]);
                    loadRoles();
                    showToast("Selected roles processed", "success");
                  }
                }}
              >
                DELETE
              </button>
            </Can>
            <Can permission="settings.manage">
              <button
                className="btn btn-secondary"
                onClick={() => {
                  setCloneSourceId("");
                  setCloneTargetId("");
                  setCloneOpen(true);
                }}
              >
                Clone Role Permissions
              </button>
            </Can>
          </div>
        </div>
        <Banner error={error} />

        <div className="card">
          <div className="tabs-nav" style={{ padding: "14px 20px 0", borderBottom: "1px solid #e2e8f0" }}>
            <button
              className={`tab-btn ${activeTab === "tab-roles" ? "active" : ""}`}
              onClick={() => setActiveTab("tab-roles")}
            >
              Roles (Default Permissions)
            </button>
            <button
              className={`tab-btn ${activeTab === "tab-users" ? "active" : ""}`}
              onClick={() => setActiveTab("tab-users")}
            >
              Individual User Overrides
            </button>
            <button
              className={`tab-btn ${activeTab === "tab-effective" ? "active" : ""}`}
              onClick={() => setActiveTab("tab-effective")}
            >
              Effective Permissions
            </button>
          </div>

          {/* Tab 1: System & Custom Roles Table View (Matching Image 4) */}
          <div className={`tab-content ${activeTab === "tab-roles" ? "active" : ""}`} style={{ padding: "0" }}>
            <div className="toolbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <select
                  value={rolePageSize}
                  onChange={(e) => setRolePageSize(Number(e.target.value))}
                  style={{ padding: "6px 12px", borderRadius: "4px", border: "1px solid #cbd5e1", width: "90px" }}
                >
                  <option value={10}>10</option>
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                </select>
                <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>Items/Page</span>
              </div>
              <div>
                <input
                  type="text"
                  placeholder="Search..."
                  value={roleSearch}
                  onChange={(e) => setRoleSearch(e.target.value)}
                  style={{ padding: "8px 14px", borderRadius: "4px", border: "1px solid #cbd5e1", width: "240px", fontSize: "13.5px" }}
                />
              </div>
            </div>

            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "40px", textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={filteredRoles.length > 0 && selectedRoleIds.length === filteredRoles.length}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedRoleIds(filteredRoles.map((r) => r.id));
                          } else {
                            setSelectedRoleIds([]);
                          }
                        }}
                      />
                    </th>
                    <th style={{ width: "80px" }}>
                      Sr. No. <span style={{ fontSize: "10px" }}>▾</span>
                    </th>
                    <th>Name</th>
                    <th>Created</th>
                    <th style={{ textAlign: "center", width: "80px" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rolesLoading ? (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", padding: "24px" }} className="muted">
                        Loading system roles...
                      </td>
                    </tr>
                  ) : filteredRoles.length ? (
                    filteredRoles.slice(0, rolePageSize).map((role, idx) => {
                      const isSelected = selectedRoleIds.includes(role.id);
                      const isSystem = Boolean(role.is_system);
                      const canEditThisRole =
                        canManage &&
                        (!isSystem || isSuperAdmin) &&
                        (role.name !== "super_admin" || isSuperAdmin);
                      const canDeleteThisRole = canManage && !isSystem && isSuperAdmin;
                      const formattedCreated = (role as unknown as Record<string, unknown>).created_at
                        ? new Date(String((role as unknown as Record<string, unknown>).created_at)).toLocaleString("en-GB", {
                          day: "2-digit",
                          month: "2-digit",
                          year: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })
                        : "07-08-2026 11:29 AM";

                      return (
                        <tr key={role.id}>
                          <td style={{ textAlign: "center" }}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={(e) => {
                                if (e.target.checked) {
                                  setSelectedRoleIds((prev) => [...prev, role.id]);
                                } else {
                                  setSelectedRoleIds((prev) => prev.filter((id) => id !== role.id));
                                }
                              }}
                            />
                          </td>
                          <td style={{ color: "#64748b" }}>{idx + 1}</td>
                          <td style={{ fontWeight: 600, color: "#1e293b", textTransform: "uppercase" }}>
                            {role.name}
                          </td>
                          <td style={{ color: "#64748b", fontSize: "13px" }}>{formattedCreated}</td>
                          <td style={{ textAlign: "center" }}>
                            <div style={{ display: "flex", gap: "6px", justifyContent: "center" }}>
                              {canEditThisRole && (
                                <button
                                  className="btn btn-small"
                                  style={{ padding: "4px 8px", fontSize: "12px" }}
                                  onClick={() => openRoleModal(role)}
                                  title="Edit Role"
                                >
                                  ✏️
                                </button>
                              )}
                              {canDeleteThisRole && (
                                <button
                                  className="btn btn-small btn-danger"
                                  style={{ padding: "4px 8px", fontSize: "12px", opacity: isRowActionPending(`delete-role:${role.id}`) ? 0.6 : 1 }}
                                  onClick={() => handleDeleteRole(role.id)}
                                  disabled={isRowActionPending(`delete-role:${role.id}`)}
                                  title="Delete Role"
                                >
                                  {isRowActionPending(`delete-role:${role.id}`) ? "…" : "🗑️"}
                                </button>
                              )}
                              {!canEditThisRole && !canDeleteThisRole && (
                                <span style={{ cursor: "pointer", color: "#64748b", fontSize: "16px" }}>⋮</span>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", padding: "24px" }} className="muted">
                        No roles found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Tab 2: Individual User Permissions */}
          <div className={`tab-content ${activeTab === "tab-users" ? "active" : ""}`}>
            <div className="toolbar-row">
              <div className="search-filter-box" style={{ maxWidth: "600px" }}>
                <select
                  style={{ flex: 1 }}
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                >
                  <option value="">Select User to inspect &amp; override permissions...</option>
                  {userOptions}
                </select>
              </div>
            </div>
            <div>
              {userTabStatus === "idle" && (
                <p className="muted">
                  Select a user above to view effective permissions and manage direct overrides.
                </p>
              )}
              {userTabStatus === "loading" && (
                <p className="muted">Calculating effective permissions...</p>
              )}
              {userTabStatus === "ready" && userBreakdown && (
                <>
                  <div className="item-card" style={{ borderLeft: "4px solid #3182ce" }}>
                    <div className="item-card-header">
                      <h3>Individual Permission Overrides</h3>
                      {canManage && !userBreakdown.is_super_admin && (
                        <button
                          type="button"
                          className="btn btn-small btn-primary"
                          disabled={savingUserOverrides}
                          onClick={() => void handleSaveUserOverrides()}
                        >
                          {savingUserOverrides ? "Saving..." : "Save Changes"}
                        </button>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: "13px", marginBottom: 0 }}>
                      {userBreakdown.is_super_admin
                        ? "This user is a Super Administrator and always has every permission — individual overrides do not apply."
                        : "Tick or untick permissions below to grant or revoke direct access for this user. Checked-but-greyed items are inherited from the user's assigned roles. Click Save Changes to apply immediately."}
                    </div>
                  </div>

                  {!userBreakdown.is_super_admin && (
                    <div className="item-card">
                      {Object.keys(permissionGroups)
                        .sort()
                        .map((modKey) => {
                          const items = permissionGroups[modKey];
                          const roleGranted = new Set(userBreakdown.role_permissions || []);
                          const allCheckedInMod = items.every((p) => checkedUserCodes.has(p.code));
                          return (
                            <div className="permission-group" key={modKey}>
                              <div className="permission-group-header">
                                <div className="permission-group-title">
                                  {MODULE_NAMES[modKey] || modKey.toUpperCase()}
                                </div>
                                {canManage && (
                                  <button
                                    type="button"
                                    className="toggle-btn"
                                    onClick={() => {
                                      setCheckedUserCodes((prev) => {
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
                                )}
                              </div>
                              <div className="permission-checks">
                                {items.map((p) => {
                                  const checked = checkedUserCodes.has(p.code);
                                  const isRoleGranted = roleGranted.has(p.code);
                                  return (
                                    <label key={p.code}>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={!canManage}
                                        onChange={() => {
                                          setCheckedUserCodes((prev) => {
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
                        })}
                    </div>
                  )}

                  <div className="item-card" style={{ marginTop: "16px" }}>
                    <h3>
                      Calculated Effective Permissions (
                      {userBreakdown.effective_permissions?.length || 0})
                    </h3>
                    <div className="muted" style={{ marginBottom: "12px", fontSize: "13px" }}>
                      Final effective permission set applied immediately on new requests:
                    </div>
                    <div>
                      {(userBreakdown.effective_permissions || []).map((c) => (
                        <span
                          className="chip"
                          style={{ background: "#f1f5f9", border: "1px solid #cbd5e0" }}
                          key={c}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="item-card" style={{ marginTop: "16px" }}>
                    <h4>From Assigned Roles ({userBreakdown.role_permissions?.length || 0})</h4>
                    <div>
                      {(userBreakdown.role_permissions || []).map((c) => (
                        <span className="chip" key={c}>
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Tab 3: Effective Permissions Inspector */}
          <div className={`tab-content ${activeTab === "tab-effective" ? "active" : ""}`}>
            <div
              className="info-card"
              style={{ borderLeft: "4px solid var(--color-primary, #3182ce)" }}
            >
              <label
                style={{
                  display: "block",
                  fontSize: "13px",
                  fontWeight: 600,
                  marginBottom: "6px",
                  color: "#334155",
                }}
              >
                Select User to Inspect Effective Access &amp; Permission Sources:
              </label>
              <select
                style={{
                  width: "100%",
                  maxWidth: "540px",
                  padding: "10px",
                  border: "1px solid #cbd5e0",
                  borderRadius: "6px",
                  fontSize: "14px",
                }}
                value={effectiveUserId}
                onChange={(e) => setEffectiveUserId(e.target.value)}
              >
                <option value="">Select User...</option>
                {userOptions}
              </select>
            </div>

            <div>
              {effectiveStatus === "idle" && (
                <p className="muted">Select a user above to view their effective access report.</p>
              )}
              {effectiveStatus === "loading" && (
                <p className="muted">Calculating effective permissions and tracing sources...</p>
              )}
              {effectiveStatus === "ready" && !effectiveBreakdown?.user_info && (
                <p className="muted">No access data available for selected user.</p>
              )}
              {effectiveStatus === "ready" && effectiveBreakdown?.user_info && (
                <>
                  <div className="info-card">
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 700,
                        color: "#1e293b",
                        marginBottom: "8px",
                      }}
                    >
                      User Information
                    </div>
                    <div className="info-grid">
                      <div>
                        <div className="info-label">Employee Name</div>
                        <div className="info-value">
                          {effectiveBreakdown.user_info.employee_name}
                        </div>
                      </div>
                      <div>
                        <div className="info-label">Username</div>
                        <div className="info-value">{effectiveBreakdown.user_info.username}</div>
                      </div>
                      <div>
                        <div className="info-label">Department</div>
                        <div className="info-value">{effectiveBreakdown.user_info.department}</div>
                      </div>
                      <div>
                        <div className="info-label">Designation</div>
                        <div className="info-value">{effectiveBreakdown.user_info.designation}</div>
                      </div>
                      <div>
                        <div className="info-label">Assigned Roles</div>
                        <div className="info-value">
                          {(effectiveBreakdown.user_info.system_roles || []).join(", ") || "User"}
                        </div>
                      </div>
                      <div>
                        <div className="info-label">Account Status</div>
                        <div className="info-value">
                          <span
                            className={`badge ${effectiveBreakdown.user_info.status === "ACTIVE"
                              ? "badge-success"
                              : "badge-warning"
                              }`}
                          >
                            {effectiveBreakdown.user_info.status}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="info-card">
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "12px",
                      }}
                    >
                      <div style={{ fontSize: "15px", fontWeight: 700, color: "#1e293b" }}>
                        Permission Sources ({effectiveSources.length})
                      </div>
                    </div>

                    <div className="filter-bar">
                      <input
                        type="text"
                        placeholder="Search permissions or modules..."
                        style={{ flex: 1, maxWidth: "320px" }}
                        value={tableSearch}
                        onChange={(e) => setTableSearch(e.target.value)}
                      />
                      <select
                        style={{ maxWidth: "200px" }}
                        value={sourceFilter}
                        onChange={(e) => setSourceFilter(e.target.value)}
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
                          <th>Permission Code</th>
                          <th>Module</th>
                          <th>Calculated Source</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredEffectiveSources.length === 0 ? (
                          <tr>
                            <td colSpan={3} className="muted" style={{ textAlign: "center" }}>
                              No permissions granted.
                            </td>
                          </tr>
                        ) : (
                          filteredEffectiveSources.map((item) => (
                            <tr key={item.code}>
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
                  </div>

                  <div className="info-card">
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 700,
                        color: "#1e293b",
                        marginBottom: "12px",
                      }}
                    >
                      Final Calculated Effective Permissions
                    </div>
                    <div>
                      {(effectiveBreakdown.effective_permissions || []).map((c) => (
                        <span
                          className="chip"
                          key={c}
                          style={{
                            background: "#f1f5f9",
                            border: "1px solid #cbd5e0",
                            padding: "4px 10px",
                            fontSize: "12px",
                            margin: "3px",
                            display: "inline-block",
                          }}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Create / Edit Role Permissions */}
      <Modal
        open={roleModalOpen}
        title={editingRole ? `Edit Role: ${editingRole.name}` : "New Role"}
        onClose={() => setRoleModalOpen(false)}
        cardStyle={{ maxWidth: "840px", width: "92vw" }}
      >
        <form onSubmit={handleRoleSubmit}>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "16px" }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="roleName">Role Name *</label>
              <input
                id="roleName"
                required
                minLength={2}
                maxLength={100}
                placeholder="e.g. Sales Manager, Accountant, Storekeeper"
                value={roleName}
                onChange={(e) => setRoleName(e.target.value)}
                disabled={Boolean(editingRole?.is_system)}
              />
            </div>
            <TextField
              id="roleDescription"
              label="Description"
              maxLength={255}
              placeholder="Brief summary of what this role does"
              value={roleDescription}
              onChange={setRoleDescription}
              style={{ marginBottom: 0 }}
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "12px",
            }}
          >
            <div className="section-title" style={{ margin: 0 }}>
              Module Permissions
            </div>
            <div>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setCheckedCodes(new Set(allPermissions.map((p) => p.code)))}
              >
                Select All
              </button>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setCheckedCodes(new Set())}
              >
                Deselect All
              </button>
            </div>
          </div>

          <div style={{ maxHeight: "52vh", overflowY: "auto", paddingRight: "6px" }}>
            {Object.keys(permissionGroups)
              .sort()
              .map((modKey) => {
                const items = permissionGroups[modKey];
                const allChecked = items.every((p) => checkedCodes.has(p.code));
                return (
                  <div className="permission-group" key={modKey}>
                    <div className="permission-group-header">
                      <div className="permission-group-title">
                        {MODULE_NAMES[modKey] || modKey.toUpperCase()}
                      </div>
                      <button
                        type="button"
                        className="toggle-btn"
                        onClick={() => toggleModule(modKey)}
                      >
                        {allChecked ? "Deselect Group" : "Select Group"}
                      </button>
                    </div>
                    <div className="permission-checks">
                      {items.map((p) => (
                        <label key={p.code}>
                          <input
                            type="checkbox"
                            className="perm-check"
                            value={p.code}
                            checked={checkedCodes.has(p.code)}
                            onChange={() => toggleCode(p.code)}
                          />
                          {friendlyPermissionLabel(p.code)}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={roleSubmitting}>
              {roleSubmitting ? "Saving…" : "Save Role"}
            </button>
            <button type="button" className="btn" onClick={() => setRoleModalOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>

      {/* Clone Permission Set */}
      <Modal
        open={cloneOpen}
        title="Clone Role Permissions"
        onClose={() => setCloneOpen(false)}
        cardStyle={{ maxWidth: "540px" }}
      >
        <form onSubmit={handleClone}>
          <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
            <SelectField
              id="cloneSourceId"
              label="Source Role"
              required
              value={cloneSourceId}
              onChange={setCloneSourceId}
            >
              <option value="">Select source role...</option>
              {allRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </SelectField>
            <SelectField
              id="cloneTargetId"
              label="Target Role"
              required
              value={cloneTargetId}
              onChange={setCloneTargetId}
            >
              <option value="">Select target role...</option>
              {allRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </SelectField>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={cloneSubmitting}>
              {cloneSubmitting ? "Cloning…" : "Clone Permissions"}
            </button>
            <button type="button" className="btn" onClick={() => setCloneOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </Modal>
    </AppShell>
  );
}