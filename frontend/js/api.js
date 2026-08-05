/**
 * Shared API client for the admin frontend.
 *
 * Talks to the existing FastAPI backend (mounted at /api/v1) using the
 * standard success/error response envelope from app.core.responses.
 * Access/refresh tokens are kept in localStorage.
 *
 * SESSION HANDLING (important):
 * Refresh tokens are single-use and rotated server-side (the backend
 * blacklists the old one and issues a new pair on every /auth/refresh
 * call). Because most pages fire several API calls in parallel (e.g. a
 * page loading 4-5 dropdown lookup lists via Promise.all), a naive "call
 * refresh whenever I see a 401" approach means multiple in-flight requests
 * can all try to refresh AT THE SAME TIME with the SAME refresh token: the
 * first one wins and rotates it, and every other concurrent attempt then
 * uses an already-revoked token and fails -- which looks exactly like
 * "randomly logged out" from the user's perspective, even though the
 * session was never actually invalid.
 *
 * The fix is a single-flight refresh lock: no matter how many requests
 * hit a 401 at once, only ONE actually calls /auth/refresh; every other
 * concurrent request awaits that same in-flight promise instead of
 * starting its own.
 */

// In local dev, the frontend (e.g. http://localhost:5500) and backend
// (e.g. http://localhost:8000) run as separate servers on different ports,
// so relative paths like "/api/v1/..." would incorrectly resolve back to
// the frontend's own origin. Point at the backend explicitly.
//
// If you instead deploy the frontend served BY the backend itself (or
// behind a reverse proxy on the same origin), change this back to the
// relative path "/api/v1".
const API_ORIGIN = "http://localhost:8000";
const API_BASE = `${API_ORIGIN}/api/v1`;

const Auth = {
  getAccessToken() {
    return localStorage.getItem("erp_access_token");
  },
  getRefreshToken() {
    return localStorage.getItem("erp_refresh_token");
  },
  getProfile() {
    const raw = localStorage.getItem("erp_profile");
    return raw ? JSON.parse(raw) : null;
  },
  setSession({ access_token, refresh_token }, profile) {
    localStorage.setItem("erp_access_token", access_token);
    localStorage.setItem("erp_refresh_token", refresh_token);
    if (profile) {
      this.updateProfile(profile);
    }
  },
  updateProfile(profile) {
    const oldRaw = localStorage.getItem("erp_profile");
    localStorage.setItem("erp_profile", JSON.stringify(profile));
    if (oldRaw !== JSON.stringify(profile)) {
      window.dispatchEvent(new CustomEvent("auth:permissions-updated", { detail: profile }));
    }
  },
  clear() {
    localStorage.removeItem("erp_access_token");
    localStorage.removeItem("erp_refresh_token");
    localStorage.removeItem("erp_profile");
  },
  isLoggedIn() {
    return Boolean(this.getAccessToken());
  },
  hasPermission(code) {
    if (!code) return true;
    const profile = this.getProfile();
    if (!profile) return false;
    if (Array.isArray(profile.roles) && profile.roles.includes("super_admin")) return true;
    if (!Array.isArray(profile.permissions)) return false;
    const perms = profile.permissions;
    if (perms.includes(code)) return true;

    // Check alias mapping (view <-> read)
    if (code.endsWith(".view")) {
      const readAlias = code.replace(/\.view$/, ".read");
      if (perms.includes(readAlias)) return true;
    } else if (code.endsWith(".read")) {
      const viewAlias = code.replace(/\.read$/, ".view");
      if (perms.includes(viewAlias)) return true;
    }

    // Check export & import alias fallbacks
    if (code.endsWith(".export")) {
      const readAlias = code.replace(/\.export$/, ".read");
      const viewAlias = code.replace(/\.export$/, ".view");
      if (perms.includes(readAlias) || perms.includes(viewAlias)) return true;
    }
    if (code.endsWith(".import")) {
      const createAlias = code.replace(/\.import$/, ".create");
      if (perms.includes(createAlias)) return true;
    }

    // Check employee <-> user module alias fallback
    if (code.startsWith("employee.")) {
      const userAlias = code.replace(/^employee\./, "user.");
      if (perms.includes(userAlias)) return true;
    } else if (code.startsWith("user.")) {
      const empAlias = code.replace(/^user\./, "employee.");
      if (perms.includes(empAlias)) return true;
    }

    // Hierarchical or module fallback (e.g. masters.brand.create -> brand.create)
    const parts = code.split(".");
    if (parts.length > 2) {
      const shortCode = parts.slice(1).join(".");
      if (perms.includes(shortCode)) return true;
    }
    return false;
  },
  can(action, page) {
    if (!page) return false;
    return this.hasPermission(`${page}.${action}`);
  },
  applyPermissionVisibility(container = document) {
    if (!container) return;
    const elements = container.querySelectorAll("[data-permission], [data-action-permission]");
    elements.forEach((el) => {
      const perm = el.getAttribute("data-permission") || el.getAttribute("data-action-permission");
      if (perm && !this.hasPermission(perm)) {
        el.style.display = "none";
        el.setAttribute("aria-hidden", "true");
        if (el.tagName === "BUTTON" || el.tagName === "A" || el.classList.contains("btn")) {
          el.remove ? el.remove() : (el.style.display = "none");
        }
      }
    });
  },
  requireLogin() {
    if (!this.isLoggedIn()) {
      window.location.href = "./login.html";
    }
  },
};

