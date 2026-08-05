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
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  fileText: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
};

const NAV_SECTIONS = [
  {
    label: "Overview",
    items: [
      { key: "dashboard", label: "Dashboard", href: "./index.html", icon: "dashboard" },
      { key: "tasks", label: "Tasks", href: "./tasks.html", icon: "task", permission: "task.view" },
    ],
  },
  {
    label: "Commercial",
    items: [
      { key: "buyers", label: "Buyer Profiles", href: "./buyers.html", icon: "users" },
      { key: "suppliers", label: "Supplier Profiles", href: "./suppliers.html", icon: "truck", permission: "supplier.view" },
    ],
  },
  {
    label: "Operations",
    items: [
      { key: "inquiries", label: "Inquiries & Consignments", href: "./inquiries.html", icon: "fileText" },
    ],
  },
  {
    label: "Organization & HR",
    items: [
      { key: "teams", label: "Teams", href: "./teams.html", icon: "users", permission: "employee.view" },
    ],
  },
  {
    label: "Configurations",
    items: [
      { key: "masters-products", label: "Products Master", href: "./masters-products.html", icon: "box", permission: "product.view" },
      { key: "masters-categories", label: "Categories", href: "./masters-categories.html", icon: "layers", permission: "category.view" },
      { key: "masters-subcategories", label: "Sub-Categories", href: "./masters-subcategories.html", icon: "layersplus", permission: "subcategory.view" },
      { key: "masters-brands", label: "Brands", href: "./masters-brands.html", icon: "award", permission: "brand.view" },
      { key: "masters-hsn", label: "HSN Codes", href: "./masters-hsn.html", icon: "tag", permission: "hsn.view" },
      { key: "masters-countries", label: "Countries", href: "./masters-countries.html", icon: "globe", permission: "country.view" },
      { key: "masters-states", label: "States", href: "./masters-states.html", icon: "map", permission: "state.view" },
      { key: "masters-cities", label: "Cities", href: "./masters-cities.html", icon: "pin", permission: "city.view" },
      { key: "masters-currencies", label: "Currencies", href: "./masters-currencies.html", icon: "coins", permission: "currency.view" },
      { key: "masters-uom", label: "Units of Measurement", href: "./masters-uom.html", icon: "ruler", permission: "uom.view" },
    ],
  },
  {
    label: "Settings",
    items: [
      { key: "organization", label: "Organization Settings", href: "./organization.html", icon: "building", permission: "organization.manage", superAdminOnly: true },
      { key: "users", label: "User Accounts & Passwords", href: "./users.html", icon: "users", permission: "user.view" },
      { key: "audit", label: "Audit Log", href: "./audit.html", icon: "clock", permission: "audit.view" },
      { key: "rbac", label: "Roles & Permissions", href: "./rbac.html", icon: "shield", permission: "settings.manage" },
    ],
  },
];

function getDynamicNavSections() {
  return NAV_SECTIONS;
}

const PAGE_TITLES = {
  dashboard: "Dashboard",
  tasks: "Tasks & Work Management",
  buyers: "Buyer Profiles",
  suppliers: "Supplier Profiles",
  inquiries: "Inquiries & Consignments",
  teams: "Teams",
  organization: "Organization Settings",
  users: "User Accounts & Passwords",
  "masters-products": "Products Master",
  "masters-categories": "Product Categories",
  "masters-subcategories": "Product Sub-Categories",
  "masters-brands": "Brands",
  "masters-hsn": "HSN Codes",
  "masters-countries": "Countries",
  "masters-states": "States",
  "masters-cities": "Cities",
  "masters-currencies": "Currencies",
  "masters-uom": "Units of Measurement",
  audit: "Audit Log",
  rbac: "Roles & Permissions",
  "effective-permissions": "Effective Permissions Inspector",
  "employee-form": "Employee Form",
  "employee-detail": "Employee Detail",
  "403": "Access Restricted",
};

function initials(name) {
  if (!name) return "?";
  return name.trim().slice(0, 2).toUpperCase();
}

const DEFAULT_BRAND_NAME = "ERP Admin";

const NAV_SCROLL_KEY = "erp_sidebar_nav_scroll";

/**
 * Put `.sidebar-nav` where the user left it, before the first paint.
 */
