/**
 * Shared API client.
 *
 * Talks to the FastAPI backend (mounted at /api/v1) using the standard
 * success/error response envelope from app.core.responses. Access/refresh
 * tokens are kept in localStorage.
 *
 * SESSION HANDLING (important):
 * Refresh tokens are single-use and rotated server-side (the backend
 * blacklists the old one and issues a new pair on every /auth/refresh call).
 * Because most pages fire several API calls in parallel (e.g. a page loading
 * 4-5 dropdown lookup lists via Promise.all), a naive "call refresh whenever
 * I see a 401" approach means multiple in-flight requests can all try to
 * refresh AT THE SAME TIME with the SAME refresh token: the first one wins
 * and rotates it, and every other concurrent attempt then uses an
 * already-revoked token and fails -- which looks exactly like "randomly
 * logged out" from the user's perspective, even though the session was never
 * actually invalid.
 *
 * The fix is a single-flight refresh lock: no matter how many requests hit a
 * 401 at once, only ONE actually calls /auth/refresh; every other concurrent
 * request awaits that same in-flight promise instead of starting its own.
 *
 * CROSS-TAB SESSION HANDLING (important):
 * The in-memory lock above only protects requests within ONE tab/JS
 * context. With the ERP open in two tabs (or a tab left idle for a long
 * time while another tab, or a background timer, refreshed the session),
 * each tab has its OWN in-memory `refreshInFlight` -- so two tabs can each
 * independently decide "I got a 401, let me refresh" using the SAME
 * refresh token from localStorage at nearly the same moment. The backend
 * only allows the first one through; the second gets back a 401 (its
 * token was just revoked by the first tab's successful rotation) with no
 * further token to retry -- exactly the "leave it idle, come back, it's
 * broken" symptom, and the user has to manually log out and back in to
 * recover even though the session was, from the backend's point of view,
 * never actually invalid.
 *
 * The fix is a localStorage-based cross-tab lock (acquireCrossTabRefreshLock /
 * releaseCrossTabRefreshLock below): before calling /auth/refresh, a tab
 * writes a short-lived lock key. Another tab that sees an active lock does
 * NOT start its own refresh -- it waits briefly and then re-reads whatever
 * token pair is now in localStorage (written by the tab that won the
 * race), and retries its failed request with that instead. localStorage
 * writes are synchronous and visible across tabs (via the native `storage`
 * event and simple polling as a fallback for engines that fire it
 * unreliably), which is what makes this a real cross-tab mutex rather than
 * just another in-memory flag.
 */

import { Auth } from "./auth";
import type { ApiEnvelope, ApiFieldError, ApiResult, TokenPair } from "@/types";

/**
 * Backend origin. Empty string (the default) means "same origin", so paths
 * resolve to /api/v1/... -- in dev the Vite server proxies those through to
 * the backend (see vite.config.ts), which also sidesteps CORS entirely.
 * Set VITE_API_ORIGIN to an absolute URL to point at a backend on another
 * origin instead; the backend's CORS_ALLOWED_ORIGINS must then allow this app.
 */
export const API_ORIGIN: string = import.meta.env.VITE_API_ORIGIN ?? "";
export const API_BASE = `${API_ORIGIN}/api/v1`;

/**
 * Status used internally for a genuine network failure (fetch itself threw,
 * e.g. the connection dropped, DNS failed, CORS blocked, offline). There is
 * no real HTTP status in that case, but treating it as a distinct numeric
 * "status" lets the same retry/isRetryable logic below handle network
 * failures and transient HTTP statuses (502/503/...) uniformly.
 */
export const NETWORK_ERROR_STATUS = 0;

/**
 * A structured error carrying the parsed API error envelope, so callers can
 * show `err.message` directly to the user.
 */
export class ApiError extends Error {
  status: number;
  errors: ApiFieldError[];
  /** Parsed `Retry-After` header (ms), if the server sent one (typically on 429). */
  retryAfterMs?: number;

  constructor(
    message: string,
    status: number,
    errors?: ApiFieldError[],
    retryAfterHeader?: string | null
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.errors = errors || [];
    if (retryAfterHeader) {
      const seconds = Number(retryAfterHeader);
      if (!Number.isNaN(seconds) && seconds >= 0) {
        this.retryAfterMs = Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
      }
    }
  }
}

/** True if this is a genuine network failure (see NETWORK_ERROR_STATUS) rather than an HTTP response. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof ApiError && err.status === NETWORK_ERROR_STATUS;
}

/**
 * True if this error is just "the request was cancelled" (e.g. because the
 * caller navigated away or fired a newer search), not a real failure --
 * callers generally want to silently ignore these rather than show an error
 * banner.
 */
