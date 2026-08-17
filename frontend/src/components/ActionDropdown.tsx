/**
 * "⋮ Actions ▾" dropdown menu for table rows.
 *
 * Ported from the action-dropdown markup and toggleUserMenu() in users.html.
 * The menu is rendered `position: fixed` and placed by measuring the trigger
 * button's own bounding rect, rather than relying on `position: absolute`
 * inside the row -- a table wrapped in an `overflow-x: auto` scroll container
 * (which every data table in this app uses) clips absolutely-positioned
 * children to that container's bounds, so a dropdown near the right edge or
 * bottom of the table would otherwise get cut off instead of overlaying the
 * page. It also flips to open upward when there isn't enough room below.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ActionDropdownItem {
  key: string;
  label: string;
  onClick: () => void;
  /** Danger-styled items (e.g. "Force Logout All") render in red. */
  danger?: boolean;
}

export type ActionDropdownEntry = ActionDropdownItem | "divider";

export function ActionDropdown({
  items,
  label,
  iconOnly = false,
}: {
  items: ActionDropdownEntry[];
  label?: string;
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function place() {
    const btn = buttonRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const btnRect = btn.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();

    let left = btnRect.right - menuRect.width;
    if (left < 10) left = 10;

    let top = btnRect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 10) {
      // Not enough room below -- open upward instead.
      top = btnRect.top - menuRect.height - 4;
      if (top < 10) top = 10;
    }
    setPosition({ top, left });
  }

  // Re-measure right after opening, once the menu has actually rendered and
  // has real dimensions to measure.
  useEffect(() => {
    if (open) place();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click or on scroll (a stale fixed-position menu
  // floating over the wrong row after the page scrolls looks broken).
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node) &&
        menuRef.current &&
        !menuRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener("click", onDocClick);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  if (items.length === 0) return <span>—</span>;

  return (
    <div className="action-dropdown">
      <button
        ref={buttonRef}
        type="button"
        className={`action-dropdown-btn ${iconOnly ? "action-dropdown-icon-btn" : ""}`.trim()}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        {label || (iconOnly ? "⋮" : "⋮ Actions ▾")}
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="action-dropdown-menu show"
            style={{
              position: "fixed",
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              width: "max-content",
              minWidth: "170px",
              maxWidth: "220px",
              zIndex: 99999,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {items.map((item, i) =>
              item === "divider" ? (
                <div className="action-dropdown-divider" key={`divider-${i}`} />
              ) : (
                <button
                  key={item.key}
                  type="button"
                  className={`action-dropdown-item ${item.danger ? "danger" : ""}`.trim()}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                >
                  {item.label}
                </button>
              )
            )}
          </div>,
          document.body
        )}
    </div>
  );
}
