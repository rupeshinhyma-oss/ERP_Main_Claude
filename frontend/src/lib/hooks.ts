import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Auth } from "./auth";
import { isAbortError } from "./api";
import type { Profile } from "@/types";

/**
 * Subscribes to the Auth store so components re-render when the profile or
 * permission set changes (the replacement for the original
 * `auth:permissions-updated` DOM event + applyPermissionVisibility() pass).
 */
export function useAuth(): {
  profile: Profile | null;
  isSuperAdmin: boolean;
  hasPermission: (code?: string | null) => boolean;
} {
  const [profile, setProfile] = useState<Profile | null>(() => Auth.getProfile());

  useEffect(() => Auth.subscribe(setProfile), []);

  const hasPermission = useCallback(
    (code?: string | null) => Auth.hasPermission(code),
    // Re-created whenever the profile changes so memoised consumers recompute.
    [profile]
  );

  const isSuperAdmin = useMemo(
    () => Boolean(profile && Array.isArray(profile.roles) && profile.roles.includes("super_admin")),
    [profile]
  );

  return { profile, isSuperAdmin, hasPermission };
}

/**
 * Debounces a value by `delayMs`. Used for the 300ms search debounce every
 * list page had.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export interface SearchController {
  /** Cancel any pending debounce timer and in-flight request immediately. */
  cancel: () => void;
  /**
   * Debounce by `delayMs`, then run `fn(signal)`. If called again before the
   * delay elapses (or before `fn` resolves), the previous attempt is cancelled
   * first, so fast typing never lets an old, slow response overwrite a newer
   * one.
   */
  run: <T>(fn: (signal: AbortSignal) => Promise<T>, delayMs?: number) => Promise<T | undefined>;
}

/**
 * A debounced-search + request-cancellation helper for type-ahead inputs
 * (used by the searchable dropdown component). Ported from
 * createSearchController() in api.js, with cleanup on unmount.
 */
export function useSearchController(): SearchController {
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (controllerRef.current) controllerRef.current.abort();
    controllerRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  const run = useCallback(
    <T,>(fn: (signal: AbortSignal) => Promise<T>, delayMs = 250): Promise<T | undefined> => {
      cancel();
      return new Promise<T | undefined>((resolve, reject) => {
        timerRef.current = setTimeout(async () => {
          const controller = new AbortController();
          controllerRef.current = controller;
          try {
            resolve(await fn(controller.signal));
          } catch (err) {
            // Superseded by a newer call; caller should ignore.
            if (isAbortError(err)) resolve(undefined);
            else reject(err);
          }
        }, delayMs);
      });
    },
    [cancel]
  );

  return useMemo(() => ({ cancel, run }), [cancel, run]);
}

/**
 * Locks page scroll while a modal is open, restoring the previous scroll
 * position on close.
 *
 * Without this, if the page had already been scrolled down when a modal
 * opened, the fixed-position overlay could render with its own content
 * (especially Save/Cancel buttons at the bottom of a long form) partially
 * below the viewport -- forcing an extra scroll to find them, with no visual
 * indication there was more below.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const scrollY = window.scrollY;
    const body = document.body;
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    return () => {
      body.style.position = "";
      body.style.top = "";
      body.style.left = "";
      body.style.right = "";
      window.scrollTo(0, scrollY);
    };
  }, [active]);
}

/**
 * Tracks a "jump to Sr. No. N" request. A bare integer typed into a list
 * page's search box means "take me to row N" rather than a text search: the
 * page computes which page that row lives on, loads it, then this hook
 * scrolls the row into view and flashes the row-highlight animation.
 */
