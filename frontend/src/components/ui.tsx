/**
 * Small shared UI primitives.
 *
 * These replace imperative helpers from the original api.js / masters-common.js
 * (showError(), openModalShell()/closeModalShell(), MasterPage.badge()) with
 * declarative components. The rendered markup and class names are unchanged.
 */

import { type ReactNode } from "react";
import { isAbortError, errorMessage } from "@/lib/api";
import { useAuth, useBodyScrollLock } from "@/lib/hooks";

/* ------------------------------------------------------------------ */
/* Banners                                                            */
/* ------------------------------------------------------------------ */

/**
 * Dismissible-style error banner. Renders nothing for an aborted request --
 * a cancelled fetch is not a real error and never showed a banner before.
 */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error || isAbortError(error)) return null;
  return <div className="error-banner">{errorMessage(error)}</div>;
}

export function SuccessBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return <div className="success-banner">{message}</div>;
}

/**
 * The `<div id="banner">` slot every page had, holding whichever of the two
 * banners is currently active.
 */
export function Banner({
  error,
  success,
}: {
  error?: unknown;
  success?: string | null;
}) {
  return (
    <div>
      <ErrorBanner error={error} />
      {!error && <SuccessBanner message={success} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Badges                                                             */
/* ------------------------------------------------------------------ */

/** active/inactive status pill, as MasterPage.badge() produced. */
export function StatusBadge({ status }: { status: string }) {
  const cls = status === "active" ? "badge-active" : "badge-inactive";
  return <span className={`badge ${cls}`}>{status}</span>;
}

/* ------------------------------------------------------------------ */
/* Modal                                                              */
/* ------------------------------------------------------------------ */

export interface ModalProps {
  open: boolean;
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Extra classes for the .modal-card element (e.g. import-wizard-card). */
  cardClassName?: string;
  /** Inline overrides some pages applied, e.g. max-width: 820px. */
  cardStyle?: React.CSSProperties;
  /** Set false to suppress the default header (Audit detail supplies its own). */
  showHeader?: boolean;
  /** Disables the X button and backdrop dismissal while an action is running. */
  locked?: boolean;
  /** Extra classes for the backdrop (import wizard uses iw-locked). */
  backdropClassName?: string;
}

/**
 * The `.modal-backdrop > .modal-card` shell used by every Master Data page,
 * Suppliers, Audit Log and Roles & Permissions.
 *
 * Body scroll is locked while open and the card is mounted fresh each time, so
 * it always opens scrolled to the top rather than inheriting the page's
 * scroll offset.
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  cardClassName = "",
  cardStyle,
  showHeader = true,
  locked = false,
  backdropClassName = "",
}: ModalProps) {
  useBodyScrollLock(open);

  if (!open) return null;

  return (
    <div
      className={`modal-backdrop ${backdropClassName}`.trim()}
      style={{ display: "flex" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div className={`modal-card ${cardClassName}`.trim()} style={cardStyle}>
        {showHeader && (
          <div className="modal-header">
            <h2>{title}</h2>
            <button
              type="button"
              className="modal-close"
              onClick={onClose}
              disabled={locked}
            >
              &times;
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Permission gate                                                    */
/* ------------------------------------------------------------------ */

/**
 * Renders children only if the permission is held.
 *
 * The original marked controls with `data-permission="..."` and then removed
 * or hid them in a post-render sweep (Auth.applyPermissionVisibility). Gating
 * at render time gets the same result without the flash of a control that is
 * about to be pulled, and it re-evaluates automatically when permissions
 * change because it reads from the Auth store.
 */
export function Can({
  permission,
  superAdminOnly = false,
  children,
}: {
  permission?: string | null;
  superAdminOnly?: boolean;
  children: ReactNode;
}) {
  const { hasPermission, isSuperAdmin } = useAuth();
  if (superAdminOnly && !isSuperAdmin) return null;
  if (!hasPermission(permission)) return null;
  return <>{children}</>;
}

/* ------------------------------------------------------------------ */
/* Table helpers                                                      */
/* ------------------------------------------------------------------ */

/** Full-width muted message row used for loading / empty states. */
export function TableMessageRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="muted">
        {children}
      </td>
    </tr>
  );
}

/** Em dash placeholder, matching the original `value || "—"` pattern. */
export function dash(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value);
}
