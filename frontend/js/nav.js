/**
 * Shared sidebar + topbar shell for the admin frontend.
 *
 * Call renderShell('masters-countries') from each page's inline script,
 * passing the key of the currently active nav item. Renders into
 * #sidebarMount and #topbarMount, which every page must include.
 */

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  building: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M6 22V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v18Z"/><path d="M6 12H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/><path d="M18 9h2a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-2"/><path d="M10 6h.01M14 6h.01M10 10h.01M14 10h.01M10 14h.01M14 14h.01M10 18h.01M14 18h.01"/></svg>',
  briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>',
  map: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
  ruler: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="m14.5 12.5 2-2a2.12 2.12 0 0 1 3 3l-2 2Z"/><path d="m9.5 7.5 2-2a2.12 2.12 0 0 1 3 3l-2 2"/><path d="m3.5 21.5 2-2"/><path d="m5.5 19.5 2 2"/><path d="M14.5 21.5 21.5 14.5"/><path d="M2.5 9.5 9.5 2.5"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M20.59 13.41 11 22l-9-9V4a2 2 0 0 1 2-2h9Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
  award: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="8" r="6"/><path d="M15.48 13.06 17 22l-5-3-5 3 1.52-8.94"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  layersplus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><polyline points="3.29 7 12 12 20.71 7"/><line x1="12" y1="22" x2="12" y2="12"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M1 3h15v13H1z"/><path d="M16 8h4l3 3v5h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>',
};

const NAV_SECTIONS = [
  {
    label: "Overview",
    items: [{ key: "dashboard", label: "Dashboard", href: "./index.html", icon: "dashboard" }],
  },
  {
    label: "Organization",
    items: [
      { key: "teams", label: "Teams", href: "./teams.html", icon: "users" },
    ],
  },
  {
    label: "Suppliers",
    items: [
      { key: "suppliers", label: "Supplier Profiles", href: "./suppliers.html", icon: "truck" },
    ],
  },
  {
    label: "Configurations",
    items: [
      { key: "masters-countries", label: "Countries", href: "./masters-countries.html", icon: "globe" },
      { key: "masters-states", label: "States", href: "./masters-states.html", icon: "map" },
      { key: "masters-cities", label: "Cities", href: "./masters-cities.html", icon: "pin" },
      { key: "masters-currencies", label: "Currencies", href: "./masters-currencies.html", icon: "coins" },
      { key: "masters-uom", label: "Units of Measurement", href: "./masters-uom.html", icon: "ruler" },
      { key: "masters-hsn", label: "HSN Codes", href: "./masters-hsn.html", icon: "tag" },
      { key: "masters-brands", label: "Brands", href: "./masters-brands.html", icon: "award" },
      { key: "masters-categories", label: "Categories", href: "./masters-categories.html", icon: "layers" },
      { key: "masters-subcategories", label: "Sub-Categories", href: "./masters-subcategories.html", icon: "layersplus" },
      { key: "masters-products", label: "Products", href: "./masters-products.html", icon: "box" },
    ],
  },
  {
    label: "Settings",
    items: [
      { key: "organization", label: "Organization Settings", href: "./organization.html", icon: "building" },
      { key: "users", label: "User Accounts & Passwords", href: "./users.html", icon: "users" },
      { key: "audit", label: "Audit Log", href: "./audit.html", icon: "clock" },
      { key: "rbac", label: "Roles & Permissions", href: "./rbac.html", icon: "shield" },
    ],
  },
];

const PAGE_TITLES = {
  dashboard: "Dashboard",
  organization: "Organization Settings",
  teams: "Teams",
  users: "User Accounts & Passwords",
  "masters-countries": "Countries",
  "masters-states": "States",
  "masters-cities": "Cities",
  "masters-currencies": "Currencies",
  "masters-uom": "Units of Measurement",
  "masters-hsn": "HSN Codes",
  "masters-brands": "Brands",
  "masters-categories": "Product Categories",
  "masters-subcategories": "Product Sub-Categories",
  "masters-products": "Products",
  suppliers: "Supplier Profiles",
  audit: "Audit Log",
  rbac: "Roles & Permissions",
};

function initials(name) {
  if (!name) return "?";
  return name.trim().slice(0, 2).toUpperCase();
}

const DEFAULT_BRAND_NAME = "ERP Admin";

