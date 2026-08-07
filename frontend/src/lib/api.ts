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
 * A structured error carrying the parsed API error envelope, so callers can
 * show `err.message` directly to the user.
 */
export class ApiError extends Error {
  status: number;
  errors: ApiFieldError[];

  constructor(message: string, status: number, errors?: ApiFieldError[]) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.errors = errors || [];
  }
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

function handleSessionExpired(): void {
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

async function rawFetch(path: string, options: RequestInit): Promise<RawResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) || {}),
  };
  const token = Auth.getAccessToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  let body: ApiEnvelope<unknown> | null = null;
  try {
    body = (await response.json()) as ApiEnvelope<unknown>;
  } catch {
    body = null;
  }
  return { response, body };
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

  const refreshToken = Auth.getRefreshToken();
  if (!refreshToken) return false;

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
  }
}

/**
 * Perform an authenticated API call against the standard response envelope.
 * Returns `data` (plus `meta`) on success; throws `ApiError` on failure.
 * Retries exactly once after a silent token refresh on a 401 -- and that
 * refresh is deduplicated across concurrent callers (see tryRefresh above),
 * which is the fix for "getting logged out randomly" under parallel requests.
 *
 * Pass { signal } in options to make this request cancellable via
 * AbortController -- see apiGet/apiPost/etc below.
 */
export async function apiCall<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
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
    const message = body?.message || "Session expired. Please log in again.";
    throw new ApiError(message, 401, body?.errors || []);
  }

  if (!body) {
    throw new ApiError(
      `Request failed with status ${response.status}.`,
      response.status,
      []
    );
  }

  if (!response.ok || body.success === false) {
    const message = body.message || "The request failed.";
    throw new ApiError(message, response.status, body.errors || []);
  }

  return { data: body.data as T, meta: body.meta };
}

export function apiGet<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
  return apiCall<T>(path, { method: "GET", ...options });
}

export function apiPost<T>(
  path: string,
  payload?: unknown,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(path, {
    method: "POST",
    body: JSON.stringify(payload || {}),
    ...options,
  });
}

export async function apiPostMultipart<T>(path: string, formData: FormData): Promise<ApiResult<T>> {
  const token = Auth.getAccessToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  if (!res.ok) {
    throw new ApiError(`Upload failed: ${res.statusText}`, res.status);
  }
  return res.json();
}

export function apiPatch<T>(
  path: string,
  payload?: unknown,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(path, {
    method: "PATCH",
    body: JSON.stringify(payload || {}),
    ...options,
  });
}

export function apiPut<T>(
  path: string,
  payload?: unknown,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(path, {
    method: "PUT",
    body: JSON.stringify(payload || {}),
    ...options,
  });
}

export function apiDelete<T>(
  path: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  return apiCall<T>(path, { method: "DELETE", ...options });
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

/** Extract a displayable message from any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

/**
 * Download an export file. Mirrors the original inline fetch: the browser's
 * download machinery can't attach an Authorization header to a plain link, so
 * the blob is fetched with the bearer token and handed to a temporary anchor.
 */
export async function downloadExport(
  apiBase: string,
  format: "csv" | "xlsx",
  fileBaseName: string
): Promise<void> {
  const token = Auth.getAccessToken();
  const res = await fetch(`${API_BASE}${apiBase}/export?format=${format}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error("Export failed.");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${fileBaseName.replace(/\s+/g, "_")}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
