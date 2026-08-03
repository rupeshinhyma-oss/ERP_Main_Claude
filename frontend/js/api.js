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
      localStorage.setItem("erp_profile", JSON.stringify(profile));
    }
    // Broadcast to other tabs (see the storage-event listener below) so a
    // refresh in one tab updates every other open tab's in-memory token
    // use immediately, instead of each tab racing its own refresh later.
  },
  updateProfile(profile) {
    localStorage.setItem("erp_profile", JSON.stringify(profile));
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
    const profile = this.getProfile();
    return Boolean(profile && Array.isArray(profile.permissions) && profile.permissions.includes(code));
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