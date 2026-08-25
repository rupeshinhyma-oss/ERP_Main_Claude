import { useState, useRef, useEffect } from "react";

export interface ItemPopoverCellProps {
  items: string[];
  icon?: string;
  itemIcon?: string;
  title?: string;
  maxWidth?: string;
  emptyText?: string;
  badgeIcon?: string;
}

export function ItemPopoverCell({
  items,
  icon,
  itemIcon,
  title,
  maxWidth = "130px",
  emptyText = "—",
  badgeIcon = "📍",
}: ItemPopoverCellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click if opened via click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const cleanItems = (items || []).filter(Boolean);

  if (!cleanItems.length) {
    return <span style={{ color: "#94a3b8" }}>{emptyText}</span>;
  }

  const first = cleanItems[0];
  const remaining = cleanItems.length - 1;

  if (cleanItems.length === 1) {
    return (
      <span
        className="cell-truncate"
        title={first}
        style={{
          maxWidth: "180px",
          color: "#1e293b",
          fontSize: "13px",
          display: "inline-flex",
          alignItems: "center",
          gap: "4px",
        }}
      >
        {icon && <span>{icon}</span>}
        <span>{first}</span>
      </span>
    );
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span
          className="cell-truncate"
          title={first}
          style={{
            maxWidth,
            color: "#1e293b",
            fontSize: "13px",
            display: "inline-flex",
            alignItems: "center",
            gap: "4px",
          }}
        >
          {icon && <span>{icon}</span>}
          <span>{first}</span>
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen((prev) => !prev);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "2px 7px",
            fontSize: "11px",
            fontWeight: 600,
            color: "#2563eb",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "12px",
            cursor: "pointer",
            lineHeight: 1.2,
            transition: "all 0.15s ease",
            boxShadow: "0 1px 2px rgba(37, 99, 235, 0.08)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Click or hover to view all"
        >
          <span>{badgeIcon}</span>
          <span>+{remaining}</span>
        </button>
      </div>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 12px 28px -4px rgba(0, 0, 0, 0.18), 0 8px 12px -6px rgba(0, 0, 0, 0.1)",
            padding: "10px 12px",
            minWidth: "220px",
            maxWidth: "340px",
            maxHeight: "240px",
            overflowY: "auto",
            zIndex: 99999,
            textAlign: "left",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              fontSize: "11.5px",
              fontWeight: 700,
              color: "#334155",
              marginBottom: "8px",
              borderBottom: "1px solid #f1f5f9",
              paddingBottom: "5px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {title || "Selected Items"} ({cleanItems.length})
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsOpen(false);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "#94a3b8",
                fontSize: "13px",
                cursor: "pointer",
                padding: "0 4px",
                lineHeight: 1,
              }}
              title="Close"
            >
              ✕
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {cleanItems.map((itemText, i) => (
              <div
                key={i}
                style={{
                  fontSize: "12px",
                  color: "#1e293b",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "5px 8px",
                  borderRadius: "4px",
                  background: "#f8fafc",
                }}
              >
                <span style={{ color: "#3b82f6", fontSize: "12px" }}>
                  {itemIcon || icon || "•"}
                </span>
                <span style={{ wordBreak: "break-word" }}>{itemText}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
