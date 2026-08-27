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
import { Banner, Modal } from "@/components/ui";
import { TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from "@/lib/api";
import { useAuth, usePendingGuard } from "@/lib/hooks";
import { useToast } from "@/lib/toast";
import type {
  BulkPermissionOverrideItem,
  EffectivePermissionsBreakdown,
  ItemsPage,
  Permission,
  Role,
  RoleDeletionImpact,
  User,
  UserPermissionOverride,
} from "@/types";

import {
  friendlyPermissionLabel,
  groupPermissionsByModule,
  MODULE_NAMES,
} from "@/lib/permissionLabels";

/**
 * Role names that are reserved by the system and can never be created,
 * renamed, or deleted from this screen -- mirrors
 * `app.rbac.service.RESERVED_ROLE_NAMES` on the backend. "super_admin" is
 * shown to users simply as "Admin": it's the single hardcoded bootstrap
 * account's role and isn't assignable to anyone else (see Users page).
 * "user" is the default role every other new account gets automatically.
 * "admin" is also blocked even though it isn't itself a real role: an
 * earlier version of this app used to seed a duplicate "admin" role
 * alongside "super_admin", and without blocking the literal name here too,
 * someone could recreate a same-named role through "+ ADD NEW", producing
 * two confusingly similar rows ("admin" and "Admin") in this list.
 */
const RESERVED_ROLE_NAMES = new Set(["super_admin", "user", "admin"]);

/** Friendly display name for a role -- "super_admin" reads as "Admin" everywhere in the UI. */
function roleDisplayName(name: string): string {
  if (name === "super_admin") return "Admin";
  if (name === "user") return "User";
  return name;
}

function formatRoleCreatedAt(value: unknown): string {
  if (!value) return "—";
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function RolesTableSkeletonRows({ count = 6 }: { count?: number }) {
  const roleWidths = ["55%", "70%", "45%", "65%", "50%", "60%"];
  return (
    <>
      {Array.from({ length: count }).map((_, idx) => (
        <tr key={`role-sk-row-${idx}`}>
          <td style={{ textAlign: "center", padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "16px", height: "16px", borderRadius: "4px", margin: "0 auto" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "24px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div
              className="skeleton-line"
              style={{ width: roleWidths[idx % roleWidths.length], height: "15px", borderRadius: "4px" }}
            />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "120px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px", textAlign: "center" }}>
            <div className="skeleton-line" style={{ width: "32px", height: "32px", borderRadius: "4px", margin: "0 auto" }} />
          </td>
        </tr>
      ))}
    </>
  );
}

export function RbacPage() {
  const { hasPermission } = useAuth();
  const showToast = useToast();
  const canManage = hasPermission("roles_permissions.action");
  const canCreateRole = hasPermission("roles_permissions.create");
  const canBulkDeleteRoles = hasPermission("roles_permissions.bulk_action");
  // The role-detail modal below is shared by both the "+ ADD NEW" (create)
  // and per-row "View"/edit flows: handleSaveRoleView() branches internally
  // into POST /rbac/roles (needs roles_permissions.create) when opened fresh,
  // or PATCH /rbac/roles/{id} (needs roles_permissions.action) when opened on
  // an existing role. The backend enforces the real, specific permission on
  // each of those two endpoints regardless of what the frontend shows; this
  // combined flag just decides whether to show the editable fields/Save
  // button at all, for either case.
  const canManageOrCreate = canManage || canCreateRole;

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
  const [selectedManagerToAdd, setSelectedManagerToAdd] = useState("");

  /* Per-user Permission Overrides drawer (opened from "Managers in this
   * Department" -- "Edit permissions" for one specific manager). Ported
   * from Users.tsx's identical drawer (same backend endpoints, same
   * override-resolution logic) so a manager's individual extra
   * permissions can be set directly on them, without any separate
   * "Manager role" object involved. */
  const [overridesUserId, setOverridesUserId] = useState<string | null>(null);
  const [overridesUsername, setOverridesUsername] = useState("");
  const [overridesBreakdown, setOverridesBreakdown] = useState<EffectivePermissionsBreakdown | null>(null);
  const [overridesChecked, setOverridesChecked] = useState<Set<string>>(new Set());
  const [overridesSearch, setOverridesSearch] = useState("");
  const [overridesLoading, setOverridesLoading] = useState(false);
  const [overridesSaving, setOverridesSaving] = useState(false);
  const [managerActionLoading, setManagerActionLoading] = useState(false);

  /* Clone modal */
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneSourceId, setCloneSourceId] = useState("");
  const [cloneTargetId, setCloneTargetId] = useState("");

  /* Delete-role reassignment modal: shown instead of a plain confirm()
     whenever the role being deleted still has users assigned, so their
     access doesn't just silently disappear. */
  const [deleteImpact, setDeleteImpact] = useState<RoleDeletionImpact | null>(null);
  const [deleteImpactLoading, setDeleteImpactLoading] = useState(false);
  const [reassignToRoleId, setReassignToRoleId] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const { guard: guardRowAction } = usePendingGuard<string>();
  const [roleSaving, setRoleSaving] = useState(false);
  const [cloneSubmitting, setCloneSubmitting] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

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
    setSelectedManagerToAdd("");
  }

  function closeRoleView() {
    setViewingRole(null);
    setRoleName("");
    setRoleDescription("");
    setCheckedCodes(new Set());
    setSelectedUserToAdd("");
    setSelectedManagerToAdd("");
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

  /* Managers for viewingRole */
  const assignedManagers = useMemo(() => {
    if (!viewingRole || !viewingRole.name) return [];
    const managerIdsInDept = new Set<string>();
    assignedUsers.forEach((u) => {
      if (u.manager_id) managerIdsInDept.add(u.manager_id);
    });
    return allUsers.filter((u) => managerIdsInDept.has(u.id));
  }, [allUsers, viewingRole, assignedUsers]);

  /**
   * Who's eligible to be PROMOTED to manager of this department.
   *
   * Deliberately drawn from `assignedUsers` (existing department members)
   * rather than `allUsers` (every user in the system) -- a manager IS a
   * regular member of this department, just with extra permissions on
   * top, not a separate person picked from anywhere. Offering the entire
   * user base here let someone be added as manager while a completely
   * unrelated person also sat in "Users in this Department" as if they
   * were two disconnected concepts, when they should be exactly the same
   * pool with an extra flag. Add someone to "Users in this Department"
   * first, then promote them here.
   */
  const unassignedManagers = useMemo(() => {
    if (!viewingRole || !viewingRole.name) return [];
    const assignedManagerIds = new Set(assignedManagers.map((m) => m.id));
    return assignedUsers.filter((u) => !assignedManagerIds.has(u.id));
  }, [assignedUsers, viewingRole, assignedManagers]);

  async function handleAddUserToRole() {
    if (!selectedUserToAdd || !viewingRole?.id) return;
    setUserActionLoading(true);
    try {
      await apiPost(`/users/${selectedUserToAdd}/roles`, { role_id: viewingRole.id });
      if (assignedManagers.length > 0) {
        await apiPatch(`/users/${selectedUserToAdd}`, { manager_id: assignedManagers[0].id });
      }
      showToast("User department updated.", "success");
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
      showToast("User removed from department (reassigned to User department).", "success");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setUserActionLoading(false);
    }
  }

  async function handleAddManagerToRole() {
    if (!selectedManagerToAdd || !viewingRole?.id || !viewingRole.name) return;
    setManagerActionLoading(true);
    try {
      // Keep the existing org-chart convenience: point every other member
      // of this department at the new manager (who they report to).
      const targets = assignedUsers.filter((u) => u.id !== selectedManagerToAdd);
      for (const u of targets) {
        await apiPatch(`/users/${u.id}`, { manager_id: selectedManagerToAdd });
      }
      if (targets.length === 0) {
        await apiPatch(`/users/${selectedManagerToAdd}`, { manager_id: selectedManagerToAdd });
      }
      showToast("Department manager assigned.", "success");
      setSelectedManagerToAdd("");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setManagerActionLoading(false);
    }
  }

  async function handleRemoveManagerFromRole(managerId: string) {
    if (!viewingRole?.id) return;
    setManagerActionLoading(true);
    try {
      const targets = assignedUsers.filter((u) => u.manager_id === managerId || u.id === managerId);
      for (const u of targets) {
        if (u.manager_id === managerId) {
          await apiPatch(`/users/${u.id}`, { manager_id: null });
        }
      }
      showToast("Department manager removed.", "success");
      await loadUsers();
    } catch (err) {
      setError(err);
    } finally {
      setManagerActionLoading(false);
    }
  }

  /**
   * Open the Permission Overrides drawer for ONE specific user -- ported
   * from Users.tsx's identical function (same endpoints, same
   * override-resolution logic: checked = explicit GRANT, or
   * department-inherited and not explicitly DENYed).
   */
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

  /** Bulk-diff save: only sends an override for codes that differ from the department-inherited default, ported from Users.tsx. */
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

  async function handleSaveRoleView() {
    if (!roleName.trim()) {
      showToast("Department name cannot be empty", "error");
      return;
    }
    if (!viewingRole?.id && RESERVED_ROLE_NAMES.has(roleName.trim().toLowerCase())) {
      showToast(`"${roleName.trim()}" is a reserved system department name and cannot be used.`, "error");
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

      showToast("Department and permissions saved successfully!", "success");
      await loadRoles();
      await loadUsers();
      closeRoleView();
    } catch (err) {
      setError(err);
    } finally {
      setRoleSaving(false);
    }
  }

  /**
   * Start the delete flow for a role: always check impact first. If no
   * users are assigned, delete immediately (same as before -- one click,
   * one confirm). If users ARE assigned, open the reassignment modal
   * instead of a plain confirm() dialog, since deleting the role out from
   * under them would silently strip their access with no trace.
   */
  async function handleDeleteRole(roleId: string, roleNameStr: string) {
    setDeleteImpactLoading(true);
    try {
      const { data: impact } = await apiGet<RoleDeletionImpact>(`/rbac/roles/${roleId}/deletion-impact`);
      if (!impact.affected_user_count) {
        if (!confirm(`Are you sure you want to delete department '${roleNameStr}'?`)) return;
        await guardRowAction(`delete-role:${roleId}`, async () => {
          try {
            await apiDelete(`/rbac/roles/${roleId}`);
            showToast(`Department '${roleNameStr}' deleted successfully.`, "success");
            await loadRoles();
          } catch (err) {
            setError(err);
          }
        });
        return;
      }
      // Users are assigned -- open the reassignment modal, defaulting the
      // target to the "user" role per the standing rule that every account
      // always falls back to at least the default role.
      const defaultUserRole = allRoles.find((r) => r.name === "user");
      setReassignToRoleId(defaultUserRole?.id || "");
      setDeleteImpact(impact);
    } catch (err) {
      setError(err);
    } finally {
      setDeleteImpactLoading(false);
    }
  }

  function closeDeleteImpactModal() {
    setDeleteImpact(null);
    setReassignToRoleId("");
  }

  async function handleConfirmDeleteWithReassignment() {
    if (!deleteImpact || !reassignToRoleId) return;
    setDeleteSubmitting(true);
    try {
      const { data } = await apiPost<{ reassigned_user_count: number }>(
        `/rbac/roles/${deleteImpact.role_id}/delete-with-reassignment`,
        { reassign_to_role_id: reassignToRoleId }
      );
      const targetName = roleDisplayName(
        allRoles.find((r) => r.id === reassignToRoleId)?.name || ""
      );
      showToast(
        `Department '${roleDisplayName(deleteImpact.role_name)}' deleted. ` +
        `${data.reassigned_user_count} user(s) moved to '${targetName}'.`,
        "success"
      );
      closeDeleteImpactModal();
      await Promise.all([loadRoles(), loadUsers()]);
    } catch (err) {
      setError(err);
    } finally {
      setDeleteSubmitting(false);
    }
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
      showToast("Department permissions cloned successfully!", "success");
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
        roleDisplayName(r.name).toLowerCase().includes(q) ||
        (r.description || "").toLowerCase().includes(q)
    );
  }, [allRoles, roleSearch]);

  /** Roles eligible for bulk selection/deletion -- system roles are excluded. */
  const selectableRoles = useMemo(
    () => filteredRoles.filter((r) => !RESERVED_ROLE_NAMES.has(r.name)),
    [filteredRoles]
  );

  return (
    <AppShell activeKey="rbac" pageClassName="page-rbac">
      <main className="page">
        <Breadcrumb trail={["Departments & Permissions"]} />

        {viewingRole ? (
          /* Merged View / Edit Department Screen */
          <div className="view-edit-role-container">
            <div className="page-header" style={{ marginBottom: "16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={closeRoleView}
                  style={{ padding: "6px 12px" }}
                >
                  ← Back to Departments
                </button>
                <div>
                  <h1 style={{ fontSize: "20px", fontWeight: 700, margin: 0 }}>
                    {viewingRole.id ? `Department: ${roleDisplayName(viewingRole.name)}` : "Create New Department"}
                  </h1>
                  <p className="page-subtitle" style={{ margin: "2px 0 0", fontSize: "13px" }}>
                    Configure department details, assigned permissions, and user memberships.
                  </p>
                </div>
              </div>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" className="btn btn-secondary" onClick={closeRoleView}>
                  Cancel
                </button>
                {canManageOrCreate && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={roleSaving}
                    onClick={handleSaveRoleView}
                  >
                    {roleSaving ? "Saving..." : "Save Department"}
                  </button>
                )}
              </div>
            </div>

            <Banner error={error} />

            <div style={{ display: "grid", gridTemplateColumns: "minmax(340px, 380px) 1fr", gap: "20px", alignItems: "start" }}>
              {/* Left Column: Department Details & Users */}
              <div style={{ display: "flex", flexDirection: "column", gap: "16px", minWidth: 0 }}>
                <div className="card" style={{ padding: "20px" }}>
                  <h3 style={{ fontSize: "15px", fontWeight: 600, margin: "0 0 16px" }}>Department Details</h3>
                  <div className="field" style={{ marginBottom: "14px" }}>
                    <TextField
                      id="role-name-input"
                      label="Department Name *"
                      value={roleName}
                      onChange={setRoleName}
                      readOnly={!canManageOrCreate || viewingRole.is_system}
                    />
                    {viewingRole.is_system && (
                      <span className="muted" style={{ fontSize: "12px", marginTop: "4px", display: "block" }}>
                        System department names cannot be renamed.
                      </span>
                    )}
                  </div>
                  <div className="field">
                    <TextField
                      id="role-desc-input"
                      label="Description"
                      value={roleDescription}
                      onChange={setRoleDescription}
                      readOnly={!canManageOrCreate}
                    />
                  </div>
                </div>

                {viewingRole.id && (
                  <div className="card" style={{ padding: "20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                      <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
                        Managers in this Department
                      </h3>
                      <span style={{ fontSize: "11.5px", background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: "10px", fontWeight: 700 }}>
                        {assignedManagers.length} manager{assignedManagers.length === 1 ? "" : "s"}
                      </span>
                    </div>
                    <p style={{ fontSize: "12.5px", color: "#64748b", margin: "0 0 14px" }}>
                      Each manager can be given extra permissions individually, on top of what other{" "}
                      {viewingRole.name} members already have. Click <strong>"Edit permissions"</strong> next
                      to a manager below to set what they can do specifically.
                    </p>

                    {canManageOrCreate && (
                      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center", width: "100%" }}>
                        <select
                          id="add-manager-to-role-select"
                          value={selectedManagerToAdd}
                          onChange={(e) => setSelectedManagerToAdd(e.target.value)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: "38px",
                            padding: "0 10px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            fontSize: "13px",
                            background: "#ffffff",
                            color: "#1e293b",
                            outline: "none",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                            cursor: "pointer",
                            textOverflow: "ellipsis",
                            overflow: "hidden",
                          }}
                        >
                          <option value="">-- Select manager to add --</option>
                          {unassignedManagers.map((u) => {
                            const currentRole = u.roles?.length ? roleDisplayName(u.roles[0]) : "User";
                            return (
                              <option key={u.id} value={u.id}>
                                {u.display_name || u.username} ({currentRole})
                              </option>
                            );
                          })}
                        </select>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!selectedManagerToAdd || managerActionLoading}
                          onClick={handleAddManagerToRole}
                          style={{
                            flexShrink: 0,
                            whiteSpace: "nowrap",
                            height: "38px",
                            padding: "0 14px",
                            borderRadius: "6px",
                            fontWeight: 600,
                            fontSize: "13px",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            cursor: !selectedManagerToAdd || managerActionLoading ? "not-allowed" : "pointer",
                            opacity: !selectedManagerToAdd ? 0.6 : 1,
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                          </svg>
                          {managerActionLoading ? "Adding..." : "Add"}
                        </button>
                      </div>
                    )}

                    <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#f8fafc" }}>
                      {assignedManagers.length ? (
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          {assignedManagers.map((u) => {
                            const initials = (u.display_name || u.username || "M").slice(0, 2).toUpperCase();
                            return (
                              <div
                                key={u.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  padding: "10px 14px",
                                  borderBottom: "1px solid #f1f5f9",
                                  background: "#ffffff",
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                                  <div
                                    style={{
                                      width: "32px",
                                      height: "32px",
                                      borderRadius: "50%",
                                      background: "#fef3c7",
                                      color: "#92400e",
                                      fontWeight: 700,
                                      fontSize: "12px",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      flexShrink: 0,
                                    }}
                                  >
                                    {initials}
                                  </div>
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, color: "#1e293b", fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {u.display_name || u.username}
                                    </div>
                                    <div style={{ fontSize: "11.5px", color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {u.email || u.username}
                                    </div>
                                  </div>
                                </div>
                                <div style={{ display: "flex", gap: "6px", flexShrink: 0, marginLeft: "8px" }}>
                                  {canManageOrCreate && (
                                    <button
                                      type="button"
                                      className="btn btn-small"
                                      style={{
                                        color: "#2563eb",
                                        background: "#eff6ff",
                                        border: "1px solid #bfdbfe",
                                        borderRadius: "4px",
                                        cursor: "pointer",
                                        fontSize: "12px",
                                        fontWeight: 600,
                                        padding: "4px 8px",
                                      }}
                                      onClick={() => openUserOverridesModal(u.id, u.display_name || u.username)}
                                      title="Set this manager's individual extra permissions"
                                    >
                                      🔑 Edit permissions
                                    </button>
                                  )}
                                  {canManageOrCreate && (
                                    <button
                                      type="button"
                                      className="btn btn-small"
                                      style={{
                                        color: "#ef4444",
                                        background: "#fef2f2",
                                        border: "1px solid #fecaca",
                                        borderRadius: "4px",
                                        cursor: "pointer",
                                        fontSize: "12px",
                                        fontWeight: 600,
                                        padding: "4px 8px",
                                      }}
                                      disabled={managerActionLoading}
                                      onClick={() => handleRemoveManagerFromRole(u.id)}
                                      title="Remove manager from this department"
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ textAlign: "center", padding: "28px 16px", color: "#64748b", fontSize: "13px" }}>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" style={{ margin: "0 auto 8px", display: "block" }}>
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                            <circle cx="9" cy="7" r="4"></circle>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                          </svg>
                          No managers currently assigned.
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {viewingRole.id && (
                  <div className="card" style={{ padding: "20px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                      <h3 style={{ fontSize: "15px", fontWeight: 700, margin: 0, color: "#0f172a" }}>
                        Users in this Department
                      </h3>
                      <span style={{ fontSize: "11.5px", background: "#e0e7ff", color: "#3730a3", padding: "2px 8px", borderRadius: "10px", fontWeight: 700 }}>
                        {assignedUsers.length} user{assignedUsers.length === 1 ? "" : "s"}
                      </span>
                    </div>

                    {canManageOrCreate && (
                      <div style={{ display: "flex", gap: "8px", marginBottom: "16px", alignItems: "center", width: "100%" }}>
                        <select
                          id="add-user-to-role-select"
                          value={selectedUserToAdd}
                          onChange={(e) => setSelectedUserToAdd(e.target.value)}
                          style={{
                            flex: 1,
                            minWidth: 0,
                            height: "38px",
                            padding: "0 10px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            fontSize: "13px",
                            background: "#ffffff",
                            color: "#1e293b",
                            outline: "none",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                            cursor: "pointer",
                            textOverflow: "ellipsis",
                            overflow: "hidden",
                          }}
                        >
                          <option value="">-- Select user to add --</option>
                          {unassignedUsers.map((u) => {
                            const currentRole = u.roles?.length ? roleDisplayName(u.roles[0]) : "User";
                            return (
                              <option key={u.id} value={u.id}>
                                {u.display_name || u.username} ({currentRole})
                              </option>
                            );
                          })}
                        </select>
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={!selectedUserToAdd || userActionLoading}
                          onClick={handleAddUserToRole}
                          style={{
                            flexShrink: 0,
                            whiteSpace: "nowrap",
                            height: "38px",
                            padding: "0 14px",
                            borderRadius: "6px",
                            fontWeight: 600,
                            fontSize: "13px",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "6px",
                            cursor: !selectedUserToAdd || userActionLoading ? "not-allowed" : "pointer",
                            opacity: !selectedUserToAdd ? 0.6 : 1,
                          }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                          </svg>
                          {userActionLoading ? "Adding..." : "Add"}
                        </button>
                      </div>
                    )}

                    <div style={{ maxHeight: "280px", overflowY: "auto", border: "1px solid #e2e8f0", borderRadius: "8px", background: "#f8fafc" }}>
                      {assignedUsers.length ? (
                        <div style={{ display: "flex", flexDirection: "column" }}>
                          {assignedUsers.map((u) => {
                            const initials = (u.display_name || u.username || "U").slice(0, 2).toUpperCase();
                            const isThisDeptManager = assignedManagers.some((m) => m.id === u.id);
                            return (
                              <div
                                key={u.id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  padding: "10px 14px",
                                  borderBottom: "1px solid #f1f5f9",
                                  background: "#ffffff",
                                }}
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
                                  <div
                                    style={{
                                      width: "32px",
                                      height: "32px",
                                      borderRadius: "50%",
                                      background: "#e0e7ff",
                                      color: "#4338ca",
                                      fontWeight: 700,
                                      fontSize: "12px",
                                      display: "flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      flexShrink: 0,
                                    }}
                                  >
                                    {initials}
                                  </div>
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, color: "#1e293b", fontSize: "13px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center", gap: "6px" }}>
                                      {u.display_name || u.username}
                                      {isThisDeptManager && (
                                        <span
                                          style={{
                                            fontSize: "10px",
                                            fontWeight: 700,
                                            color: "#92400e",
                                            background: "#fef3c7",
                                            padding: "1px 6px",
                                            borderRadius: "10px",
                                            flexShrink: 0,
                                          }}
                                        >
                                          MANAGER
                                        </span>
                                      )}
                                    </div>
                                    <div style={{ fontSize: "11.5px", color: "#64748b", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                      {u.email || u.username}
                                    </div>
                                  </div>
                                </div>
                                {canManageOrCreate && (
                                  <button
                                    type="button"
                                    className="btn btn-small"
                                    style={{
                                      color: "#ef4444",
                                      background: "#fef2f2",
                                      border: "1px solid #fecaca",
                                      borderRadius: "4px",
                                      cursor: "pointer",
                                      fontSize: "12px",
                                      fontWeight: 600,
                                      padding: "4px 8px",
                                      marginLeft: "8px",
                                      flexShrink: 0,
                                    }}
                                    disabled={userActionLoading}
                                    onClick={() => handleRemoveUserFromRole(u.id)}
                                    title="Remove user from this department"
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ textAlign: "center", padding: "28px 16px", color: "#64748b", fontSize: "13px" }}>
                          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5" style={{ margin: "0 auto 8px", display: "block" }}>
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                            <circle cx="9" cy="7" r="4"></circle>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                          </svg>
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
                      Toggle permissions granted to anyone in this department.
                    </span>
                  </div>
                  {canManageOrCreate && (
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
                            {canManageOrCreate && (
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
                                  disabled={!canManageOrCreate}
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
                <h1>Departments &amp; Permissions</h1>
                <div className="page-subtitle">Configure user access departments, system privileges, and permissions.</div>
              </div>
              <div className="page-header-actions">
                {canCreateRole && (
                  <button
                    type="button"
                    className="btn btn-add-new"
                    onClick={() => openRoleView(null)}
                  >
                    + ADD NEW
                  </button>
                )}
                {canBulkDeleteRoles && (
                  <button
                    type="button"
                    className="btn btn-bulk-actions"
                    disabled={bulkDeleting}
                    onClick={async () => {
                      if (!selectedRoleIds.length) {
                        showToast("Please select at least one department to delete", "info");
                        return;
                      }
                      const targets = selectedRoleIds.filter((id) => {
                        const r = allRoles.find((role) => role.id === id);
                        return r && !RESERVED_ROLE_NAMES.has(r.name);
                      });
                      if (!targets.length) {
                        showToast("The selected department(s) are system departments and cannot be deleted.", "error");
                        return;
                      }
                      if (!confirm(`Are you sure you want to delete ${targets.length} selected department(s)?`)) {
                        return;
                      }
                      setBulkDeleting(true);
                      let succeeded = 0;
                      let failed = 0;
                      for (const id of targets) {
                        try {
                          await apiDelete(`/rbac/roles/${id}`);
                          succeeded += 1;
                        } catch (err) {
                          failed += 1;
                          setError(err);
                        }
                      }
                      setSelectedRoleIds([]);
                      setBulkDeleting(false);
                      await loadRoles();
                      if (succeeded && !failed) {
                        showToast(`${succeeded} department(s) deleted successfully.`, "success");
                      } else if (succeeded && failed) {
                        showToast(`${succeeded} department(s) deleted; ${failed} could not be deleted.`, "info");
                      } else {
                        showToast("No departments could be deleted.", "error");
                      }
                    }}
                  >
                    {bulkDeleting ? "Deleting…" : "DELETE"}
                  </button>
                )}
                {canCreateRole && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      setCloneSourceId("");
                      setCloneTargetId("");
                      setCloneOpen(true);
                    }}
                  >
                    Clone Department Permissions
                  </button>
                )}
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
                          checked={
                            selectableRoles.length > 0 && selectedRoleIds.length === selectableRoles.length
                          }
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedRoleIds(selectableRoles.map((r) => r.id));
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
                      <RolesTableSkeletonRows count={6} />
                    ) : filteredRoles.length ? (
                      filteredRoles
                        .slice(0, rolePageSize)
                        .map((role, idx) => {
                          const isSelected = selectedRoleIds.includes(role.id);
                          const isReserved = RESERVED_ROLE_NAMES.has(role.name);
                          const isSystem = Boolean(role.is_system) || isReserved;
                          const canDeleteThisRole = canManage && !isSystem;
                          const formattedCreated = formatRoleCreatedAt(
                            (role as unknown as Record<string, unknown>).created_at
                          );

                          const rowActions: ActionDropdownEntry[] = [];
                          if (canManage) {
                            rowActions.push({
                              key: "view",
                              label: "📝 View",
                              onClick: () => openRoleView(role),
                            });

                            if (canDeleteThisRole) {
                              rowActions.push({
                                key: "delete",
                                label: deleteImpactLoading ? "🗑️ Checking…" : "🗑️ Delete",
                                danger: true,
                                onClick: () => handleDeleteRole(role.id, role.name),
                              });
                            }
                          }

                          return (
                            <tr key={role.id}>
                              <td style={{ textAlign: "center" }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  disabled={isReserved}
                                  title={isReserved ? "System departments cannot be deleted." : undefined}
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
                                {roleDisplayName(role.name)}
                                {isSystem && (
                                  <span
                                    style={{
                                      marginLeft: 8,
                                      fontSize: 10,
                                      fontWeight: 700,
                                      color: "#475569",
                                      background: "#e2e8f0",
                                      padding: "2px 6px",
                                      borderRadius: 10,
                                      verticalAlign: "middle",
                                    }}
                                  >
                                    SYSTEM
                                  </span>
                                )}
                              </td>
                              <td style={{ color: "#64748b", fontSize: "13px" }}>{formattedCreated}</td>
                              <td style={{ textAlign: "center" }}>
                                {canManage && rowActions.length > 0 ? (
                                  <ActionDropdown items={rowActions} iconOnly={true} />
                                ) : null}
                              </td>
                            </tr>
                          );
                        })
                    ) : (
                      <tr>
                        <td colSpan={5} style={{ textAlign: "center", padding: "24px" }} className="muted">
                          No departments found.
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

      {/* Clone Department Modal */}
      <Modal
        open={cloneOpen}
        variant="center"
        title="Clone Department Permissions"
        onClose={() => setCloneOpen(false)}
        cardStyle={{ maxWidth: "500px" }}
      >
        <form onSubmit={handleClone}>
          <div style={{ padding: "20px 24px" }}>
            <div className="field" style={{ marginBottom: "16px" }}>
              <label htmlFor="cloneSourceId">Source Department (Copy From) *</label>
              <select
                id="cloneSourceId"
                required
                value={cloneSourceId}
                onChange={(e) => setCloneSourceId(e.target.value)}
              >
                <option value="">-- Select Source Department --</option>
                {allRoles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {roleDisplayName(r.name) + (r.is_system ? " (System)" : "")}
                  </option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="cloneTargetId">Target Department (Apply To) *</label>
              <select
                id="cloneTargetId"
                required
                value={cloneTargetId}
                onChange={(e) => setCloneTargetId(e.target.value)}
              >
                <option value="">-- Select Target Department --</option>
                {allRoles
                  .filter((r) => r.id !== cloneSourceId && !RESERVED_ROLE_NAMES.has(r.name))
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {roleDisplayName(r.name)}
                    </option>
                  ))}
              </select>
              <span className="muted" style={{ fontSize: "12px", marginTop: "4px", display: "block" }}>
                System departments (Admin, User) cannot be overwritten as a clone target.
              </span>
            </div>
          </div>

          <div
            style={{
              padding: "14px 24px",
              background: "#f8fafc",
              borderTop: "1px solid #e2e8f0",
              display: "flex",
              justifyContent: "flex-end",
              gap: "10px",
            }}
          >
            <button type="button" className="btn btn-secondary" onClick={() => setCloneOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={cloneSubmitting}>
              {cloneSubmitting ? "Cloning…" : "Clone Permissions"}
            </button>
          </div>
        </form>
      </Modal>

      {/* Delete Department -- Reassign Affected Users Modal */}
      <Modal
        open={Boolean(deleteImpact)}
        variant="center"
        title="Delete Department & Reassign Users"
        onClose={closeDeleteImpactModal}
        cardStyle={{ maxWidth: "520px" }}
        locked={deleteSubmitting}
      >
        {deleteImpact && (
          <div>
            <div style={{ padding: "20px 24px" }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "12px",
                  padding: "12px 14px",
                  background: "#fffbeb",
                  border: "1px solid #fde68a",
                  borderRadius: "8px",
                  marginBottom: "16px",
                }}
              >
                <div style={{ fontSize: "18px", lineHeight: "1" }}>⚠️</div>
                <div style={{ fontSize: "13px", color: "#92400e", lineHeight: "1.4" }}>
                  <strong>{deleteImpact.affected_user_count}</strong> user
                  {deleteImpact.affected_user_count === 1 ? " is" : "s are"} currently assigned to the{" "}
                  <strong>{roleDisplayName(deleteImpact.role_name)}</strong> department. Since each user must have an active department, please choose which department to move them to before deleting.
                </div>
              </div>

              <div style={{ marginBottom: "16px" }}>
                <div style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", marginBottom: "6px" }}>
                  Affected User{deleteImpact.affected_user_count === 1 ? "" : "s"}:
                </div>
                <div
                  style={{
                    maxHeight: "140px",
                    overflowY: "auto",
                    border: "1px solid #e2e8f0",
                    borderRadius: "6px",
                    background: "#f8fafc",
                  }}
                >
                  <table style={{ width: "100%", fontSize: "13px" }}>
                    <tbody>
                      {deleteImpact.affected_users.map((u) => (
                        <tr key={u.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                          <td style={{ padding: "8px 12px" }}>
                            <div style={{ fontWeight: 600, color: "#1e293b" }}>{u.display_name}</div>
                            <div style={{ fontSize: "11.5px", color: "#64748b" }}>{u.username}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="field">
                <label htmlFor="reassignToRoleId" style={{ fontWeight: 600, fontSize: "13px", color: "#1e293b", marginBottom: "6px", display: "block" }}>
                  Move these users to *
                </label>
                <select
                  id="reassignToRoleId"
                  required
                  value={reassignToRoleId}
                  onChange={(e) => setReassignToRoleId(e.target.value)}
                  style={{
                    width: "100%",
                    height: "38px",
                    padding: "0 12px",
                    borderRadius: "6px",
                    border: "1px solid #cbd5e1",
                    fontSize: "13px",
                    background: "#ffffff",
                    color: "#1e293b",
                  }}
                >
                  <option value="">-- Select Department --</option>
                  {allRoles
                    .filter((r) => r.id !== deleteImpact.role_id && r.name !== "super_admin")
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {roleDisplayName(r.name) + (RESERVED_ROLE_NAMES.has(r.name) ? " (System)" : "")}
                      </option>
                    ))}
                </select>
                <span className="muted" style={{ fontSize: "12px", marginTop: "4px", display: "block" }}>
                  Defaults to the "User" department -- the standard fallback for anyone who loses a department.
                </span>
              </div>
            </div>

            <div
              style={{
                padding: "14px 24px",
                background: "#f8fafc",
                borderTop: "1px solid #e2e8f0",
                display: "flex",
                justifyContent: "flex-end",
                gap: "10px",
              }}
            >
              <button
                type="button"
                className="btn btn-secondary"
                onClick={closeDeleteImpactModal}
                disabled={deleteSubmitting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn"
                style={{
                  background: "#ef4444",
                  color: "#ffffff",
                  border: "none",
                  padding: "8px 16px",
                  borderRadius: "6px",
                  fontWeight: 600,
                  fontSize: "13px",
                  cursor: !reassignToRoleId || deleteSubmitting ? "not-allowed" : "pointer",
                }}
                disabled={!reassignToRoleId || deleteSubmitting}
                onClick={handleConfirmDeleteWithReassignment}
              >
                {deleteSubmitting ? "Deleting…" : "Reassign & Delete Department"}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Per-user Permission Overrides (opened from "Edit permissions" next to a manager above) */}
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
              {/* User Info & Assigned Departments Summary Banner */}
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
    </AppShell>
  );
}