export function isAbortError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name?: string }).name === "AbortError"
  );
}

/**
 * Where to send the user when the session is definitively gone. The router
 * registers a handler on mount so this becomes a client-side navigation
 * instead of a full page load; the location fallback covers the window
 * between module load and that registration.
 */
type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler | null = null;

export function setUnauthorizedHandler(handler: UnauthorizedHandler | null): void {
  unauthorizedHandler = handler;
}

export function handleSessionExpired(): void {
  Auth.clear();
  if (unauthorizedHandler) unauthorizedHandler();
  else window.location.assign("/login");
}

interface RawResponse {
  response: Response;
  body: ApiEnvelope<unknown> | null;
}

function isLoginFlowPath(path: string): boolean {
  return path.startsWith("/auth/login") || path.startsWith("/auth/refresh");
}

// --- Retry policy -----------------------------------------------------------
// Phase 7: bounded, jittered exponential backoff for TRANSIENT failures only.
// "Transient" means: a genuine network failure, or one of the HTTP statuses
// below that represent a temporary condition rather than a permanent
// rejection of the request. Everything else (400/401/403/404/409/422/...)
// is never retried automatically -- retrying those would either never
// succeed (a validation error doesn't fix itself) or, worse, risk
// double-applying a mutation the server already rejected for a reason that
// retrying won't change.
const MAX_RETRY_ATTEMPTS = 3; // in addition to the initial attempt
const BASE_RETRY_DELAY_MS = 300;
const MAX_RETRY_DELAY_MS = 4000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded exponential backoff with jitter, mirroring the pattern already used by LiveClient's WebSocket reconnect logic. */
function computeRetryDelay(attempt: number): number {
  const raw = BASE_RETRY_DELAY_MS * 2 ** attempt;
  const jitter = raw * 0.2 * Math.random();
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(raw + jitter));
}

/** GET/HEAD are always safe to retry (they don't change server state). Everything else must opt in explicitly. */
function isInherentlySafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

/** Human-readable fallback message per status, used only when the backend didn't already supply one (see item 12 of the Phase 7 brief). */
function defaultMessageForStatus(status: number): string {
  switch (status) {
    case NETWORK_ERROR_STATUS:
      return "Network connection lost. Please try again.";
    case 403:
      return "You do not have permission to perform this action.";
    case 404:
      return "The requested resource was not found.";
    case 408:
      return "The request timed out. Please try again.";
    case 409:
      return "Someone else updated this record. Reload the latest version before saving.";
    case 422:
      return "Please correct the highlighted fields and try again.";
    case 429:
      return "Too many requests. Please wait a moment and try again.";
    case 500:
    case 502:
    case 503:
    case 504:
      return "Something went wrong while saving. Please try again.";
    default:
      return "The request failed.";
  }
}

async function rawFetch(path: string, options: RequestInit): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = Auth.getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (err) {
    // A thrown fetch means the request never reached the server (offline,
    // DNS failure, connection reset, CORS, ...) -- NOT a successful
    // operation, and must never be swallowed as one (Phase 7 item 4). An
    // intentional cancellation (AbortController) is passed through as-is
    // so callers' existing `isAbortError` handling keeps working unchanged.
    if (isAbortError(err)) throw err;
    throw new ApiError(defaultMessageForStatus(NETWORK_ERROR_STATUS), NETWORK_ERROR_STATUS, []);
  }
  let body: ApiEnvelope<unknown> | null = null;
  try {
    body = (await response.json()) as ApiEnvelope<unknown>;
  } catch {
    body = null;
  }
  return { response, body };
}

// --- Cross-tab refresh coordination ---------------------------------------
// A short-lived localStorage flag other tabs can see. Not a perfect
// distributed lock (localStorage writes across tabs aren't atomic the way
// a server-side mutex would be), but the window for a genuine double-write
// is a single synchronous `setItem` call -- far narrower than the
// multi-hundred-millisecond round trip to /auth/refresh this is guarding,
// which is what actually matters here.
const CROSS_TAB_REFRESH_LOCK_KEY = "erp_refresh_lock";
// Long enough to cover a slow /auth/refresh round trip (including retry
// backoff on a flaky connection), short enough that a tab which crashed
// mid-refresh doesn't wedge every other tab's session recovery for long.
const CROSS_TAB_LOCK_TTL_MS = 8000;
const CROSS_TAB_LOCK_POLL_INTERVAL_MS = 150;