function positionNavScroll(navEl) {
  const maxScroll = Math.max(0, navEl.scrollHeight - navEl.clientHeight);
  if (maxScroll === 0) return;

  const saved = parseInt(sessionStorage.getItem(NAV_SCROLL_KEY) || "", 10);
  if (Number.isFinite(saved) && saved > 0) {
    navEl.scrollTop = Math.min(saved, maxScroll);
  }

  const active = navEl.querySelector(".nav-item.active");
  if (!active) return;

  const navBox = navEl.getBoundingClientRect();
  const itemBox = active.getBoundingClientRect();
  if (itemBox.top >= navBox.top && itemBox.bottom <= navBox.bottom) return;

  const centreOffset = (navEl.clientHeight - itemBox.height) / 2;
  navEl.scrollTop = Math.min(
    maxScroll,
    Math.max(0, navEl.scrollTop + (itemBox.top - navBox.top) - centreOffset)
  );
}

function persistNavScroll(navEl) {
  const save = () => {
    try {
      sessionStorage.setItem(NAV_SCROLL_KEY, String(Math.round(navEl.scrollTop)));
    } catch (e) { }
  };
  let queued = false;
  navEl.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        save();
      });
    },
    { passive: true }
  );
  window.addEventListener("beforeunload", save);
}

async function resolveBrandName() {
  const cached = sessionStorage.getItem("erp_org_company_name");
  if (cached) return cached;
  try {
    const { data } = await apiGet("/organizations");
    const name = (data && data.company_name) || DEFAULT_BRAND_NAME;
    sessionStorage.setItem("erp_org_company_name", name);
    return name;
  } catch (e) {
    return DEFAULT_BRAND_NAME;
  }
}

function invalidateBrandNameCache() {
  sessionStorage.removeItem("erp_org_company_name");
}

function renderForcePasswordChangeModal() {
  if (document.getElementById("forcePasswordModal")) return;
  const overlay = document.createElement("div");
  overlay.id = "forcePasswordModal";
  overlay.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.75);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;";
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:12px;padding:32px;max-width:440px;width:100%;box-shadow:0 20px 25px -5px rgba(0,0,0,0.1);">
      <h2 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#1a202c;">Password Change Required</h2>
      <p style="margin:0 0 20px 0;font-size:14px;color:#4a5568;">Your account requires a password change before continuing to the ERP.</p>
      <div id="forcePasswordError" style="margin-bottom:12px;"></div>
      <form id="forcePasswordForm">
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:#2d3748;">Current / Temporary Password</label>
          <input type="password" id="forceCurrentPwd" required style="width:100%;padding:10px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;" />
        </div>
        <div style="margin-bottom:16px;">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:#2d3748;">New Password</label>
          <input type="password" id="forceNewPwd" required style="width:100%;padding:10px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;" />
        </div>
        <div style="margin-bottom:24px;">
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:6px;color:#2d3748;">Confirm New Password</label>
          <input type="password" id="forceConfirmPwd" required style="width:100%;padding:10px 12px;border:1px solid #cbd5e0;border-radius:6px;font-size:14px;" />
        </div>
        <button type="submit" id="forceSubmitBtn" class="btn btn-primary" style="width:100%;padding:12px;font-size:14px;font-weight:600;border-radius:6px;cursor:pointer;">Update Password & Continue</button>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const form = document.getElementById("forcePasswordForm");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const current_password = document.getElementById("forceCurrentPwd").value;
    const new_password = document.getElementById("forceNewPwd").value;
    const confirm_password = document.getElementById("forceConfirmPwd").value;
    const errContainer = document.getElementById("forcePasswordError");
    errContainer.innerHTML = "";
    if (new_password !== confirm_password) {
      showError(errContainer, new Error("New password and confirm password do not match."));
      return;
    }
    const btn = document.getElementById("forceSubmitBtn");
    btn.disabled = true;
    btn.textContent = "Updating...";
    try {
      await apiPost("/auth/change-password", { current_password, new_password });
      const profile = Auth.getProfile();
      if (profile) {
        profile.must_change_password = false;
        Auth.updateProfile(profile);
      }
      overlay.remove();
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Update Password & Continue";
      showError(errContainer, err);
    }
  });
}