/**
 * A structured error carrying the parsed API error envelope, so callers
 * can show `err.message` directly to the user.
 */
class ApiError extends Error {
  constructor(message, status, errors) {
    super(message);
    this.status = status;
    this.errors = errors || [];
  }
}

/**
 * True if this error is just "the request was cancelled" (e.g. because the
 * caller navigated away or fired a newer search), not a real failure --
 * callers generally want to silently ignore these rather than show an
 * error banner.
 */
function isAbortError(err) {
  return err && (err.name === "AbortError" || (err instanceof DOMException && err.name === "AbortError"));
}

async function _rawFetch(path, options) {
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    options.headers || {}
  );
  const token = Auth.getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));
  let body = null;
  try {
    body = await response.json();
  } catch (e) {
    body = null;
  }
  return { response, body };
}

// --- Single-flight refresh lock -------------------------------------------
// Holds the in-progress refresh promise, if any. Every concurrent caller
// that hits a 401 awaits this SAME promise instead of calling
// /auth/refresh again with an already-about-to-be-rotated token.
let _refreshInFlight = null;

async function _tryRefresh() {
  if (_refreshInFlight) {
    return _refreshInFlight;
  }

  const refreshToken = Auth.getRefreshToken();
  if (!refreshToken) return false;

  _refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const body = await res.json();
      if (res.ok && body.success) {
        Auth.setSession(body.data);
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  })();

  try {
    return await _refreshInFlight;
  } finally {
    // Release the lock once this refresh attempt finishes (success or
    // failure) so a FUTURE 401 -- e.g. the next time the access token
    // naturally expires, minutes later -- can trigger a fresh refresh
    // rather than being stuck replaying a stale result forever.
    _refreshInFlight = null;
  }
}

/**
 * Perform an authenticated API call against the standard response
 * envelope. Returns `data` on success; throws `ApiError` on failure.
 * Retries exactly once after a silent token refresh on a 401 -- and that
 * refresh is deduplicated across concurrent callers (see _tryRefresh above),
 * which is the fix for "getting logged out randomly" under parallel
 * requests.
 *
 * Pass { signal } in options to make this request cancellable via
 * AbortController -- see apiGet/apiPost/etc below.
 */
async function apiCall(path, options = {}) {
  let { response, body } = await _rawFetch(path, options);

  if (response.status === 401 && Auth.getRefreshToken()) {
    const refreshed = await _tryRefresh();
    if (refreshed) {
      ({ response, body } = await _rawFetch(path, options));
    }
  }

  if (response.status === 401) {
    Auth.clear();
    window.location.href = "./login.html";
    throw new ApiError("Session expired. Please log in again.", 401, []);
  }

  if (!body) {
    throw new ApiError(`Request failed with status ${response.status}.`, response.status, []);
  }

  if (!response.ok || body.success === false) {
    const message = body.message || "The request failed.";
    throw new ApiError(message, response.status, body.errors || []);
  }

  return { data: body.data, meta: body.meta };
}

function apiGet(path, options = {}) {
  return apiCall(path, { method: "GET", ...options });
}
function apiPost(path, payload, options = {}) {
  return apiCall(path, { method: "POST", body: JSON.stringify(payload || {}), ...options });
}
function apiPatch(path, payload, options = {}) {
  return apiCall(path, { method: "PATCH", body: JSON.stringify(payload || {}), ...options });
}
function apiDelete(path, options = {}) {
  return apiCall(path, { method: "DELETE", ...options });
}