function getActiveCrossTabLock(): number | null {
  const raw = localStorage.getItem(CROSS_TAB_REFRESH_LOCK_KEY);
  if (!raw) return null;
  const lockedAt = Number(raw);
  if (!Number.isFinite(lockedAt)) return null;
  if (Date.now() - lockedAt > CROSS_TAB_LOCK_TTL_MS) return null; // stale -- treat as not locked
  return lockedAt;
}

function acquireCrossTabRefreshLock(): void {
  localStorage.setItem(CROSS_TAB_REFRESH_LOCK_KEY, String(Date.now()));
}

function releaseCrossTabRefreshLock(): void {
  localStorage.removeItem(CROSS_TAB_REFRESH_LOCK_KEY);
}

/** Poll until the other tab's lock clears (or goes stale), then return. Bounded by CROSS_TAB_LOCK_TTL_MS. */
async function waitForCrossTabRefreshLock(): Promise<void> {
  const deadline = Date.now() + CROSS_TAB_LOCK_TTL_MS;
  while (getActiveCrossTabLock() !== null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, CROSS_TAB_LOCK_POLL_INTERVAL_MS));
  }
}

// --- Single-flight refresh lock -------------------------------------------
// Holds the in-progress refresh promise, if any. Every concurrent caller that
// hits a 401 awaits this SAME promise instead of calling /auth/refresh again
// with an already-about-to-be-rotated token.
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  // Another tab is already refreshing -- don't race it with our own call
  // using the same (about-to-be-revoked) refresh token. Wait for it to
  // finish, then retry with whatever token pair it leaves behind.
  if (getActiveCrossTabLock() !== null) {
    refreshInFlight = (async () => {
      await waitForCrossTabRefreshLock();
      // If the lock is STILL held after our poll deadline, the other tab's
      // refresh is taking unusually long (or it crashed without releasing
      // it) -- don't claim success on its behalf. Returning false here
      // means the caller's retry is skipped and the normal "session
      // expired" path takes over rather than silently reusing a token
      // that may still be mid-rotation.
      if (getActiveCrossTabLock() !== null) return false;
      // The winning tab's successful refresh already updated localStorage
      // (Auth.setSession) by the time its lock clears -- nothing further
      // to do here; the caller's retry will pick up the new access token
      // via Auth.getAccessToken(). If the other tab's refresh FAILED, its
      // lock still clears (see the finally block below), and this tab's
      // caller will retry with the same stale token and correctly get a
      // fresh 401 -- at which point the normal "session expired, please
      // log in again" path takes over instead of looping forever.
      return true;
    })();
    try {
      return await refreshInFlight;
    } finally {
      refreshInFlight = null;
    }
  }

  const refreshToken = Auth.getRefreshToken();
  if (!refreshToken) return false;

  acquireCrossTabRefreshLock();
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      const body = (await res.json()) as ApiEnvelope<TokenPair>;
      if (res.ok && body.success) {
        Auth.setSession(body.data);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  })();

  try {
    return await refreshInFlight;
  } finally {
    // Release the lock once this refresh attempt finishes (success or
    // failure) so a FUTURE 401 -- e.g. the next time the access token
    // naturally expires, minutes later -- can trigger a fresh refresh rather
    // than being stuck replaying a stale result forever.
    refreshInFlight = null;
    releaseCrossTabRefreshLock();
  }
}

/**
 * Options controlling Phase 7 retry behaviour. Only relevant for
 * non-GET/HEAD methods -- GET/HEAD are always safe to retry automatically.
 */
export interface RetryConfig {
  /**
   * Set true ONLY if this specific call is safe to repeat verbatim without
   * risk of double-applying the mutation -- e.g. a PUT that fully replaces
   * a resource by a caller-supplied id, or a DELETE by id (deleting twice
   * is a no-op). Per the Phase 7 brief: CREATE (POST) should essentially
   * never set this unless the backend guarantees idempotency (e.g. via an
   * idempotency key); UPDATE/DELETE only when known safe.
   */
  idempotent?: boolean;
}