function renderShell(activeKey) {
  Auth.requireLogin();

  const sections = getDynamicNavSections();

  // Background sync latest profile & permissions from backend
  if (Auth.getAccessToken()) {
    apiGet("/auth/profile").then((res) => {
      if (res && res.data) {
        Auth.updateProfile(res.data);
      }
    }).catch(() => {});
  }

  const profile = Auth.getProfile();
  const isSuperAdmin = profile && Array.isArray(profile.roles) && profile.roles.includes("super_admin");

  if (profile && profile.must_change_password) {
    renderForcePasswordChangeModal();
  }

  // Check page level access permission
  const currentNavItem = sections.flatMap((s) => s.items).find((i) => i.key === activeKey);
  let accessDenied = false;
  if (currentNavItem) {
    if (currentNavItem.superAdminOnly && !isSuperAdmin) {
      accessDenied = true;
    } else if (currentNavItem.permission && !Auth.hasPermission(currentNavItem.permission)) {
      accessDenied = true;
    }
  }

  if (accessDenied && activeKey !== "403" && !window.location.pathname.endsWith("403.html")) {
    window.location.href = `./403.html?module=${encodeURIComponent(PAGE_TITLES[activeKey] || activeKey)}`;
    return;
  }

  const sidebarMount = document.getElementById("sidebarMount");
  const topbarMount = document.getElementById("topbarMount");

  function buildSidebarNavHtml() {
    const activeSections = getDynamicNavSections();
    return activeSections.map((section) => {
      const visibleItems = section.items.filter((item) => {
        if (item.superAdminOnly && !isSuperAdmin) return false;
        return !item.permission || Auth.hasPermission(item.permission);
      });
      if (visibleItems.length === 0) return "";
      const items = visibleItems
        .map(
          (item) => `
        <a href="${item.href}" class="nav-item ${item.key === activeKey ? "active" : ""}">
          ${ICONS[item.icon] || ICONS.box}
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
  }

  if (sidebarMount) {
    const groups = buildSidebarNavHtml();
    const displayName = profile ? escapeHtml(profile.username) : "User";
    const displayRole = profile && Array.isArray(profile.roles) && profile.roles.includes("super_admin")
      ? "Super Administrator"
      : profile && Array.isArray(profile.roles) && profile.roles.includes("admin")
        ? "Administrator"
        : "User";

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
              <div class="user-role">${displayRole}</div>
            </div>
          </div>
        </div>
      </aside>`;

    const navEl = document.querySelector(".sidebar-nav");
    if (navEl) {
      positionNavScroll(navEl);
      persistNavScroll(navEl);
    }

    resolveBrandName().then((name) => {
      const brandTextEl = document.getElementById("sidebarBrandText");
      const logoMarkEl = document.getElementById("sidebarLogoMark");
      if (brandTextEl) brandTextEl.textContent = name;
      if (logoMarkEl) logoMarkEl.textContent = initials(name);

      const titlePrefix = PAGE_TITLES[activeKey] || (document.title ? document.title.split(" — ")[0] : "ERP");
      document.title = `${titlePrefix} — ${name}`;
    });

    const userBtn = document.getElementById("sidebarUser");
    if (userBtn) {
      userBtn.addEventListener("click", async () => {
        if (!confirm("Log out?")) return;
        try {
          await apiPost("/auth/logout", { refresh_token: Auth.getRefreshToken() });
        } catch (e) { }
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
          <div style="position:relative;" id="notificationWrapper">
            <button class="icon-btn" id="topbarBellBtn" title="Notifications" style="position:relative; cursor:pointer;">
              ${ICONS.bell}
              <span id="topbarBellBadge" style="display:none; position:absolute; top:-2px; right:-2px; background:#dc2626; color:#ffffff; font-size:10px; font-weight:800; padding:1px 5px; border-radius:10px; min-width:16px; text-align:center; border:2px solid #ffffff;">0</span>
            </button>
            <div id="notificationDropdown" style="display:none; position:absolute; right:0; top:42px; width:340px; background:#ffffff; border:1px solid #cbd5e1; border-radius:10px; box-shadow:0 12px 28px rgba(0,0,0,0.15); z-index:99999; overflow:hidden;">
              <div style="padding:12px 16px; border-bottom:1px solid #e2e8f0; font-weight:700; font-size:13.5px; display:flex; justify-content:space-between; align-items:center; background:#f8fafc;">
                <span style="color:#1e293b;">Notifications</span>
                <span id="notificationHeaderBadge" style="font-size:11px; background:#e0e7ff; color:#2563eb; padding:2px 8px; font-weight:700; border-radius:10px;">0 new</span>
              </div>
              <div id="notificationItemsList" style="max-height:320px; overflow-y:auto; padding:4px 0;">
                <div style="padding:24px; text-align:center; color:#64748b; font-size:13px;">No unhandled notifications</div>
              </div>
            </div>
          </div>
          <button class="icon-btn" id="topbarLogout" title="Log out">${ICONS.logout}</button>
        </div>
      </header>`;

    const logoutBtn = document.getElementById("topbarLogout");
    if (logoutBtn) {
      logoutBtn.addEventListener("click", async () => {
        try {
          await apiPost("/auth/logout", { refresh_token: Auth.getRefreshToken() });
        } catch (e) { }
        Auth.clear();
        window.location.href = "./login.html";
      });
    }

    const bellBtn = document.getElementById("topbarBellBtn");
    const dropdown = document.getElementById("notificationDropdown");
    if (bellBtn && dropdown) {
      bellBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = dropdown.style.display === "block";
        dropdown.style.display = isOpen ? "none" : "block";
      });
      document.addEventListener("click", (e) => {
        if (!dropdown.contains(e.target) && e.target !== bellBtn) {
          dropdown.style.display = "none";
        }
      });
    }

    setTimeout(() => {
      if (typeof window.loadNotifications === "function") {
        window.loadNotifications();
      }
    }, 100);
  }

  // Live Permission Update listener
  window.addEventListener("auth:permissions-updated", () => {
    const navEl = document.querySelector(".sidebar-nav");
    if (navEl) {
      navEl.innerHTML = buildSidebarNavHtml();
    }
    Auth.applyPermissionVisibility();
  });

  // Apply button-level permission hiding across all action buttons in the DOM
  setTimeout(() => {
    Auth.applyPermissionVisibility();
  }, 50);
}

function renderNav(activeKey) {
  renderShell(activeKey);
}

window.loadNotifications = async function () {
  const badgeEl = document.getElementById("topbarBellBadge");
  const headerBadgeEl = document.getElementById("notificationHeaderBadge");
  const listEl = document.getElementById("notificationItemsList");

  if (!Auth.hasPermission("task.view")) return;

  try {
    const res = await apiGet("/tasks?limit=100");
    if (!res || !res.data || !Array.isArray(res.data.items)) return;
    const tasks = res.data.items;
    const now = new Date();

    const notifications = [];

    tasks.forEach((t) => {
      if (t.status === "COMPLETED" || t.status === "CANCELLED") return;
      const isOverdue = t.due_date && new Date(t.due_date) < now;
      if (isOverdue) {
        notifications.push({
          id: t.id,
          type: "overdue",
          title: `Overdue Task: "${t.title}"`,
          message: `Due was ${new Date(t.due_date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
          href: "./tasks.html",
        });
      } else if (t.priority === "URGENT" || t.priority === "HIGH") {
        notifications.push({
          id: t.id,
          type: "urgent",
          title: `Urgent Task: "${t.title}"`,
          message: `Priority: ${t.priority} — Status: ${t.status}`,
          href: "./tasks.html",
        });
      }
    });

    const count = notifications.length;
    if (badgeEl) {
      if (count > 0) {
        badgeEl.textContent = count > 99 ? "99+" : String(count);
        badgeEl.style.display = "inline-block";
      } else {
        badgeEl.style.display = "none";
      }
    }

    if (headerBadgeEl) {
      headerBadgeEl.textContent = `${count} active`;
    }

    if (listEl) {
      if (count === 0) {
        listEl.innerHTML = `<div style="padding:24px; text-align:center; color:#64748b; font-size:13px;">No pending or overdue notifications</div>`;
      } else {
        listEl.innerHTML = notifications
          .map(
            (n) => `
          <div style="padding:12px 16px; border-bottom:1px solid #f1f5f9; cursor:pointer; transition:background 0.15s ease;" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='transparent'" onclick="location.href='${n.href}'">
            <div style="font-size:13px; font-weight:700; color:${n.type === "overdue" ? "#dc2626" : "#d97706"}; display:flex; align-items:center; gap:6px;">
              ${n.type === "overdue" ? "⚠️" : "⚡"} ${escapeHtml(n.title)}
            </div>
            <div style="font-size:12px; color:#475569; margin-top:2px;">${escapeHtml(n.message)}</div>
          </div>`
          )
          .join("");
      }
    }
  } catch (err) {
    console.warn("Failed to load notifications:", err);
  }
};