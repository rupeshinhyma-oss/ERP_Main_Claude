/**
 * Sidebar structure and page titles.
 *
 * Ported from NAV_SECTIONS / PAGE_TITLES in nav.js. Labels, ordering, group
 * names, icons and permission codes are unchanged; the `.html` hrefs become
 * router paths.
 */

import type { IconKey } from "@/components/icons";

export interface NavItem {
  key: string;
  label: string;
  path: string;
  icon: IconKey;
  permission?: string;
  superAdminOnly?: boolean;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: "DASHBOARD",
    items: [
      { key: "dashboard", label: "Dashboard", path: "/dashboard", icon: "dashboard" },
    ],
  },
  {
    label: "CONTACT",
    items: [
      { key: "suppliers", label: "Suppliers", path: "/suppliers", icon: "users", permission: "supplier.view" },
      { key: "buyers", label: "Buyers", path: "/buyers", icon: "user", permission: "buyer.view" },
    ],
  },

  {
    label: "INVENTORY",
    items: [
      { key: "masters-products", label: "Product Master", path: "/masters/products", icon: "box", permission: "product.view" },
      { key: "product-gallery", label: "Product Gallery", path: "/product-gallery", icon: "grid", permission: "product.view" },
      { key: "masters-categories", label: "Categories", path: "/masters/categories", icon: "folder", permission: "category.view" },
      { key: "masters-subcategories", label: "Sub Categories", path: "/masters/subcategories", icon: "folder", permission: "subcategory.view" },
      { key: "masters-brands", label: "Brands", path: "/masters/brands", icon: "tag", permission: "brand.view" },
    ],
  },
  {
    label: "SALE",
    items: [
      { key: "proforma", label: "Inquiries", path: "/inquiries", icon: "fileText", permission: "inquiry.view" },
    ],
  },
  {
    label: "PLANNING",
    items: [
      { key: "planning", label: "Shipment Planning", path: "/planning", icon: "grid", permission: "planning.read" },
    ],
  },
  {
    label: "TEAM",
    items: [
      { key: "teams", label: "Teams", path: "/teams", icon: "users", permission: "employee.view" },
      { key: "users", label: "Users", path: "/users", icon: "user", permission: "user.view" },
      { key: "rbac", label: "Roles & Permissions", path: "/rbac", icon: "shield", permission: "settings.manage" },
    ],
  },
  {
    label: "CONFIGURATIONS",
    items: [
      { key: "masters-hsn", label: "HSN Codes", path: "/masters/hsn", icon: "tag", permission: "hsn.view" },
      { key: "masters-countries", label: "Countries", path: "/masters/countries", icon: "globe", permission: "country.view" },
      { key: "masters-states", label: "Provinces", path: "/masters/states", icon: "map", permission: "state.view" },
      { key: "masters-cities", label: "City", path: "/masters/cities", icon: "pin", permission: "city.view" },
      { key: "masters-currencies", label: "Currencies", path: "/masters/currencies", icon: "coins", permission: "currency.view" },
      { key: "masters-uom", label: "Units of Measurement", path: "/masters/uom", icon: "ruler", permission: "uom.view" },
      { key: "organization", label: "Organization Settings", path: "/organization", icon: "building", permission: "organization.manage", superAdminOnly: true },
      { key: "audit", label: "Audit Log", path: "/audit", icon: "clock", permission: "audit.view" },
      { key: "trash", label: "Trash", path: "/trash", icon: "trash" },
    ],
  },
];

export const PAGE_TITLES: Record<string, string> = {
  trash: "Trash Management",
  dashboard: "Dashboard",
  tasks: "Tasks & Work Management",
  reports: "Reports & Analytics",
  buyers: "Agents & Buyers",
  inquiries: "Proforma & Sales",
  planning: "Shipment Planning",
  crm: "Customer Relationship Management",
  sales: "Sales Process",
  purchase: "Purchasing",
  inventory: "Inventory & Stock",
  manufacturing: "Manufacturing",
  finance: "Finance & Accounts",
  hrms: "Human Resource Management",
  organization: "Organization Settings",
  teams: "Teams",
  users: "Users",
  "masters-countries": "Countries (National Level)",
  "masters-states": "Provinces (First Level Divisions)",
  "masters-cities": "Prefectures & Counties (Second & Third Level)",
  "masters-currencies": "Currencies",
  "masters-uom": "Units of Measurement",
  "masters-hsn": "HSN Codes",
  "masters-brands": "Brands",
  "masters-categories": "Categories",
  "masters-subcategories": "Sub Categories",
  "masters-products": "Product Master",
  suppliers: "Suppliers",
  audit: "Audit Log",
  rbac: "Roles & Permissions",
  "effective-permissions": "Effective Permissions Inspector",
  "employee-form": "Employee Form",
  "employee-detail": "Employee Detail",
  "403": "Access Restricted",
};

export const DEFAULT_BRAND_NAME = "YINGLIMA";

/** Flat lookup of every nav item by key, for the page-access check. */
export const NAV_ITEMS_BY_KEY: Record<string, NavItem> = NAV_SECTIONS.reduce(
  (acc, section) => {
    section.items.forEach((item) => {
      acc[item.key] = item;
    });
    return acc;
  },
  {} as Record<string, NavItem>
);

/**
 * Old filename -> new path, for bookmark compatibility.
 *
 * Single source of truth for App.tsx's redirect routes AND for resolving the
 * legacy `./whatever.html` targets the backend's universal search endpoint
 * still emits (app/search/service.py predates the SPA rewrite and was never
 * updated to know about client-side routes) -- see resolveLegacyUrl below.
 */
export const LEGACY_REDIRECTS: Record<string, string> = {
  "/index.html": "/dashboard",
  "/login.html": "/login",
  "/403.html": "/403",
  "/organization.html": "/organization",
  "/audit.html": "/audit",
  "/users.html": "/users",
  "/rbac.html": "/rbac",
  "/effective-permissions.html": "/effective-permissions",
  "/teams.html": "/teams",
  "/suppliers.html": "/suppliers",
  "/tasks.html": "/tasks",
  "/buyers.html": "/buyers",
  "/inquiries.html": "/inquiries",
  "/masters-countries.html": "/masters/countries",
  "/masters-states.html": "/masters/states",
  "/masters-cities.html": "/masters/cities",
  "/masters-currencies.html": "/masters/currencies",
  "/masters-uom.html": "/masters/uom",
  "/masters-hsn.html": "/masters/hsn",
  "/masters-brands.html": "/masters/brands",
  "/masters-categories.html": "/masters/categories",
  "/masters-subcategories.html": "/masters/subcategories",
  "/masters-products.html": "/masters/products",
  // Both of these were already redirect-only stubs in the original.
  "/employee-detail.html": "/users",
  "/employee-form.html": "/users",
};

/**
 * Resolve any URL the app might be handed -- a real React path already
 * (`/masters/products`), a legacy absolute path (`/users.html`), or a legacy
 * relative path as emitted by the backend's universal search results
 * (`./users.html`) -- into the React route to navigate to.
 */
export function resolveLegacyUrl(url: string): string {
  const absolute = url.startsWith("./") ? url.slice(1) : url;
  return LEGACY_REDIRECTS[absolute] ?? absolute;
}