/** One (non-retrying) attempt: the original 401-refresh + envelope logic, unchanged in behaviour. */
async function performRequestOnce<T>(path: string, options: RequestInit): Promise<ApiResult<T>> {
  let { response, body } = await rawFetch(path, options);

  if (response.status === 401 && Auth.getRefreshToken()) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      ({ response, body } = await rawFetch(path, options));
    }
  }

  if (response.status === 401) {
    if (!isLoginFlowPath(path)) {
      handleSessionExpired();
    }
    const message = body?.message || defaultMessageForStatus(401);
    throw new ApiError(message, 401, body?.errors || []);
  }

  if (!body) {
    throw new ApiError(
      `Request failed with status ${response.status}.`,
      response.status,
      [],
      response.headers.get("Retry-After")
    );
  }

  if (!response.ok || body.success === false) {
    let message = body.message || defaultMessageForStatus(response.status);
    if (body.errors && body.errors.length > 0) {
      const details = body.errors
        .map((e) => (e.field ? `${e.field}: ${e.message}` : e.message))
        .filter((msg) => Boolean(msg) && msg !== message)
        .join("; ");
      if (details) {
        message = `${message} (${details})`;
      }
    }
    throw new ApiError(message, response.status, body.errors || [], response.headers.get("Retry-After"));
  }

  return { data: body.data as T, meta: body.meta };
}

/**
 * Perform an authenticated API call against the standard response envelope.
 * Returns `data` (plus `meta`) on success; throws `ApiError` on failure.
 *
 * Two layers of resilience:
 * 1. Auth: a 401 triggers exactly one silent, single-flight token refresh
 *    (see tryRefresh above) before failing -- unchanged from before.
 * 2. Transient-failure retry (Phase 7): network failures and 408/429/
 *    500/502/503/504 responses are retried with bounded exponential
 *    backoff (+ jitter), but ONLY for GET/HEAD or for calls explicitly
 *    marked `{ idempotent: true }` in `retryConfig`. Every other failure
 *    (400/401-after-refresh-failed/403/404/409/422/...) is never retried
 *    -- see RETRYABLE_STATUSES and isRetryableFailure below.
 *
 * Pass { signal } in options to make this request cancellable via
 * AbortController -- see apiGet/apiPost/etc below. A cancelled request
 * (AbortError) is never retried and is rethrown as-is.
 */
export async function apiCall<T>(
  path: string,
  options: RequestInit = {},
  retryConfig: RetryConfig = {}
): Promise<ApiResult<T>> {
  const method = (options.method || "GET").toUpperCase();
  const canRetry = isInherentlySafeMethod(method) || retryConfig.idempotent === true;
  const maxAttempts = canRetry ? MAX_RETRY_ATTEMPTS + 1 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await performRequestOnce<T>(path, options);
    } catch (err) {
      if (isAbortError(err)) throw err;

      const isLastAttempt = attempt === maxAttempts - 1;
      const status = err instanceof ApiError ? err.status : null;
      const isRetryableFailure =
        status !== null && (status === NETWORK_ERROR_STATUS || RETRYABLE_STATUSES.has(status));

      if (isLastAttempt || !isRetryableFailure) {
        throw err;
      }

      const delay =
        err instanceof ApiError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : computeRetryDelay(attempt);
      await sleep(delay);
    }
  }

  // Unreachable (the loop above always either returns or throws), but kept
  // so this function's control flow satisfies TypeScript's return analysis.
  throw new ApiError(defaultMessageForStatus(NETWORK_ERROR_STATUS), NETWORK_ERROR_STATUS, []);
}

export function apiGet<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
  return apiCall<T>(path, { method: "GET", ...options });
}

export function apiPost<T>(
  path: string,
  payload?: unknown,
  options: RequestInit = {},
  retryConfig: RetryConfig = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(
    path,
    {
      method: "POST",
      body: JSON.stringify(payload || {}),
      ...options,
    },
    retryConfig
  );
}

/**
 * Upload via multipart/form-data. Brought into the shared reliability/auth
 * behaviour (Phase 7 item 13): single-flight 401 refresh-and-retry, the
 * standard error envelope (so `errorMessage()` works the same as every
 * other call), and AbortController support for cancellation.
 *
 * Never retried automatically -- a file upload is a POST with real,
 * potentially large side effects (and re-sending the body twice on a flaky
 * connection is exactly the kind of accidental duplication Phase 7 says to
 * avoid) -- callers get a clear thrown ApiError and can offer their own
 * "retry" affordance if they choose to.
 */