/** Build a `?key=value&...` query string, skipping empty/undefined values. */
function toQueryString(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Small helper: show a dismissible error banner inside a container element. */
function showError(container, err) {
  if (isAbortError(err)) return; // cancelled request -- not a real error, don't show a banner
  container.innerHTML = "";
  const div = document.createElement("div");
  div.className = "error-banner";
  div.textContent = err && err.message ? err.message : String(err);
  container.appendChild(div);
}

/** Global toast notification helper for success, error, warning, or info messages. */
function showToast(message, type = "info", duration = 3500) {
  let toastContainer = document.getElementById("toastContainer");
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.id = "toastContainer";
    toastContainer.style.cssText =
      "position:fixed; top:20px; right:20px; z-index:999999; display:flex; flex-direction:column; gap:10px; pointer-events:none;";
    document.body.appendChild(toastContainer);
  }

  const toast = document.createElement("div");
  toast.style.cssText =
    "pointer-events:auto; padding:12px 18px; border-radius:8px; font-size:13.5px; font-weight:600; color:#ffffff; box-shadow:0 10px 25px -5px rgba(0,0,0,0.15); display:flex; align-items:center; gap:8px; transition:all 0.25s ease; opacity:0; transform:translateY(-10px);";

  if (type === "success") {
    toast.style.background = "#059669";
  } else if (type === "error") {
    toast.style.background = "#dc2626";
  } else if (type === "warning") {
    toast.style.background = "#d97706";
  } else {
    toast.style.background = "#2563eb";
  }

  const icon = type === "success" ? "✓ " : type === "error" ? "✕ " : "ℹ ";
  toast.textContent = icon + message;

  toastContainer.appendChild(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  });

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(-10px)";
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Lock/unlock body scroll while a modal is open, and open/close a modal
 * backdrop element with its scroll position reset to the top.
 *
 * Without this, if the page had already been scrolled down when a modal
 * opened, the fixed-position overlay could render with its own content
 * (especially Save/Cancel buttons at the bottom of a long form) partially
 * below the viewport -- forcing an extra scroll to find them, with no
 * visual indication there was more below. Used by every page with a
 * .modal-backdrop (all Master Data pages, Suppliers, Audit Log, Roles &
 * Permissions).
 */
