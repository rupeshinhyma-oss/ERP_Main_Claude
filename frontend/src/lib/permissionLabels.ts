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
  product: "Products Master",
  category: "Categories",
  subcategory: "Sub-Categories",
  brand: "Brands",
  hsn: "HSN Codes",
  uom: "Units of Measurement (UOM)",
  currency: "Currencies",
  country: "Countries",
  state: "States",
  city: "Cities",
  employee: "Employees & HR",
  department: "Departments",
  designation: "Designations",
  organization: "Organizations",
  supplier: "Supplier Profiles",
  audit: "System Audit Logs",
  settings: "System Settings",
  rbac: "Roles & Permissions",
  crm: "Commercial (Buyers & Inquiries)",
};

const ACTION_LABELS: Record<string, string> = {
  read: "👁️ View",
  create: "➕ Create",
  update: "✏️ Edit",
  delete: "🗑️ Delete",
  manage: "⚙️ Manage All",
};

/** "product.create" -> "➕ Create"; unknown actions fall back to the raw code. */
export function friendlyPermissionLabel(code: string): string {
  const parts = code.split(".");
  const action = parts[parts.length - 1];
  return ACTION_LABELS[action] || code;
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
