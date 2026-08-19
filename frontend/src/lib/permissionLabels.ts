/**
 * Shared permission display helpers.
 *
 * Used by both the Roles & Permissions page (role editor, user-override
 * checkbox grid) and the Users page (per-user permission overrides modal
 * opened from the row action menu) so a permission code renders identically
 * -- same friendly label, same module grouping -- no matter which page you
 * manage it from.
 */

import type { Permission } from "@/types";

/** Friendly category names for permission modules. */
export const MODULE_NAMES: Record<string, string> = {
  dashboard: "Dashboard",
  company: "Companies",
  buyer: "Agents & Buyers",
  buyertype: "Buyer Types",
  supplier: "Suppliers",
  suppliertype: "Supplier Types",
  inquiry: "Proforma & Inquiries",
  planning: "Shipment Planning",
  product: "Products Master",
  category: "Categories",
  subcategory: "Sub-Categories",
  brand: "Brands",
  hsn: "HSN Codes",
  uom: "Units of Measurement (UOM)",
  currency: "Currencies",
  country: "Countries",
  state: "States & Provinces",
  city: "Cities",
  user: "Users & Accounts",
  organization: "Organizations",
  audit: "System Audit Logs",
  settings: "System Settings",
  rbac: "Roles & Permissions",
  crm: "Commercial (Buyers & Inquiries)",
};

const ACTION_LABELS: Record<string, string> = {
  read: "View",
  view: "View",
  create: "Create",
  update: "Edit",
  delete: "Delete",
  export: "Export",
  import: "Import",
  approve: "Approve",
  manage: "Manage All",
  bulk_action: "Bulk Actions",
  grade_edit: "Edit Grade",
  potential_edit: "Edit Potential",
};

/** "product.create" -> "Create"; unknown actions fall back to the raw code. */
export function friendlyPermissionLabel(code: string): string {
  const parts = code.split(".");
  const action = parts[parts.length - 1];
  return ACTION_LABELS[action] || parts.slice(1).join(" ") || code;
}

export function groupPermissionsByModule(permissions: Permission[]): Record<string, Permission[]> {
  const groups: Record<string, Permission[]> = {};
  for (const p of permissions) {
    const modKey = p.module || p.code.split(".")[0];
    if (!groups[modKey]) groups[modKey] = [];
    groups[modKey].push(p);
  }
  return groups;
}

/**
 * Role names that are reserved by the system -- mirrors
 * `app.rbac.service.RESERVED_ROLE_NAMES` on the backend. "super_admin" is
 * the single hardcoded bootstrap admin account's role (shown to users as
 * "Admin") and cannot be assigned to anyone else. "user" is the default
 * role every other new account gets automatically. "admin" is blocked too,
 * so a same-named duplicate role can't be recreated after being retired.
 */
export const RESERVED_ROLE_NAMES = new Set(["super_admin", "user", "admin"]);

/**
 * Friendly display name for a role name coming back from the API.
 * "super_admin" reads as "Admin" and "user" as "User" everywhere in the
 * UI -- used by the Roles & Permissions page, the Users page, and the
 * Shipment Planning column role-lock picker so a role name renders
 * identically no matter where it's shown.
 */
export function roleDisplayName(name: string): string {
  if (name === "super_admin") return "Admin";
  if (name === "employee" || name === "user") return "User";
  return name;
}