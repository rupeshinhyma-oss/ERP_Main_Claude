/**
 * Right-side offcanvas detail drawer.
 *
 * Ported from two sources that share one visual shell:
 *  - ensureDrawerMarkup() / openDetailDrawer() in masters-common.js -- a
 *    generic "click a row's name to see a two-column field grid" drawer used
 *    by nine simple master pages (Countries, States, Cities, Currencies,
 *    UOM, HSN, Brands, Categories, Sub-Categories).
 *  - the bespoke, more detailed drawer in masters-products.html, which has
 *    its own multi-section body (overview / secondary attributes /
 *    specifications) rather than a flat field grid.
 *
 * `<SideDrawer>` renders the shared shell (backdrop, slide-in card, header
 * with title/subtitle/Edit/Close) and takes the body as `children`, so both
 * use cases share one component: `<DetailFieldGrid>` below covers the simple
 * masters, and Products supplies its own JSX body directly.
 */

import type { ReactNode } from "react";
import { useBodyScrollLock } from "@/lib/hooks";

export interface SideDrawerProps {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  onEdit?: () => void;
  editLabel?: string;
  children: ReactNode;
}

export function SideDrawer({
  open,
  title,
  subtitle,
  onClose,
  onEdit,
  editLabel = "✏️ Edit",
  children,
}: SideDrawerProps) {
  useBodyScrollLock(open);

  return (
    <div
      className={`side-drawer-backdrop ${open ? "open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="side-drawer-card">
        <div
          style={{
            padding: "18px 24px",
            borderBottom: "1px solid var(--color-border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "#fff",
          }}
        >
          <div>
            <h3
              style={{
                fontSize: "17.5px",
                fontWeight: 700,
                color: "var(--color-heading)",
                margin: 0,
              }}
            >
              {title}
            </h3>
            {subtitle && (
              <div style={{ fontSize: "12.5px", color: "var(--color-muted)", marginTop: "2px" }}>
                {subtitle}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {onEdit && (
              <button
                type="button"
                className="btn btn-primary"
                style={{ padding: "7px 14px", fontSize: "13px", fontWeight: 600 }}
                onClick={onEdit}
              >
                {editLabel}
              </button>
            )}
            <button
              type="button"
              className="modal-close"
              style={{ width: "32px", height: "32px", fontSize: "20px" }}
              onClick={onClose}
            >
              &times;
            </button>
          </div>
        </div>
        <div
          style={{
            padding: "24px",
            flex: 1,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export interface DetailField {
  label: string;
  value: ReactNode;
  fullWidth?: boolean;
}

/**
 * The plain two-column field grid the nine simple master pages use inside
 * the drawer -- one direct translation of openDetailDrawer()'s fieldsHtml
 * template.
 */
export function DetailFieldGrid({ fields }: { fields: DetailField[] }) {
  return (
    <div
      style={{
        background: "#f8fafc",
        border: "1px solid #e2e8f0",
        borderRadius: "8px",
        padding: "20px",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px 20px" }}>
        {fields.map((f, i) => (
          <div key={i} style={f.fullWidth ? { gridColumn: "span 2" } : undefined}>
            <span
              style={{
                fontSize: "12px",
                fontWeight: 600,
                color: "#64748b",
                display: "block",
                marginBottom: "3px",
              }}
            >
              {f.label}
            </span>
            <strong style={{ fontSize: "14px", color: "#0f172a", wordBreak: "break-word" }}>
              {f.value === null || f.value === undefined || f.value === "" ? "—" : f.value}
            </strong>
          </div>
        ))}
      </div>
    </div>
  );
}
