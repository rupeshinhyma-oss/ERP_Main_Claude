import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

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

interface PopoverCoords {
  top?: number;
  bottom?: number;
  left: number;
  openUpward: boolean;
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
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  const calculatePosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    // Popover height is at most 250px + padding
    const openUpward = spaceBelow < 260 && spaceAbove > 160;
    const popoverWidth = 280;
    let left = rect.left;
    if (left + popoverWidth > window.innerWidth - 16) {
      left = Math.max(12, window.innerWidth - popoverWidth - 16);
    }
    if (left < 12) left = 12;

    if (openUpward) {
      setCoords({
        bottom: window.innerHeight - rect.top + 6,
        left,
        openUpward: true,
      });
    } else {
      setCoords({
        top: rect.bottom + 6,
        left,
        openUpward: false,
      });
    }
  }, []);

  const handleMouseEnter = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    calculatePosition();
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(false);
    }, 180);
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isOpen) {
      setIsOpen(false);
    } else {
      calculatePosition();
      setIsOpen(true);
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!isOpen) return;
    const handleScrollOrResize = () => {
      calculatePosition();
    };
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen, calculatePosition]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

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
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
          onClick={handleToggleClick}
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
            boxShadow: "0 1px 2px rgba(0, 0, 0, 0.05)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Click or hover to view all"
        >
          <span>{badgeIcon}</span>
          <span>+{remaining}</span>
        </button>
      </div>

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: "fixed",
              top: coords.openUpward ? "auto" : `${coords.top}px`,
              bottom: coords.openUpward ? `${coords.bottom}px` : "auto",
              left: `${coords.left}px`,
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
              boxShadow: "0 16px 36px -4px rgba(0, 0, 0, 0.22), 0 8px 16px -4px rgba(0, 0, 0, 0.12)",
              padding: "10px 12px",
              minWidth: "230px",
              maxWidth: "340px",
              maxHeight: "250px",
              overflowY: "auto",
              zIndex: 9999999,
              textAlign: "left",
              animation: "fadeIn 0.12s ease-out",
            }}
            onMouseEnter={() => {
              if (closeTimeoutRef.current) {
                clearTimeout(closeTimeoutRef.current);
                closeTimeoutRef.current = null;
              }
            }}
            onMouseLeave={handleMouseLeave}
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
          </div>,
          document.body
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
  const [coords, setCoords] = useState<PopoverCoords | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  const calculatePosition = useCallback(() => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;

    const openUpward = spaceBelow < 260 && spaceAbove > 160;
    const popoverWidth = 300;
    let left = rect.left;
    if (left + popoverWidth > window.innerWidth - 16) {
      left = Math.max(12, window.innerWidth - popoverWidth - 16);
    }
    if (left < 12) left = 12;

    if (openUpward) {
      setCoords({
        bottom: window.innerHeight - rect.top + 6,
        left,
        openUpward: true,
      });
    } else {
      setCoords({
        top: rect.bottom + 6,
        left,
        openUpward: false,
      });
    }
  }, []);

  const handleMouseEnter = () => {
    if (closeTimeoutRef.current) {
      clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    calculatePosition();
    setIsOpen(true);
  };

  const handleMouseLeave = () => {
    closeTimeoutRef.current = window.setTimeout(() => {
      setIsOpen(false);
    }, 180);
  };

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isOpen) {
      setIsOpen(false);
    } else {
      calculatePosition();
      setIsOpen(true);
    }
  };

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        popoverRef.current &&
        !popoverRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Update position on scroll/resize
  useEffect(() => {
    if (!isOpen) return;
    const handleScrollOrResize = () => {
      calculatePosition();
    };
    window.addEventListener("scroll", handleScrollOrResize, true);
    window.addEventListener("resize", handleScrollOrResize);
    return () => {
      window.removeEventListener("scroll", handleScrollOrResize, true);
      window.removeEventListener("resize", handleScrollOrResize);
    };
  }, [isOpen, calculatePosition]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (closeTimeoutRef.current) {
        clearTimeout(closeTimeoutRef.current);
      }
    };
  }, []);

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
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
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
          onClick={handleToggleClick}
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

      {isOpen &&
        coords &&
        createPortal(
          <div
            ref={popoverRef}
            style={{
              position: "fixed",
              top: coords.openUpward ? "auto" : `${coords.top}px`,
              bottom: coords.openUpward ? `${coords.bottom}px` : "auto",
              left: `${coords.left}px`,
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
              boxShadow: "0 16px 36px -4px rgba(0, 0, 0, 0.22), 0 8px 16px -4px rgba(0, 0, 0, 0.12)",
              padding: "12px 14px",
              minWidth: "250px",
              maxWidth: "380px",
              maxHeight: "260px",
              overflowY: "auto",
              zIndex: 9999999,
              textAlign: "left",
              animation: "fadeIn 0.12s ease-out",
            }}
            onMouseEnter={() => {
              if (closeTimeoutRef.current) {
                clearTimeout(closeTimeoutRef.current);
                closeTimeoutRef.current = null;
              }
            }}
            onMouseLeave={handleMouseLeave}
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
          </div>,
          document.body
        )}
    </div>
  );
}
