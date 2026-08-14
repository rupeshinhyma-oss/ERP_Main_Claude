/**
 * Role & Permission Management.
 *
 * Provides:
 * 1. System & Custom Roles list table matching ERP UI screenshots.
 * 2. Merged View/Edit Permission screen (with role renaming, select-all permissions,
 *    module group cards, and direct in-role user management to add/remove users).
 * 3. Individual user permission overrides & effective permission breakdown.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { ActionDropdown, type ActionDropdownEntry } from "@/components/ActionDropdown";
import { Banner, Can, Modal } from "@/components/ui";
import { TextField } from "@/components/fields";
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

import {
  friendlyPermissionLabel,
  groupPermissionsByModule,
  MODULE_NAMES,
} from "@/lib/permissionLabels";

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

  /* Viewing & Editing a single Role (Screenshot 4 view) */
  const [viewingRole, setViewingRole] = useState<Role | null>(null);
  const [roleName, setRoleName] = useState("");
  const [roleDescription, setRoleDescription] = useState("");
  const [checkedCodes, setCheckedCodes] = useState<Set<string>>(new Set());
  const [selectedUserToAdd, setSelectedUserToAdd] = useState("");
  const [userActionLoading, setUserActionLoading] = useState(false);

  /* Clone modal */
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneSourceId, setCloneSourceId] = useState("");
  const [cloneTargetId, setCloneTargetId] = useState("");

  const { guard: guardRowAction } = usePendingGuard<string>();
  const [roleSaving, setRoleSaving] = useState(false);
  const [cloneSubmitting, setCloneSubmitting] = useState(false);

  /* Users tab */
  const [selectedUserId, setSelectedUserId] = useState("");
  const [userBreakdown, setUserBreakdown] = useState<EffectivePermissionsBreakdown | null>(null);
  const [userTabStatus, setUserTabStatus] = useState<"idle" | "loading" | "ready">("idle");
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
      const res = await apiGet<ItemsPage<User>>("/users?page_size=200");
      setAllUsers(res.data.items || []);
    } catch (err) {
      setError(err);
    }
  }, []);

  /* --- Init: permissions, roles, users --- */
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
  }, [loadRoles, loadUsers, params]);

  const codeToId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const p of allPermissions) map[p.code] = p.id;
    return map;
  }, [allPermissions]);

  const permissionGroups = useMemo(
    () => groupPermissionsByModule(allPermissions),
    [allPermissions]
  );

  /* --- Open Role in View / Edit Permission screen --- */
  function openRoleView(role: Role | null) {
    if (!role) {
      // Create new role
      setViewingRole({
        id: "",
        name: "",
        description: "",
        permissions: [],
        is_system: false,
      });
      setRoleName("");
      setRoleDescription("");
      setCheckedCodes(new Set());
    } else {
      setViewingRole(role);
      setRoleName(role.name || "");
      setRoleDescription(role.description || "");
      setCheckedCodes(new Set(role.permissions || []));
    }
    setSelectedUserToAdd("");
  }

  function closeRoleView() {
    setViewingRole(null);
    setRoleName("");
    setRoleDescription("");
    setCheckedCodes(new Set());
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

  function toggleSelectAllPermissions() {
    if (checkedCodes.size === allPermissions.length) {
      setCheckedCodes(new Set());
    } else {
      setCheckedCodes(new Set(allPermissions.map((p) => p.code)));
    }
  }

  /* --- Users in this Role --- */
  const assignedUsersInRole = useMemo(() => {
    if (!viewingRole || !viewingRole.id) return [];
    return allUsers.filter((u) => {
      const uRoles = u.roles || [];
      return (
        uRoles.includes(viewingRole.name) ||
        uRoles.includes(viewingRole.id) ||
        (viewingRole.name === "admin" && uRoles.includes("super_admin"))
      );
    });
  }, [viewingRole, allUsers]);

  const availableUsersToAdd = useMemo(() => {
    if (!viewingRole || !viewingRole.id) return [];
    const assignedIds = new Set(assignedUsersInRole.map((u) => u.id));
    return allUsers.filter((u) => !assignedIds.has(u.id));
  }, [viewingRole, assignedUsersInRole, allUsers]);

  async function handleAddUserToRole() {
    if (!viewingRole?.id || !selectedUserToAdd) return;
    setUserActionLoading(true);
    try {
      await apiPost(`/users/${selectedUserToAdd}/roles`, { role_id: viewingRole.id });
      showToast("User added to role successfully!", "success");
      setSelectedUserToAdd("");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setUserActionLoading(false);
    }
  }

  async function handleRemoveUserFromRole(userId: string, username: string) {
    if (!viewingRole?.id) return;
    if (!confirm(`Remove user '${username}' from '${viewingRole.name}' role?`)) return;
    setUserActionLoading(true);
    try {
      await apiDelete(`/users/${userId}/roles/${viewingRole.id}`);
      showToast("User removed from role successfully!", "success");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setUserActionLoading(false);
    }
  }

  /* --- Save Role Name & Permissions --- */
  async function handleSaveRolePermissions(e?: React.FormEvent) {
    if (e) e.preventDefault();
    if (roleSaving) return;
    if (!roleName.trim()) {
      showToast("Role name is required.", "warning");
      return;
    }
    setError(null);
    setRoleSaving(true);
    try {
      const name = roleName.trim();
      const description = roleDescription.trim() || null;
      const desiredCodes = checkedCodes;

      let roleId = viewingRole?.id || "";
      if (roleId) {
        // Update existing role
        await apiPatch(`/rbac/roles/${roleId}`, { name, description });
      } else {
        // Create new role
        const newRole = await apiPost<Role>("/rbac/roles", {
          name,
          description,
          permission_codes: [],
        });
        roleId = newRole.data.id;
      }

      // Reconcile permissions
      const roleRes = await apiGet<Role>(`/rbac/roles/${roleId}`);
      const currentCodes = new Set(roleRes.data.permissions || []);
      for (const code of [...desiredCodes].filter((c) => !currentCodes.has(c))) {
        if (codeToId[code]) {
          await apiPost(`/rbac/roles/${roleId}/permissions`, { permission_id: codeToId[code] });
        }
      }
      for (const code of [...currentCodes].filter((c) => !desiredCodes.has(c))) {
        if (codeToId[code]) {
          await apiDelete(`/rbac/roles/${roleId}/permissions/${codeToId[code]}`);
        }
      }

      showToast("Role and permissions saved successfully!", "success");
      await loadRoles();
      await loadUsers();
      closeRoleView();
    } catch (err) {
      setError(err);
    } finally {
      setRoleSaving(false);
    }
  }

  async function handleDeleteRole(roleId: string, roleNameStr: string) {
    if (!confirm(`Are you sure you want to delete role '${roleNameStr}'?`)) return;
    await guardRowAction(`delete-role:${roleId}`, async () => {
      try {
        await apiDelete(`/rbac/roles/${roleId}`);
        showToast(`Role '${roleNameStr}' deleted successfully.`, "success");
        await loadRoles();
      } catch (err) {
        setError(err);
      }
    });
  }

  async function handleClone(e: React.FormEvent) {
    e.preventDefault();
    if (cloneSubmitting) return;
    setCloneSubmitting(true);
    try {
      const res = await apiPost<{ cloned_count: number }>("/rbac/clone-permissions", {
        source_type: "role",
        source_id: cloneSourceId,
        target_type: "role",
        target_id: cloneTargetId,
      });
      showToast(`Successfully cloned ${res.data.cloned_count} permission(s).`, "success");
      setCloneOpen(false);
      void loadRoles();
    } catch (err) {
      setError(err);
    } finally {
      setCloneSubmitting(false);
    }
  }

  /* --- Users tab loader & save --- */
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
      {`${u.display_name || u.username} (${u.email || u.username}) - Status: ${u.status || "ACTIVE"}`}
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

        {/* View / Edit Permission Screen (Matching Screenshot 4) */}
        {viewingRole ? (
          <div className="permission-edit-view">
            <div className="permission-edit-topbar">
              <div>
                <h1>Edit Permission</h1>
                <div className="role-title-heading">
                  Role: {roleName ? roleName.toUpperCase() : "NEW ROLE"}
                </div>
              </div>
              <button
                type="button"
                className="btn-back"
                onClick={closeRoleView}
              >
                ← BACK
              </button>
            </div>

            <Banner error={error} />

            {/* 1. Role Info & Name Change Card */}
            <div className="role-info-card">
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <h3 style={{ margin: 0, fontSize: "16px", color: "#1e293b", fontWeight: 700 }}>
                  Role Details
                </h3>
                {viewingRole.is_system && (
                  <span className="badge badge-neutral" style={{ background: "#e2e8f0", color: "#475569" }}>
                    System Role
                  </span>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "16px" }}>
                <TextField
                  id="roleNameInput"
                  label="Role Name *"
                  required
                  placeholder="e.g. Sales Executive, Manager"
                  value={roleName}
                  readOnly={Boolean(viewingRole.is_system && !isSuperAdmin)}
                  onChange={(v) => setRoleName(v)}
                />
                <TextField
                  id="roleDescInput"
                  label="Description (optional)"
                  placeholder="Brief description of role responsibilities"
                  value={roleDescription}
                  onChange={(v) => setRoleDescription(v)}
                />
              </div>
            </div>

            {/* 2. Permissions Matrix Card (Matching Screenshot 4) */}
            <div className="permission-modules-container">
              <div className="permission-modules-header">
                <div>
                  <h3 style={{ margin: 0, fontSize: "16px", color: "#1e293b", fontWeight: 700 }}>
                    Module Permissions
                  </h3>
                  <div className="muted" style={{ fontSize: "13px", marginTop: "2px" }}>
                    Configure access privileges for users assigned to this role.
                  </div>
                </div>
                <label className="select-all-permission-label">
                  <input
                    type="checkbox"
                    checked={allPermissions.length > 0 && checkedCodes.size === allPermissions.length}
                    onChange={toggleSelectAllPermissions}
                    style={{ width: "18px", height: "18px", accentColor: "#0061f2", cursor: "pointer" }}
                  />
                  <span>Select All Permissions</span>
                </label>
              </div>

              {Object.keys(permissionGroups)
                .sort()
                .map((modKey) => {
                  const items = permissionGroups[modKey];
                  const allCheckedInMod = items.every((p) => checkedCodes.has(p.code));

                  return (
                    <div className="permission-module-card" key={modKey}>
                      <div className="permission-module-title-row">
                        <div className="permission-module-title">
                          {MODULE_NAMES[modKey] || modKey.toUpperCase()}
                        </div>
                        <button
                          type="button"
                          className="toggle-btn"
                          onClick={() => toggleModule(modKey)}
                          style={{
                            background: "transparent",
                            border: "none",
                            color: "#0061f2",
                            fontSize: "12.5px",
                            fontWeight: 600,
                            cursor: "pointer",
                            padding: "2px 6px",
                          }}
                        >
                          {allCheckedInMod ? "Deselect Group" : "Select Group"}
                        </button>
                      </div>

                      <div className="permission-card-grid">
                        {items.map((p) => {
                          const isChecked = checkedCodes.has(p.code);
                          return (
                            <label key={p.code} className="permission-checkbox-item">
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleCode(p.code)}
                              />
                              <span>
                                {MODULE_NAMES[modKey] ? `${MODULE_NAMES[modKey]} ${friendlyPermissionLabel(p.code)}` : friendlyPermissionLabel(p.code)}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
            </div>

            {/* 3. In-Role User Management Section (Add / Remove Users in this Role) */}
            {viewingRole.id && (
              <div className="role-users-section">
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "12px" }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: "16px", color: "#1e293b", fontWeight: 700 }}>
                      👥 Users in this Role ({assignedUsersInRole.length})
                    </h3>
                    <div className="muted" style={{ fontSize: "13px", marginTop: "2px" }}>
                      Directly add or remove individual users to/from this role.
                    </div>
                  </div>

                  {canManage && (
                    <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                      <select
                        value={selectedUserToAdd}
                        onChange={(e) => setSelectedUserToAdd(e.target.value)}
                        style={{
                          padding: "7px 12px",
                          borderRadius: "6px",
                          border: "1px solid #cbd5e1",
                          fontSize: "13px",
                          minWidth: "220px",
                        }}
                      >
                        <option value="">-- Select User to Add --</option>
                        {availableUsersToAdd.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.display_name || u.username} ({u.email || u.username})
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn btn-primary"
                        style={{ padding: "7px 14px", fontSize: "13px" }}
                        disabled={!selectedUserToAdd || userActionLoading}
                        onClick={handleAddUserToRole}
                      >
                        {userActionLoading ? "Adding…" : "+ Add to Role"}
                      </button>
                    </div>
                  )}
                </div>

                {assignedUsersInRole.length === 0 ? (
                  <p className="muted" style={{ padding: "16px 0", margin: 0 }}>
                    No users currently assigned to this role.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="role-users-table">
                      <thead>
                        <tr>
                          <th>User</th>
                          <th>Username</th>
                          <th>Email</th>
                          <th>Mobile</th>
                          <th>Status</th>
                          <th style={{ textAlign: "right" }}>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {assignedUsersInRole.map((u) => (
                          <tr key={u.id}>
                            <td>
                              <strong>{u.full_name || u.display_name || u.username}</strong>
                            </td>
                            <td style={{ color: "#0061f2", fontWeight: 600 }}>{u.username}</td>
                            <td>{u.email || "—"}</td>
                            <td>{u.phone || "—"}</td>
                            <td>
                              <span
                                className={`badge ${
                                  (u.status || "").toUpperCase() === "ACTIVE"
                                    ? "badge-active"
                                    : "badge-inactive"
                                }`}
                              >
                                {u.status || "ACTIVE"}
                              </span>
                            </td>
                            <td style={{ textAlign: "right" }}>
                              {canManage && (
                                <button
                                  type="button"
                                  className="btn btn-small"
                                  style={{
                                    background: "#fee2e2",
                                    color: "#991b1b",
                                    border: "1px solid #fca5a5",
                                    padding: "3px 10px",
                                    fontSize: "12px",
                                    fontWeight: 600,
                                    borderRadius: "4px",
                                  }}
                                  disabled={userActionLoading}
                                  onClick={() => handleRemoveUserFromRole(u.id, u.username)}
                                  title="Remove user from this role"
                                >
                                  ❌ Remove
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Bottom Save Action Bar */}
            <div className="role-save-bar">
              <button
                type="button"
                className="btn"
                onClick={closeRoleView}
                disabled={roleSaving}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ minWidth: "140px" }}
                disabled={roleSaving}
                onClick={() => handleSaveRolePermissions()}
              >
                {roleSaving ? "Saving…" : "Save Changes"}
              </button>
            </div>
          </div>
        ) : (
          /* Main Roles Table Screen (Matching Screenshots 2 & 3) */
          <>
            <div className="page-header">
              <div>
                <h1>Roles &amp; Permissions</h1>
                <div className="page-subtitle">
                  Configure user access roles, system privileges, and permissions.
                </div>
              </div>
              <div className="page-header-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <Can permission="settings.manage">
                  <button
                    className="btn btn-primary"
                    style={{ background: "#0061f2", color: "#ffffff", padding: "8px 16px", borderRadius: "4px", fontWeight: 600 }}
                    onClick={() => openRoleView(null)}
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
                        showToast("Selected roles deleted successfully", "success");
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
                  Roles &amp; Permissions
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

              {/* Tab 1: System & Custom Roles Table View (Matching Screenshot 2 & 3) */}
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
                            : "29-06-2026 06:34 PM";

                          const rowActions: ActionDropdownEntry[] = [
                            {
                              key: "view",
                              label: "📝 View",
                              onClick: () => openRoleView(role),
                            },
                          ];

                          if (canDeleteThisRole) {
                            rowActions.push({
                              key: "delete",
                              label: "🗑️ Delete",
                              danger: true,
                              onClick: () => handleDeleteRole(role.id, role.name),
                            });
                          }

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
                              <td style={{ color: "#64748b" }}>{filteredRoles.length - idx}</td>
                              <td style={{ fontWeight: 600, color: "#1e293b" }}>
                                {role.name}
                              </td>
                              <td style={{ color: "#64748b", fontSize: "13px" }}>{formattedCreated}</td>
                              <td style={{ textAlign: "center" }}>
                                <ActionDropdown items={rowActions} iconOnly={true} />
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
                    </>
                  )}
                </div>
              </div>

              {/* Tab 3: Effective Permissions Breakdown */}
              <div className={`tab-content ${activeTab === "tab-effective" ? "active" : ""}`}>
                <div className="toolbar-row">
                  <div className="search-filter-box" style={{ maxWidth: "600px" }}>
                    <select
                      style={{ flex: 1 }}
                      value={effectiveUserId}
                      onChange={(e) => setEffectiveUserId(e.target.value)}
                    >
                      <option value="">Select User to calculate effective permissions...</option>
                      {userOptions}
                    </select>
                  </div>
                </div>

                {effectiveStatus === "idle" && (
                  <p className="muted">
                    Select a user above to compute their effective permissions and source resolution trace.
                  </p>
                )}
                {effectiveStatus === "loading" && (
                  <p className="muted">Calculating effective permissions...</p>
                )}
                {effectiveStatus === "ready" && effectiveBreakdown && (
                  <div>
                    {effectiveBreakdown.is_super_admin && (
                      <div className="item-card" style={{ borderLeft: "4px solid #10b981", background: "#f0fdf4" }}>
                        <strong style={{ color: "#166534" }}>Super Administrator Account</strong>
                        <div style={{ fontSize: "13px", color: "#15803d", marginTop: "4px" }}>
                          This user is a Super Administrator and automatically has full access to every module and action in the system.
                        </div>
                      </div>
                    )}

                    {effectiveBreakdown.user_info && (
                      <div className="item-card">
                        <div
                          style={{
                            fontWeight: 600,
                            color: "var(--color-primary)",
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
                            <div className="info-label">Assigned Roles</div>
                            <div className="info-value">
                              {(effectiveBreakdown.user_info.system_roles || []).join(", ") || "User"}
                            </div>
                          </div>
                          <div>
                            <div className="info-label">Account Status</div>
                            <div className="info-value">
                              <span
                                className={`badge ${
                                  effectiveBreakdown.user_info.status === "ACTIVE"
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
                    )}

                    <div className="item-card">
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: "12px",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        <h3 style={{ margin: 0 }}>
                          Resolved Permission Sources ({filteredEffectiveSources.length})
                        </h3>
                        <div style={{ display: "flex", gap: "8px" }}>
                          <input
                            type="text"
                            placeholder="Filter permissions..."
                            value={tableSearch}
                            onChange={(e) => setTableSearch(e.target.value)}
                            style={{
                              padding: "4px 8px",
                              fontSize: "13px",
                              border: "1px solid #cbd5e0",
                              borderRadius: "4px",
                            }}
                          />
                          <select
                            value={sourceFilter}
                            onChange={(e) => setSourceFilter(e.target.value)}
                            style={{
                              padding: "4px 8px",
                              fontSize: "13px",
                              border: "1px solid #cbd5e0",
                              borderRadius: "4px",
                            }}
                          >
                            <option value="">All Sources</option>
                            <option value="System Role">System Role</option>
                            <option value="Individual User">Individual User Override</option>
                          </select>
                        </div>
                      </div>

                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Permission Code</th>
                              <th>Module</th>
                              <th>Resolution Source</th>
                              <th>Granting Roles / Details</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredEffectiveSources.length ? (
                              filteredEffectiveSources.map((item) => (
                                <tr key={item.code}>
                                  <td>
                                    <code style={{ fontWeight: 600 }}>{item.code}</code>
                                  </td>
                                  <td>{MODULE_NAMES[item.module] || item.module}</td>
                                  <td>
                                    <span className={`badge ${sourceBadgeClass(item.source)}`}>
                                      {item.source}
                                    </span>
                                  </td>
                                  <td className="muted" style={{ fontSize: "12px" }}>
                                    {item.role_names && item.role_names.length
                                      ? item.role_names.join(", ")
                                      : item.override_type || "Direct Assignment"}
                                  </td>
                                </tr>
                              ))
                            ) : (
                              <tr>
                                <td colSpan={4} className="muted" style={{ textAlign: "center", padding: "16px" }}>
                                  No permission codes match filter criteria.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {/* Clone Role Modal */}
      <Modal
        open={cloneOpen}
        title="Clone Role Permissions"
        onClose={() => setCloneOpen(false)}
        cardStyle={{ maxWidth: "500px" }}
      >
        <form onSubmit={handleClone}>
          <div className="field" style={{ marginBottom: "16px" }}>
            <label htmlFor="cloneSourceId">Source Role (Copy From) *</label>
            <select
              id="cloneSourceId"
              required
              value={cloneSourceId}
              onChange={(e) => setCloneSourceId(e.target.value)}
            >
              <option value="">-- Select Source Role --</option>
              {allRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name + (r.is_system ? " (System)" : "")}
                </option>
              ))}
            </select>
          </div>

          <div className="field" style={{ marginBottom: "16px" }}>
            <label htmlFor="cloneTargetId">Target Role (Apply To) *</label>
            <select
              id="cloneTargetId"
              required
              value={cloneTargetId}
              onChange={(e) => setCloneTargetId(e.target.value)}
            >
              <option value="">-- Select Target Role --</option>
              {allRoles
                .filter((r) => r.id !== cloneSourceId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name + (r.is_system ? " (System)" : "")}
                  </option>
                ))}
            </select>
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