/**
 * Resolve the sidebar's brand text from the Organization Settings' Company
 * Name, instead of a hardcoded product name. Cached in sessionStorage so
 * every page navigation doesn't re-fetch it, and fails gracefully (falls
 * back to a generic name) for users without the organization.manage
 * permission or before an organization profile has been created yet.
 */
async function resolveBrandName() {
  const cached = sessionStorage.getItem("erp_org_company_name");
  if (cached) return cached;
  try {
    const { data } = await apiGet("/organizations");
    const name = (data && data.company_name) || DEFAULT_BRAND_NAME;
    sessionStorage.setItem("erp_org_company_name", name);
    return name;
  } catch (e) {
    return DEFAULT_BRAND_NAME; // not created yet, or this user lacks organization.manage -- not an error to surface here
  }
}

/** Call after saving Organization Settings so the sidebar picks up a renamed company immediately. */
function invalidateBrandNameCache() {
  sessionStorage.removeItem("erp_org_company_name");
}

function renderShell(activeKey) {
  Auth.requireLogin();

  const profile = Auth.getProfile();
  const sidebarMount = document.getElementById("sidebarMount");
  const topbarMount = document.getElementById("topbarMount");

  if (sidebarMount) {
    const groups = NAV_SECTIONS.map((section) => {
      const items = section.items
        .map(
          (item) => `
        <a href="${item.href}" class="nav-item ${item.key === activeKey ? "active" : ""}">
          ${ICONS[item.icon] || ""}
          <span class="nav-label">${item.label}</span>
        </a>`
        )
        .join("");
      return `
        <div class="nav-group">
          <div class="nav-group-label">${section.label}</div>
          ${items}
        </div>`;
    }).join("");

    const displayName = profile ? escapeHtml(profile.username) : "User";

    sidebarMount.outerHTML = `
      <aside class="sidebar" id="sidebarMount">
        <div class="sidebar-brand">
          <div class="logo-mark" id="sidebarLogoMark">--</div>
          <span class="brand-text" id="sidebarBrandText">${DEFAULT_BRAND_NAME}</span>
        </div>
        <nav class="sidebar-nav">${groups}</nav>
        <div class="sidebar-footer">
          <div class="sidebar-user" id="sidebarUser" style="cursor:pointer;">
            <div class="avatar">${initials(displayName)}</div>
            <div class="user-meta">
              <div class="user-name">${displayName}</div>
              <div class="user-role">Administrator</div>
            </div>
          </div>
        </div>
      </aside>`;

    // Fill in the real company name once resolved -- rendered synchronously
    // above with a generic fallback first so the sidebar never waits on a
    // network round-trip before appearing.
    resolveBrandName().then((name) => {
      const brandTextEl = document.getElementById("sidebarBrandText");
      const logoMarkEl = document.getElementById("sidebarLogoMark");
      if (brandTextEl) brandTextEl.textContent = name;
      if (logoMarkEl) logoMarkEl.textContent = initials(name);
    });

    const userBtn = document.getElementById("sidebarUser");
    if (userBtn) {
      userBtn.addEventListener("click", async () => {
        if (!confirm("Log out?")) return;
        try {
          await apiPost("/auth/logout", { refresh_token: Auth.getRefreshToken() });
        } catch (e) {
          /* ignore -- clearing session locally regardless */
        }
        Auth.clear();
        window.location.href = "./login.html";
      });
    }
  }

  if (topbarMount) {
    const title = PAGE_TITLES[activeKey] || "";
    topbarMount.outerHTML = `
      <header class="topbar" id="topbarMount">
        <div class="topbar-search">
          ${ICONS.search}
          <input type="text" placeholder="Search ${title.toLowerCase()}..." disabled />
        </div>
        <div class="topbar-spacer"></div>
        <div class="topbar-actions">
          <button class="icon-btn" title="Notifications">${ICONS.bell}<span class="dot"></span></button>
          <button class="icon-btn" id="topbarLogout" title="Log out">${ICONS.logout}</button>
        </div>
      </header>`;

    const logoutBtn = document.getElementById("topbarLogout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        try {
          await apiPost("/auth/logout", { refresh_token: Auth.getRefreshToken() });
        } catch (e) {
          /* ignore */
        }
        Auth.clear();
        window.location.href = "./login.html";
      });
    }
  }
}

// Backwards-compatible alias: older pages call renderNav(key) directly.
function renderNav(activeKey) {
  renderShell(activeKey);
}