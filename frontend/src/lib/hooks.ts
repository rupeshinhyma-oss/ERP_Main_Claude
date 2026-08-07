import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
