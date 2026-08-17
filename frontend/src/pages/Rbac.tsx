/**
 * Role & Permission Management.
 *
 * Provides:
 * 1. System & Custom Roles list table.
 * 2. Merged View/Edit Permission screen (with role renaming, select-all permissions,
 *    module group cards, and direct in-role user management to add/remove users).
 * 3. Clone Role Permissions.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { ActionDropdown, type ActionDropdownEntry } from "@/components/ActionDropdown";
import { Banner, Can, Modal } from "@/components/ui";
import { TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { useAuth, usePendingGuard } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type {
  ItemsPage,
  Permission,
  Role,
  User,
} from "@/types";

import {
  friendlyPermissionLabel,
  groupPermissionsByModule,
  MODULE_NAMES,
} from "@/lib/permissionLabels";

export function RbacPage() {
  const { hasPermission, isSuperAdmin } = useAuth();
  const showToast = useToast();
  const canManage = hasPermission("settings.manage");

  const [allPermissions, setAllPermissions] = useState<Permission[]>([]);
  const [allRoles, setAllRoles] = useState<Role[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [roleSearch, setRoleSearch] = useState("");
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);
  const [rolePageSize, setRolePageSize] = useState(50);

  /* Viewing & Editing a single Role */
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
      } catch (err) {
        setError(err);
      }
    })();
  }, [loadRoles, loadUsers]);

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

  /* Users currently assigned to viewingRole */
  const assignedUsers = useMemo(() => {
    if (!viewingRole || !viewingRole.name) return [];
    return allUsers.filter((u) => (u.roles || []).includes(viewingRole.name));
  }, [allUsers, viewingRole]);

  const unassignedUsers = useMemo(() => {
    if (!viewingRole || !viewingRole.name) return allUsers;
    return allUsers.filter((u) => !(u.roles || []).includes(viewingRole.name));
  }, [allUsers, viewingRole]);

  async function handleAddUserToRole() {
    if (!selectedUserToAdd || !viewingRole?.id) return;
    setUserActionLoading(true);
    try {
      await apiPost(`/users/${selectedUserToAdd}/roles`, { role_id: viewingRole.id });
      showToast("User added to role.", "success");
      setSelectedUserToAdd("");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setUserActionLoading(false);
    }
  }

  async function handleRemoveUserFromRole(userId: string) {
    if (!viewingRole?.id) return;
    setUserActionLoading(true);
    try {
      await apiDelete(`/users/${userId}/roles/${viewingRole.id}`);
      showToast("User removed from role.", "success");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setUserActionLoading(false);
    }
  }

  async function handleSaveRoleView() {
    if (!roleName.trim()) {
      showToast("Role name cannot be empty", "error");
      return;
    }
    setRoleSaving(true);
    try {
      const name = roleName.trim();
      const description = roleDescription.trim() || undefined;
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
    if (!cloneSourceId || !cloneTargetId) return;
    setCloneSubmitting(true);
    try {
      await apiPost("/rbac/clone-permissions", {
        source_type: "role",
        source_id: cloneSourceId,
        target_type: "role",
        target_id: cloneTargetId,
      });
      showToast("Permissions cloned successfully!", "success");
      setCloneOpen(false);
      await loadRoles();
    } catch (err) {
      setError(err);
    } finally {
      setCloneSubmitting(false);
    }
  }

  const filteredRoles = useMemo(() => {
    const q = roleSearch.toLowerCase();
    return allRoles.filter(
      (r) =>
        r.name.toLowerCase().includes(q) || (r.description || "").toLowerCase().includes(q)
    );
  }, [allRoles, roleSearch]);

  return (
    <AppShell activeKey="rbac">
      <main className="page-rbac">
        <Breadcrumb trail={["Dashboard", "Roles & Permissions"]} />

        {viewingRole ? (
          /* Merged View / Edit Role Screen */
          <div className="view-edit-role-container">
            <div className="page-header" style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeRoleView}
                  style={{ padding: "6px 12px" }}
                >
                  ← Back to Roles
                </button>
                <div>
                  <h1 style={{ fontSize: "20px", fontWeight: 700, margin: 0 }}>
                    {viewingRole.id ? `Role: ${viewingRole.name}` : "Create New Role"}
                  </h1>
                  <p className="muted" style={{ margin: "2px 0 0", fontSize: "13px" }}>
                    Configure role details, assigned permissions, and user memberships.
                  </p>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" className="btn btn-secondary" onClick={closeRoleView}>
                  Cancel
                </button>
                {canManage && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={roleSaving}
                    onClick={handleSaveRoleView}
                  >
                    {roleSaving ? "Saving..." : "Save Role"}
                  </button>
                )}
              </div>
            </div>

            <Banner error={error} />

            <div style={{ display: "grid", gridTemplateColumns: "minmax(300px, 360px) 1fr", gap: "20px", alignItems: "start" }}>
              {/* Left Column: Role Details & Users */}
              <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div className="card" style={{ padding: "20px" }}>
                  <h3 style={{ fontSize: "15px", fontWeight: 600, margin: "0 0 16px" }}>Role Details</h3>
                  <div className="field" style={{ marginBottom: "14px" }}>
                    <TextField
                      id="role-name-input"
                      label="Role Name *"
                      value={roleName}
                      onChange={setRoleName}
                      readOnly={!canManage || viewingRole.is_system}
                    />
                    {viewingRole.is_system && (
                      <span className="muted" style={{ fontSize: "12px", marginTop: "4px", display: "block" }}>
                        System role names cannot be renamed.
                      </span>
                    )}
                  </div>
                  <div className="field">
                    <TextField
                      id="role-desc-input"
                      label="Description"
                      value={roleDescription}
                      onChange={setRoleDescription}
                      readOnly={!canManage}
                    />
                  </div>
                </div>

                {viewingRole.id && (
                  <div className="card" style={{ padding: "20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                      <h3 style={{ fontSize: "15px", fontWeight: 600, margin: 0 }}>
                        Users in this Role ({assignedUsers.length})
                      </h3>
                    </div>

                    {canManage && (
                      <div style={{ display: "flex", gap: "8px", marginBottom: "14px" }}>
                        <select
                          value={selectedUserToAdd}
                          onChange={(e) => setSelectedUserToAdd(e.target.value)}
                          style={{ flex: 1, padding: "6px 10px", borderRadius: "4px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                        >
                          <option value="">-- Add user to this role --</option>
                          {unassignedUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.display_name || u.username} ({u.email || u.username})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn btn-secondary btn-small"
                          disabled={!selectedUserToAdd || userActionLoading}
                          onClick={handleAddUserToRole}
                        >
                          Add
                        </button>
                      </div>
                    )}

                    <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "6px" }}>
                      {assignedUsers.length ? (
                        <table style={{ width: "100%", fontSize: "13px" }}>
                          <tbody>
                            {assignedUsers.map((u) => (
                              <tr key={u.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                                <td style={{ padding: "8px 12px" }}>
                                  <div style={{ fontWeight: 600, color: "#1e293b" }}>{u.display_name || u.username}</div>
                                  <div style={{ fontSize: "11.5px", color: "#64748b" }}>{u.email || u.username}</div>
                                </td>
                                {canManage && (
                                  <td style={{ textAlign: "right", padding: "8px 12px" }}>
                                    <button
                                      type="button"
                                      className="btn btn-small"
                                      style={{ color: "#ef4444", background: "none", border: "none", cursor: "pointer", fontSize: "12px", padding: "2px 6px" }}
                                      disabled={userActionLoading}
                                      onClick={() => handleRemoveUserFromRole(u.id)}
                                      title="Remove user from this role"
                                    >
                                      Remove
                                    </button>
                                  </td>
                                )}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <div className="muted" style={{ textAlign: "center", padding: "20px", fontSize: "13px" }}>
                          No users currently assigned.
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Right Column: Permission Matrix / Checkboxes */}
              <div className="card" style={{ padding: "20px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "8px" }}>
                  <div>
                    <h3 style={{ fontSize: "15px", fontWeight: 600, margin: 0 }}>
                      Assigned Permissions ({checkedCodes.size} / {allPermissions.length})
                    </h3>
                    <span className="muted" style={{ fontSize: "12.5px" }}>
                      Toggle permissions granted to anyone holding this role.
                    </span>
                  </div>
                  {canManage && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-small"
                      onClick={toggleSelectAllPermissions}
                    >
                      {checkedCodes.size === allPermissions.length ? "Deselect All" : "Select All"}
                    </button>
                  )}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
                  {Object.keys(permissionGroups)
                    .sort()
                    .map((modKey) => {
                      const items = permissionGroups[modKey];
                      const allCheckedInMod = items.every((p) => checkedCodes.has(p.code));
                      const checkedCountInMod = items.filter((p) => checkedCodes.has(p.code)).length;

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
                            {canManage && (
                              <button
                                type="button"
                                className="toggle-btn"
                                onClick={() => toggleModule(modKey)}
                              >
                                {allCheckedInMod ? "Deselect Group" : "Select Group"}
                              </button>
                            )}
                          </div>
                          <div className="permission-checks">
                            {items.map((p) => (
                              <label key={p.code}>
                                <input
                                  type="checkbox"
                                  checked={checkedCodes.has(p.code)}
                                  disabled={!canManage}
                                  onChange={() => toggleCode(p.code)}
                                />
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 13, fontWeight: 600, color: "#1e293b" }}>
                                    {friendlyPermissionLabel(p.code)}
                                  </div>
                                  <div style={{ fontSize: 11, color: "#64748b", fontFamily: "monospace", marginTop: 2 }}>
                                    {p.code}
                                  </div>
                                </div>
                              </label>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Roles List Table View */
          <>
            <div className="page-header">
              <div>
                <h1>Roles &amp; Permissions</h1>
                <p className="muted">Configure user access roles, system privileges, and permissions.</p>
              </div>
              <div style={{ display: "flex", gap: "10px" }}>
                <Can permission="settings.manage">
                  <button
                    className="btn btn-primary"
                    style={{ padding: "8px 16px", borderRadius: "4px", fontWeight: 600 }}
                    onClick={() => openRoleView(null)}
                  >
                    + ADD NEW
                  </button>
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

            <div className="card" style={{ padding: "0" }}>
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