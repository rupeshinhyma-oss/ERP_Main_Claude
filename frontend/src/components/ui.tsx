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
  /** "drawer" (right slide-over panel, default) or "center" (centered dialog modal) */
  variant?: "drawer" | "center";
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
 * The `.modal-backdrop > .modal-card` shell used by pages.
 * Supports both right offcanvas drawers ("drawer") and centered dialog popups ("center").
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  variant = "drawer",
  cardClassName = "",
  cardStyle,
  showHeader = true,
  locked = false,
  backdropClassName = "",
}: ModalProps) {
  useBodyScrollLock(open);

  if (!open) return null;

  const isCenter = variant === "center";
  const finalBackdropClass = `modal-backdrop ${isCenter ? "modal-centered-backdrop" : ""} ${backdropClassName}`.trim();
  const finalCardClass = `modal-card ${isCenter ? "modal-dialog-card" : ""} ${cardClassName}`.trim();

  return (
    <div
      className={finalBackdropClass}
      style={isCenter ? { display: "flex", justifyContent: "center", alignItems: "center", padding: "20px" } : { display: "flex" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div className={finalCardClass} style={cardStyle}>
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

/* ------------------------------------------------------------------ */
/* Custom ERP Modal Popup Alert                                       */
/* ------------------------------------------------------------------ */

export function ModalAlert({
  isOpen,
  title = "Validation Error",
  message,
  onClose,
}: {
  isOpen: boolean;
  title?: string;
  message: string;
  onClose: () => void;
}) {
  useBodyScrollLock(isOpen);
  if (!isOpen || !message) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 99999,
        background: "rgba(15, 23, 42, 0.65)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#ffffff",
          borderRadius: "16px",
          width: "100%",
          maxWidth: "440px",
          padding: "28px",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.3)",
          border: "1px solid #e2e8f0",
          textAlign: "center",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: "50%",
            background: "#fef2f2",
            border: "1px solid #fee2e2",
            color: "#dc2626",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "26px",
            margin: "0 auto 16px auto",
          }}
        >
          ⚠️
        </div>
        <h3 style={{ fontSize: "19px", fontWeight: 700, color: "#0f172a", margin: "0 0 10px 0" }}>
          {title}
        </h3>
        <div
          style={{
            fontSize: "13.5px",
            color: "#334155",
            lineHeight: 1.6,
            margin: "0 0 24px 0",
            padding: "14px 16px",
            background: "#f8fafc",
            border: "1px solid #e2e8f0",
            borderRadius: "10px",
            maxHeight: "260px",
            overflowY: "auto",
            overflowX: "auto",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
            textAlign: message.includes("\n") || message.length > 50 ? "left" : "center",
            whiteSpace: "pre-wrap",
          }}
        >
          {message}
        </div>
        <button
          type="button"
          onClick={onClose}
          style={{
            width: "100%",
            padding: "12px 20px",
            background: "#0061f2",
            color: "#ffffff",
            fontWeight: 700,
            fontSize: "14px",
            borderRadius: "8px",
            border: "none",
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(0, 97, 242, 0.25)",
            transition: "all 0.15s ease",
          }}
        >
          OK, GOT IT
        </button>
      </div>
    </div>
  );
}