export async function apiPostMultipart<T>(
  path: string,
  formData: FormData,
  options: { signal?: AbortSignal } = {}
): Promise<ApiResult<T>> {
  const doUpload = async (): Promise<RawResponse> => {
    const token = Auth.getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(`${API_BASE}${path}`, {
        method: "POST",
        headers,
        body: formData,
        signal: options.signal,
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ApiError(defaultMessageForStatus(NETWORK_ERROR_STATUS), NETWORK_ERROR_STATUS, []);
    }
    let body: ApiEnvelope<unknown> | null = null;
    try {
      body = (await response.json()) as ApiEnvelope<unknown>;
    } catch {
      body = null;
    }
    return { response, body };
  };

  let { response, body } = await doUpload();

  if (response.status === 401 && Auth.getRefreshToken()) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      ({ response, body } = await doUpload());
    }
  }

  if (response.status === 401) {
    if (!isLoginFlowPath(path)) {
      handleSessionExpired();
    }
    throw new ApiError(body?.message || defaultMessageForStatus(401), 401, body?.errors || []);
  }

  if (!body) {
    throw new ApiError(`Upload failed with status ${response.status}.`, response.status, []);
  }

  if (!response.ok || body.success === false) {
    throw new ApiError(body.message || defaultMessageForStatus(response.status), response.status, body.errors || []);
  }

  return { data: body.data as T, meta: body.meta };
}

export function apiPatch<T>(
  path: string,
  payload?: unknown,
  options: RequestInit = {},
  retryConfig: RetryConfig = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(
    path,
    {
      method: "PATCH",
      body: JSON.stringify(payload || {}),
      ...options,
    },
    retryConfig
  );
}

export function apiPut<T>(
  path: string,
  payload?: unknown,
  options: RequestInit = {},
  retryConfig: RetryConfig = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(
    path,
    {
      method: "PUT",
      body: JSON.stringify(payload || {}),
      ...options,
    },
    retryConfig
  );
}

export function apiDelete<T>(
  path: string,
  options: RequestInit = {},
  retryConfig: RetryConfig = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(path, { method: "DELETE", ...options }, retryConfig);
}

/** Build a `?key=value&...` query string, skipping empty/undefined values. */
export function toQueryString(
  params?: Record<string, string | number | boolean | null | undefined>
): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === "") continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message;
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Download an export file. The browser's download machinery can't attach an
 * Authorization header to a plain link, so the blob is fetched with the
 * bearer token and handed to a temporary anchor.
 *
 * Brought into the shared reliability behaviour (Phase 7 item 13, same
 * treatment as `apiPostMultipart`): single-flight 401 refresh-and-retry,
 * bounded exponential-backoff retry for transient failures (GET is
 * inherently safe/idempotent), and a real ApiError with a readable message
 * on failure instead of a bare `Error("Export failed.")` -- so callers can
 * use the same `errorMessage()` / toast handling as every other request.
 */
export async function downloadExport(
  apiBase: string,
  format: "csv" | "xlsx",
  fileBaseName: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const path = `${apiBase}/export?format=${format}`;

  const doDownload = async (): Promise<Response> => {
    const token = Auth.getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    try {
      return await fetch(`${API_BASE}${path}`, { headers, signal: options.signal });
    } catch (err) {
      if (isAbortError(err)) throw err;
      throw new ApiError(defaultMessageForStatus(NETWORK_ERROR_STATUS), NETWORK_ERROR_STATUS, []);
    }
  };

  const maxAttempts = MAX_RETRY_ATTEMPTS + 1; // GET is inherently safe to retry
  let response: Response | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      response = await doDownload();

      if (response.status === 401 && Auth.getRefreshToken()) {
        const refreshed = await tryRefresh();
        if (refreshed) response = await doDownload();
      }

      if (response.status === 401) {
        handleSessionExpired();
        throw new ApiError(defaultMessageForStatus(401), 401, []);
      }

      if (!response.ok) {
        throw new ApiError(defaultMessageForStatus(response.status), response.status, []);
      }

      break; // success
    } catch (err) {
      if (isAbortError(err)) throw err;

      const isLastAttempt = attempt === maxAttempts - 1;
      const status = err instanceof ApiError ? err.status : null;
      const isRetryableFailure =
        status !== null && (status === NETWORK_ERROR_STATUS || RETRYABLE_STATUSES.has(status));

      if (isLastAttempt || !isRetryableFailure) throw err;

      const delay =
        err instanceof ApiError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : computeRetryDelay(attempt);
      await sleep(delay);
    }
  }

  if (!response) {
    // Unreachable (the loop above always either breaks with a response or
    // throws), kept so TypeScript's control-flow analysis is satisfied.
    throw new ApiError(defaultMessageForStatus(NETWORK_ERROR_STATUS), NETWORK_ERROR_STATUS, []);
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;

  // Format current date as DD-MM-YYYY (e.g. Product_17-08-2026.xlsx)
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const dateStr = `${day}-${month}-${year}`;

  const cleanName = fileBaseName.replace(/\s+/g, "_");
  const capName = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
  a.download = `${capName}_${dateStr}.${format}`;

  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}