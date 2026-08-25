import { useState, useRef, useEffect } from "react";

export interface ItemPopoverCellProps {
  items: string[];
  icon?: string;
  itemIcon?: string;
  title?: string;
  maxWidth?: string;
  emptyText?: string;
  badgeIcon?: string;
  badgeColor?: "blue" | "emerald" | "amber" | "purple";
}

export function ItemPopoverCell({
  items,
  icon,
  itemIcon,
  title,
  maxWidth = "130px",
  emptyText = "—",
  badgeIcon = "📍",
  badgeColor = "blue",
}: ItemPopoverCellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const calculatePosition = () => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceRight = window.innerWidth - rect.left;
    // If there is not enough space below (less than 260px) and sufficient space above, flip upwards
    setOpenUpward(spaceBelow < 260 && rect.top > 180);
    setAlignRight(spaceRight < 300);
  };

  const handleOpen = () => {
    calculatePosition();
    setIsOpen(true);
  };

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

  const badgeStyles: Record<string, { color: string; bg: string; border: string }> = {
    blue: { color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
    emerald: { color: "#059669", bg: "#ecfdf5", border: "#a7f3d0" },
    amber: { color: "#d97706", bg: "#fffbeb", border: "#fde68a" },
    purple: { color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
  };

  const badgeStyle = badgeStyles[badgeColor] || badgeStyles.blue;

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={handleOpen}
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
            if (isOpen) {
              setIsOpen(false);
            } else {
              handleOpen();
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "2px 7px",
            fontSize: "11px",
            fontWeight: 600,
            color: badgeStyle.color,
            background: badgeStyle.bg,
            border: `1px solid ${badgeStyle.border}`,
            borderRadius: "12px",
            cursor: "pointer",
            lineHeight: 1.2,
            transition: "all 0.15s ease",
            boxShadow: `0 1px 2px rgba(0, 0, 0, 0.05)`,
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
            top: openUpward ? "auto" : "calc(100% + 6px)",
            bottom: openUpward ? "calc(100% + 6px)" : "auto",
            left: alignRight ? "auto" : 0,
            right: alignRight ? 0 : "auto",
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 14px 34px -4px rgba(0, 0, 0, 0.2), 0 8px 16px -4px rgba(0, 0, 0, 0.12)",
            padding: "10px 12px",
            minWidth: "220px",
            maxWidth: "340px",
            maxHeight: "240px",
            overflowY: "auto",
            zIndex: 999999,
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

export interface TextPopoverCellProps {
  text?: string | null;
  maxLen?: number;
  title?: string;
  icon?: string;
  maxWidth?: string;
  emptyText?: string;
}

export function TextPopoverCell({
  text,
  maxLen = 22,
  title = "Details",
  icon = "📍",
  maxWidth = "150px",
  emptyText = "—",
}: TextPopoverCellProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const calculatePosition = () => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceRight = window.innerWidth - rect.left;
    setOpenUpward(spaceBelow < 260 && rect.top > 180);
    setAlignRight(spaceRight < 300);
  };

  const handleOpen = () => {
    calculatePosition();
    setIsOpen(true);
  };

  // Close on outside click
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

  if (!text || !text.trim()) {
    return <span style={{ color: "#94a3b8" }}>{emptyText}</span>;
  }

  const cleanText = text.trim();

  if (cleanText.length <= maxLen) {
    return (
      <span
        style={{
          color: "#1e293b",
          fontSize: "13px",
          whiteSpace: "nowrap",
        }}
      >
        {cleanText}
      </span>
    );
  }

  const truncated = cleanText.slice(0, maxLen) + "…";

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={handleOpen}
      onMouseLeave={() => setIsOpen(false)}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span
          className="cell-truncate"
          title={cleanText}
          style={{
            maxWidth,
            color: "#1e293b",
            fontSize: "13px",
            display: "inline-block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {truncated}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (isOpen) {
              setIsOpen(false);
            } else {
              handleOpen();
            }
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "2px 6px",
            fontSize: "11px",
            fontWeight: 600,
            color: "#2563eb",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "10px",
            cursor: "pointer",
            lineHeight: 1.2,
            transition: "all 0.15s ease",
            boxShadow: "0 1px 2px rgba(37, 99, 235, 0.08)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Click or hover to read full text"
        >
          👁️
        </button>
      </div>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            top: openUpward ? "auto" : "calc(100% + 6px)",
            bottom: openUpward ? "calc(100% + 6px)" : "auto",
            left: alignRight ? "auto" : 0,
            right: alignRight ? 0 : "auto",
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 14px 34px -4px rgba(0, 0, 0, 0.2), 0 8px 16px -4px rgba(0, 0, 0, 0.12)",
            padding: "12px 14px",
            minWidth: "250px",
            maxWidth: "380px",
            maxHeight: "260px",
            overflowY: "auto",
            zIndex: 999999,
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
              paddingBottom: "6px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>
              {icon} {title}
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
          <div
            style={{
              fontSize: "12.5px",
              lineHeight: "1.5",
              color: "#1e293b",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#f8fafc",
              padding: "8px 10px",
              borderRadius: "6px",
              border: "1px solid #f1f5f9",
            }}
          >
            {cleanText}
          </div>
        </div>
      )}
    </div>
  );
}