export function useSrNoJump(): {
  pending: number | null;
  request: (srNo: number) => void;
  clear: () => void;
  applyTo: (container: HTMLElement | null) => void;
} {
  const [pending, setPending] = useState<number | null>(null);

  const request = useCallback((srNo: number) => setPending(srNo), []);
  const clear = useCallback(() => setPending(null), []);

  const applyTo = useCallback(
    (container: HTMLElement | null) => {
      if (pending === null || !container) return;
      const rows = container.querySelectorAll("tr");
      for (const row of Array.from(rows)) {
        const cell = row.querySelector(".cell-srno");
        if (cell && parseInt(cell.textContent || "", 10) === pending) {
          row.classList.add("row-highlight");
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }
      setPending(null);
    },
    [pending]
  );

  return { pending, request, clear, applyTo };
}

/** True if the search box holds a bare integer, i.e. a Sr. No. jump request. */
export function isSrNoQuery(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * Phase 7 (item 5, "Mutation Reliability"): prevents accidental double-submit
 * on pages that fire mutations directly (apiPost/apiPatch/apiPut/apiDelete)
 * from plain event handlers rather than through `MasterPage`, which already
 * has its own local `submitting` guard.
 *
 * Keyed rather than a single boolean so a list page can disable just the ONE
 * row/button a user clicked (e.g. `Delete` on row 3) without freezing every
 * other row's actions while that request is in flight -- a single shared
 * `submitting` flag would make unrelated rows look broken during someone
 * else's slow request.
 *
 * Usage:
 *
 *     const { isPending, guard } = usePendingGuard();
 *     <button disabled={isPending(buyer.id)} onClick={() => guard(buyer.id, () => handleDelete(buyer))}>
 *       {isPending(buyer.id) ? "Deleting…" : "Delete"}
 *     </button>
 *
 * `guard` is a silent no-op (never double-invokes `fn`) if the same key is
 * already pending; the key is always cleared in a `finally`, so a failed
 * request (which the caller is expected to surface via its own try/catch
 * and error state) never leaves a button permanently disabled.
 */
export function usePendingGuard<K extends string = string>(): {
  isPending: (key: K) => boolean;
  guard: (key: K, fn: () => Promise<unknown>) => Promise<void>;
} {
  const [pendingKeys, setPendingKeys] = useState<Set<K>>(() => new Set());
  // Mirrors `pendingKeys` synchronously so `guard` can check "already
  // pending?" without waiting on a state update (React state updates are
  // async/batched, so reading `pendingKeys` itself inside a fast second
  // click could still see the pre-update value).
  const pendingRef = useRef<Set<K>>(new Set());

  const isPending = useCallback((key: K) => pendingKeys.has(key), [pendingKeys]);

  const guard = useCallback(async (key: K, fn: () => Promise<unknown>) => {
    if (pendingRef.current.has(key)) return; // already in flight -- ignore the extra click
    pendingRef.current.add(key);
    setPendingKeys(new Set(pendingRef.current));
    try {
      await fn();
    } finally {
      pendingRef.current.delete(key);
      setPendingKeys(new Set(pendingRef.current));
    }
  }, []);

  return { isPending, guard };
}

/**
 * Syncs browser back-button with a modal / drawer's open state.
 *
 * When `isOpen` becomes true a dummy history entry is pushed so that pressing
 * the browser's Back button (left arrow) smoothly closes the modal/form and keeps
 * the user on the current page's table list.
 *
 * Route navigation safety: If the user clicks a sidebar link or navigates away to
 * another route, unmount cleanup detects the pathname change and skips history.back(),
 * ensuring instant 1-click navigation without cancelled routes.
 */
export function useModalHistorySync(isOpen: boolean, onClose: () => void): void {
  const isPopStateRef = useRef(false);
  const hasPushedRef = useRef(false);
  const location = useLocation();
  const currentPathRef = useRef(location.pathname);
  currentPathRef.current = location.pathname;

  useEffect(() => {
    if (!isOpen) {
      if (hasPushedRef.current && !isPopStateRef.current) {
        hasPushedRef.current = false;
        if (window.location.pathname === currentPathRef.current) {
          window.history.back();
        }
      }
      isPopStateRef.current = false;
      return;
    }

    // Modal just opened: push dummy history state
    window.history.pushState({ modalHistorySync: true }, "");
    hasPushedRef.current = true;
    isPopStateRef.current = false;

    const handlePopState = () => {
      isPopStateRef.current = true;
      hasPushedRef.current = false;
      onClose();
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
      // Clean up dummy entry ONLY if unmounting on the exact same page without popstate
      if (hasPushedRef.current && !isPopStateRef.current) {
        if (window.location.pathname === currentPathRef.current) {
          window.history.back();
        }
        hasPushedRef.current = false;
      }
      isPopStateRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
}