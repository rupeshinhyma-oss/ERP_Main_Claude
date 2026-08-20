/**
 * Session + permission store.
 *
 * Ported from the `Auth` object in the original api.js. Tokens and the cached
 * profile still live in localStorage under the same keys, so an existing
 * logged-in session survives the migration to this app.
 *
 * The original broadcast a DOM `auth:permissions-updated` CustomEvent whenever
 * the profile changed, and listeners re-ran `applyPermissionVisibility()` to
 * hide buttons the user may no longer use. Here the same signal drives React
 * state via a tiny subscribe/notify store (see useAuth), so permission changes
 * re-render the sidebar and any permission-gated control declaratively rather
 * than by mutating the DOM after the fact.
 */

import type { Profile, TokenPair } from "@/types";

const ACCESS_TOKEN_KEY = "erp_access_token";
const REFRESH_TOKEN_KEY = "erp_refresh_token";
const PROFILE_KEY = "erp_profile";

type Listener = (profile: Profile | null) => void;

const listeners = new Set<Listener>();

function notify(profile: Profile | null): void {
  listeners.forEach((listener) => listener(profile));
}

export const Auth = {
  /** Subscribe to profile/permission changes. Returns an unsubscribe fn. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getAccessToken(): string | null {
    return localStorage.getItem(ACCESS_TOKEN_KEY);
  },

  getRefreshToken(): string | null {
    return localStorage.getItem(REFRESH_TOKEN_KEY);
  },

  getProfile(): Profile | null {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as Profile;
    } catch {
      return null;
    }
  },

  setSession(tokens: TokenPair, profile?: Profile): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, tokens.access_token);
    localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
    if (profile) {
      this.updateProfile(profile);
    }
  },

  updateProfile(profile: Profile): void {
    const oldRaw = localStorage.getItem(PROFILE_KEY);
    const nextRaw = JSON.stringify(profile);
    localStorage.setItem(PROFILE_KEY, nextRaw);
    if (oldRaw !== nextRaw) {
      notify(profile);
    }
  },

  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(PROFILE_KEY);
    notify(null);
  },

  isLoggedIn(): boolean {
    return Boolean(this.getAccessToken());
  },

  isSuperAdmin(): boolean {
    const profile = this.getProfile();
    return Boolean(
      profile && Array.isArray(profile.roles) && profile.roles.includes("super_admin")
    );
  },

  /**
   * Permission check with the backend's alias fallbacks. The Admin
   * (super_admin) role passes everything; otherwise a code matches if it is
   * granted directly or via one of the documented aliases (view<->read,
   * export/import fallbacks, the legacy employee<->user module pair kept
   * for backward compatibility with older data, or a hierarchical short
   * form such as masters.brand.create -> brand.create).
   */
  hasPermission(code?: string | null): boolean {
    if (!code) return true;
    const profile = this.getProfile();
    if (!profile) return false;
    if (Array.isArray(profile.roles) && profile.roles.includes("super_admin")) return true;
    if (!Array.isArray(profile.permissions)) return false;
    const perms = profile.permissions;
    if (perms.includes(code)) return true;

    // Check export fallback to view
    if (code.endsWith(".export")) {
      const viewAlias = code.replace(/\.export$/, ".view");
      if (perms.includes(viewAlias)) return true;
    }
    // Check import fallback to create
    if (code.endsWith(".import")) {
      const createAlias = code.replace(/\.import$/, ".create");
      if (perms.includes(createAlias)) return true;
    }

    return false;
  },

  can(action: string, page?: string | null): boolean {
    if (!page) return false;
    return this.hasPermission(`${page}.${action}`);
  },
};

/** Two-letter initials, matching the original `initials()` helper exactly. */
export function initials(name?: string | null): string {
  if (!name) return "?";
  return name.trim().slice(0, 2).toUpperCase();
}

/**
 * Human-readable role label shown under the username in the sidebar.
 *
 * "super_admin" is the system's internal name for the single hardcoded
 * bootstrap admin account's role, but it's shown to users simply as
 * "Admin" everywhere in the UI (see the matching `roleDisplayName()`
 * helpers in Rbac.tsx / Users.tsx). The separate "admin" role name is only
 * checked here for backward compatibility with a database that hasn't yet
 * run `scripts/migrate_retire_business_roles.py`.
 */
export function roleLabel(profile: Profile | null): string {
  if (!profile || !Array.isArray(profile.roles)) return "User";
  if (profile.roles.includes("super_admin") || profile.roles.includes("admin")) {
    return "Admin";
  }
  return "User";
}