function lockBodyScroll() {
  document.body.dataset.scrollY = String(window.scrollY);
  document.body.style.position = "fixed";
  document.body.style.top = `-${window.scrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
}

function unlockBodyScroll() {
  const scrollY = document.body.dataset.scrollY || "0";
  document.body.style.position = "";
  document.body.style.top = "";
  document.body.style.left = "";
  document.body.style.right = "";
  window.scrollTo(0, parseInt(scrollY, 10));
  delete document.body.dataset.scrollY;
}

function openModalShell(modalBackdropEl) {
  lockBodyScroll();
  modalBackdropEl.style.display = "flex";
  modalBackdropEl.scrollTop = 0;
  const card = modalBackdropEl.querySelector(".modal-card");
  if (card) card.scrollTop = 0;
}

function closeModalShell(modalBackdropEl) {
  modalBackdropEl.style.display = "none";
  unlockBodyScroll();
}

/**
 * A small debounced-search + request-cancellation helper for type-ahead
 * inputs (used by the searchable dropdown component in dropdown-search.js).
 * Each call to `.run(fn)` cancels any previous still-pending call's
 * in-flight request (via AbortController) before starting a new one, so
 * fast typing never lets an old, slow response overwrite a newer one.
 */
function createSearchController() {
  let controller = null;
  let debounceTimer = null;

  return {
    /** Cancel any pending debounce timer and in-flight request immediately. */
    cancel() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (controller) controller.abort();
      controller = null;
    },
    /**
     * Debounce by `delayMs`, then run `fn(signal)`. If called again before
     * the delay elapses (or before `fn` resolves), the previous attempt is
     * cancelled first.
     */
    run(fn, delayMs = 250) {
      this.cancel();
      return new Promise((resolve) => {
        debounceTimer = setTimeout(async () => {
          controller = new AbortController();
          try {
            const result = await fn(controller.signal);
            resolve(result);
          } catch (err) {
            if (!isAbortError(err)) throw err;
            resolve(undefined); // superseded by a newer call; caller should ignore
          }
        }, delayMs);
      });
    },
  };
}

/**
 * Flexible, responsive pagination renderer supporting limit selections (20, 25, 50, 100)
 * and interactive page numbers + Previous/Next buttons.
 *
 * @param {HTMLElement|string} mountEl - Container element or element ID
 * @param {Object} p - Pagination meta from server { current_page, total_pages, total_records, has_next, has_previous, page_size }
 * @param {Object} options - { pageSize, onPageChange(page), onPageSizeChange(size) }
 */
function renderFlexiblePagination(mountEl, p, options = {}) {
  const container = typeof mountEl === "string" ? document.getElementById(mountEl) : mountEl;
  if (!container) return;

  const currentPage = p.current_page || 1;
  const totalPages = p.total_pages || 1;
  const totalRecords = p.total_records || 0;
  const pageSize = options.pageSize || p.page_size || 20;

  const startItem = totalRecords > 0 ? (currentPage - 1) * pageSize + 1 : 0;
  const endItem = Math.min(currentPage * pageSize, totalRecords);

  // Generate page numbers to display
  function getPageNumbers(current, total) {
    if (total <= 7) {
      return Array.from({ length: total }, (_, i) => i + 1);
    }
    const pages = [1];
    if (current > 3) pages.push("...");

    const start = Math.max(2, current - 1);
    const end = Math.min(total - 1, current + 1);

    for (let i = start; i <= end; i++) {
      if (i > 1 && i < total) pages.push(i);
    }

    if (current < total - 2) pages.push("...");
    pages.push(total);
    return pages;
  }

  const pageNumbers = getPageNumbers(currentPage, totalPages);

  const pageBtnsHtml = pageNumbers
    .map((item) => {
      if (item === "...") {
        return `<span style="padding: 4px 6px; color: var(--color-muted, #64748b); font-size: 13px;">...</span>`;
      }
      const isActive = item === currentPage;
      return `
        <button type="button" 
                class="btn btn-small page-num-btn ${isActive ? "btn-primary" : ""}" 
                data-page="${item}" 
                style="${isActive ? "font-weight:700; min-width:32px;" : "min-width:32px;"}" 
                ${isActive ? "disabled" : ""}>
          ${item}
        </button>`;
    })
    .join("");

  const allowedSizes = [20, 25, 50, 100];
  const sizeOptionsHtml = allowedSizes
    .map((s) => `<option value="${s}" ${s === pageSize ? "selected" : ""}>${s}</option>`)
    .join("");

  container.innerHTML = `
    <div style="display:flex; align-items:center; justify-space-between; justify-content:space-between; flex-wrap:wrap; gap:12px; width:100%; margin-top:12px; padding-top:12px; border-top:1px solid var(--color-border, #e2e8f0);">
      <div style="display:flex; align-items:center; gap:14px; flex-wrap:wrap;">
        <div style="display:flex; align-items:center; gap:6px; font-size:13px; color:var(--color-muted, #64748b);">
          <span>Show</span>
          <select class="page-size-select" style="padding:4px 8px; border:1px solid var(--color-border, #cbd5e0); border-radius:var(--radius, 6px); font-size:13px; background:#fff; cursor:pointer;">
            ${sizeOptionsHtml}
          </select>
          <span>per page</span>
        </div>
        <span class="muted" style="font-size:13px; color:var(--color-muted, #64748b);">
          Showing <strong>${startItem}–${endItem}</strong> of <strong>${totalRecords}</strong> total (Page ${currentPage} of ${totalPages})
        </span>
      </div>

      <div style="display:flex; align-items:center; gap:4px; flex-wrap:wrap;">
        <button type="button" class="btn btn-small prev-page-btn" ${!p.has_previous ? "disabled" : ""}>Previous</button>
        ${pageBtnsHtml}
        <button type="button" class="btn btn-small next-page-btn" ${!p.has_next ? "disabled" : ""}>Next</button>
      </div>
    </div>
  `;

  // Attach Listeners
  const selectEl = container.querySelector(".page-size-select");
  if (selectEl && options.onPageSizeChange) {
    selectEl.addEventListener("change", (e) => {
      options.onPageSizeChange(parseInt(e.target.value, 10));
    });
  }

  const prevBtn = container.querySelector(".prev-page-btn");
  if (prevBtn && p.has_previous && options.onPageChange) {
    prevBtn.addEventListener("click", () => options.onPageChange(currentPage - 1));
  }

  const nextBtn = container.querySelector(".next-page-btn");
  if (nextBtn && p.has_next && options.onPageChange) {
    nextBtn.addEventListener("click", () => options.onPageChange(currentPage + 1));
  }

  container.querySelectorAll(".page-num-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = parseInt(btn.getAttribute("data-page"), 10);
      if (page && page !== currentPage && options.onPageChange) {
        options.onPageChange(page);
      }
    });
  });
}