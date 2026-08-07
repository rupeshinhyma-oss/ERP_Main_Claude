/**
 * Shared sidebar + topbar shell.
 *
 * Ported from renderShell() in nav.js. Each page renders
 * `<AppShell activeKey="masters-countries">…</AppShell>`, mirroring the old
 * `renderShell('masters-countries')` call, and gets:
 *
 *  - the login guard,
 *  - a background /auth/profile sync that refreshes cached permissions,
 *  - the forced password-change modal,
 *  - the page-level access check that bounces to /403 with the module name,
 *  - the permission-filtered sidebar (groups with no visible items disappear),
 *  - the topbar with its notification bell and logout button,
 *  - document.title kept as "<Page> — <Company>".
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "@/lib/api";
import { Auth, initials, roleLabel } from "@/lib/auth";
import { useAuth } from "@/lib/hooks";
import {
  NAV_ITEMS_BY_KEY,
  NAV_SECTIONS,
  PAGE_TITLES,
  DEFAULT_BRAND_NAME,
} from "@/lib/nav";
import { getCachedBrandName, resolveBrandName, subscribeBrandName } from "@/lib/brand";
import { ICONS, IconBell, IconLogout } from "./icons";
import { UniversalSearch } from "./UniversalSearch";
import { ErrorBanner } from "./ui";
import type { ItemsPage, Profile, Task } from "@/types";

const NAV_SCROLL_KEY = "erp_sidebar_nav_scroll";

/* ------------------------------------------------------------------ */
/* Notifications                                                      */
/* ------------------------------------------------------------------ */

interface Notification {
  id: string;
  type: "overdue" | "urgent";
  title: string;
  message: string;
}

/**
 * Derives the bell's notification list from open tasks: anything past its due
 * date is overdue, anything flagged URGENT/HIGH is urgent. Completed and
 * cancelled tasks are skipped.
 */
function buildNotifications(tasks: Task[], currentUserId?: string | null): Notification[] {
  const now = new Date();
  const notifications: Notification[] = [];

  tasks.forEach((t) => {
    if (t.status === "COMPLETED" || t.status === "CANCELLED") return;

    // Only notify about tasks the current user is actually involved in --
    // otherwise every admin sees every overdue task org-wide, which is both
    // noisy and, once PRIVATE tasks exist, a visibility leak.
    const isMine =
      Boolean(currentUserId) &&
      (t.assigned_to_id === currentUserId || t.created_by_id === currentUserId);
    if (!isMine) return;

    const isOverdue = Boolean(t.due_date && new Date(t.due_date) < now);
    if (isOverdue) {
      notifications.push({
        id: t.id,
        type: "overdue",
        title: `Overdue Task: "${t.title}"`,
        message: `Due was ${new Date(t.due_date as string).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        })}`,
      });
    } else if (t.priority === "URGENT" || t.priority === "HIGH") {
      notifications.push({
        id: t.id,
        type: "urgent",
        title: `Urgent Task: "${t.title}"`,
        message: `Priority: ${t.priority} — Status: ${t.status}`,
      });
    }
  });

  return notifications;
}

function NotificationBell() {
  const { hasPermission, profile } = useAuth();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const canViewTasks = hasPermission("task.view");
  const currentUserId = profile?.id;

  useEffect(() => {
    if (!canViewTasks) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiGet<ItemsPage<Task>>("/tasks?limit=100");
        if (cancelled || !res?.data || !Array.isArray(res.data.items)) return;
        setNotifications(buildNotifications(res.data.items, currentUserId));
      } catch (err) {
        console.warn("Failed to load notifications:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canViewTasks, currentUserId]);

  // Any click outside the bell closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [open]);

  const count = notifications.length;

  return (
    <div style={{ position: "relative" }} ref={wrapperRef}>
      <button
        className="icon-btn"
        title="Notifications"
        style={{ position: "relative", cursor: "pointer" }}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <IconBell />
        {count > 0 && (
          <span
            style={{
              display: "inline-block",
              position: "absolute",
              top: "-2px",
              right: "-2px",
              background: "#dc2626",
              color: "#ffffff",
              fontSize: "10px",
              fontWeight: 800,
              padding: "1px 5px",
              borderRadius: "10px",
              minWidth: "16px",
              textAlign: "center",
              border: "2px solid #ffffff",
            }}
          >
            {count > 99 ? "99+" : count}
          </span>
        )}
      </button>
      <div
        style={{
          display: open ? "block" : "none",
          position: "absolute",
          right: 0,
          top: "42px",
          width: "340px",
          background: "#ffffff",
          border: "1px solid #cbd5e1",
          borderRadius: "10px",
          boxShadow: "0 12px 28px rgba(0,0,0,0.15)",
          zIndex: 99999,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid #e2e8f0",
            fontWeight: 700,
            fontSize: "13.5px",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            background: "#f8fafc",
          }}
        >
          <span style={{ color: "#1e293b" }}>Notifications</span>
          <span
            style={{
              fontSize: "11px",
              background: "#e0e7ff",
              color: "#2563eb",
              padding: "2px 8px",
              fontWeight: 700,
              borderRadius: "10px",
            }}
          >
            {count} active
          </span>
        </div>
        <div style={{ maxHeight: "320px", overflowY: "auto", padding: "4px 0" }}>
          {count === 0 ? (
            <div style={{ padding: "24px", textAlign: "center", color: "#64748b", fontSize: "13px" }}>
              No pending or overdue notifications
            </div>
          ) : (
            notifications.map((n) => (
              <div
                key={`${n.type}-${n.id}`}
                style={{
                  padding: "12px 16px",
                  borderBottom: "1px solid #f1f5f9",
                  cursor: "pointer",
                  transition: "background 0.15s ease",
                }}
                onMouseOver={(e) => {
                  e.currentTarget.style.background = "#f8fafc";
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
                onClick={() => {
                  setOpen(false);
                  navigate("/tasks");
                }}
              >
                <div
                  style={{
                    fontSize: "13px",
                    fontWeight: 700,
                    color: n.type === "overdue" ? "#dc2626" : "#d97706",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  {n.type === "overdue" ? "⚠️" : "⚡"} {n.title}
                </div>
                <div style={{ fontSize: "12px", color: "#475569", marginTop: "2px" }}>
                  {n.message}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Forced password change                                             */
/* ------------------------------------------------------------------ */

function ForcePasswordChangeModal({ onDone }: { onDone: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);

  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    border: "1px solid #cbd5e0",
    borderRadius: "6px",
    fontSize: "14px",
  };
  const labelStyle: React.CSSProperties = {
    display: "block",
    fontSize: "13px",
    fontWeight: 500,
    marginBottom: "6px",
    color: "#2d3748",
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError(new Error("New password and confirm password do not match."));
      return;
    }
    setSubmitting(true);
    try {
      await apiPost("/auth/change-password", {
        current_password: currentPassword,
        new_password: newPassword,
      });
      const profile = Auth.getProfile();
      if (profile) {
        Auth.updateProfile({ ...profile, must_change_password: false });
      }
      onDone();
    } catch (err) {
      setSubmitting(false);
      setError(err);
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(0,0,0,0.75)",
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        style={{
          background: "#fff",
          borderRadius: "12px",
          padding: "32px",
          maxWidth: "440px",
          width: "100%",
          boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1)",
        }}
      >
        <h2 style={{ margin: "0 0 8px 0", fontSize: "20px", fontWeight: 600, color: "#1a202c" }}>
          Password Change Required
        </h2>
        <p style={{ margin: "0 0 20px 0", fontSize: "14px", color: "#4a5568" }}>
          Your account requires a password change before continuing to the ERP.
        </p>
        <div style={{ marginBottom: "12px" }}>
          <ErrorBanner error={error} />
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>Current / Temporary Password</label>
            <input
              type="password"
              required
              style={inputStyle}
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>
          <div style={{ marginBottom: "16px" }}>
            <label style={labelStyle}>New Password</label>
            <input
              type="password"
              required
              style={inputStyle}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <div style={{ marginBottom: "24px" }}>
            <label style={labelStyle}>Confirm New Password</label>
            <input
              type="password"
              required
              style={inputStyle}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{
              width: "100%",
              padding: "12px",
              fontSize: "14px",
              fontWeight: 600,
              borderRadius: "6px",
              cursor: "pointer",
              justifyContent: "center",
            }}
          >
            {submitting ? "Updating..." : "Update Password & Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                            */
/* ------------------------------------------------------------------ */

function Sidebar({ activeKey, brandName }: { activeKey: string; brandName: string }) {
  const { profile, isSuperAdmin, hasPermission } = useAuth();
  const navRef = useRef<HTMLElement>(null);
  const navigate = useNavigate();

  const visibleSections = useMemo(
    () =>
      NAV_SECTIONS.map((section) => ({
        ...section,
        items: section.items.filter((item) => {
          if (item.superAdminOnly && !isSuperAdmin) return false;
          return !item.permission || hasPermission(item.permission);
        }),
      })).filter((section) => section.items.length > 0),
    [isSuperAdmin, hasPermission]
  );

  /**
   * Restore the nav's scroll offset and make sure the active item is visible,
   * before the first paint.
   *
   * Deliberately NOT smooth-scrolled: this list is taller than the viewport on
   * scaled displays and the shell re-runs this on every navigation, so any
   * correction would otherwise animate in front of the user -- the sidebar
   * visibly sliding on its own after landing on Audit Log or Organization
   * Settings. It must land instantly.
   */
  useEffect(() => {
    const navEl = navRef.current;
    if (!navEl) return;

    const maxScroll = Math.max(0, navEl.scrollHeight - navEl.clientHeight);
    if (maxScroll === 0) return;

    const saved = parseInt(sessionStorage.getItem(NAV_SCROLL_KEY) || "", 10);
    if (Number.isFinite(saved) && saved > 0) {
      navEl.scrollTop = Math.min(saved, maxScroll);
    }

    const active = navEl.querySelector(".nav-item.active");
    if (active) {
      const navBox = navEl.getBoundingClientRect();
      const itemBox = active.getBoundingClientRect();
      if (itemBox.top < navBox.top || itemBox.bottom > navBox.bottom) {
        const centreOffset = (navEl.clientHeight - itemBox.height) / 2;
        navEl.scrollTop = Math.min(
          maxScroll,
          Math.max(0, navEl.scrollTop + (itemBox.top - navBox.top) - centreOffset)
        );
      }
    }
  }, [activeKey, visibleSections]);

  // Persist the scroll offset (throttled to one write per frame).
  useEffect(() => {
    const navEl = navRef.current;
    if (!navEl) return;

    const save = () => {
      try {
        sessionStorage.setItem(NAV_SCROLL_KEY, String(Math.round(navEl.scrollTop)));
      } catch {
        /* storage may be unavailable (private mode); scroll memory is optional */
      }
    };

    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        save();
      });
    };

    navEl.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("beforeunload", save);
    return () => {
      navEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("beforeunload", save);
      save();
    };
  }, []);

  const displayName = profile ? profile.username : "User";

  async function handleLogout() {
    if (!confirm("Log out?")) return;
    try {
      await apiPost("/auth/logout", { refresh_token: Auth.getRefreshToken() });
    } catch {
      /* the local session is cleared either way */
    }
    Auth.clear();
    navigate("/login", { replace: true });
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="logo-mark">{initials(brandName)}</div>
        <span className="brand-text">{brandName}</span>
      </div>
      <nav className="sidebar-nav" ref={navRef}>
        {visibleSections.map((section) => (
          <div className="nav-group" key={section.label}>
            <div className="nav-group-label">{section.label}</div>
            {section.items.map((item) => {
              const Icon = ICONS[item.icon];
              return (
                <Link
                  key={item.key}
                  to={item.path}
                  className={`nav-item ${item.key === activeKey ? "active" : ""}`}
                >
                  <Icon />
                  <span className="nav-label">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-user" style={{ cursor: "pointer" }} onClick={handleLogout}>
          <div className="avatar">{initials(displayName)}</div>
          <div className="user-meta">
            <div className="user-name">{displayName}</div>
            <div className="user-role">{roleLabel(profile)}</div>
          </div>
        </div>
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* Topbar                                                             */
/* ------------------------------------------------------------------ */

function Topbar() {
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await apiPost("/auth/logout", { refresh_token: Auth.getRefreshToken() });
    } catch {
      /* the local session is cleared either way */
    }
    Auth.clear();
    navigate("/login", { replace: true });
  }

  return (
    <header className="topbar">
      <UniversalSearch />
      <div className="topbar-spacer" />
      <div className="topbar-actions">
        <NotificationBell />
        <button className="icon-btn" title="Log out" onClick={handleLogout}>
          <IconLogout />
        </button>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                              */
/* ------------------------------------------------------------------ */

export interface AppShellProps {
  activeKey: string;
  children: ReactNode;
  /** Extra class on the main column wrapper, for page-scoped CSS. */
  pageClassName?: string;
}

export function AppShell({ activeKey, children, pageClassName }: AppShellProps) {
  const { profile, isSuperAdmin, hasPermission } = useAuth();
  const location = useLocation();
  const [brandName, setBrandName] = useState(() => getCachedBrandName());
  const [passwordModalDismissed, setPasswordModalDismissed] = useState(false);

  const loggedIn = Auth.isLoggedIn();

  // Background-sync the latest profile & permissions from the backend so a
  // role change elsewhere takes effect without a re-login.
  useEffect(() => {
    if (!loggedIn) return;
    apiGet<Profile>("/auth/profile")
      .then((res) => {
        if (res && res.data) Auth.updateProfile(res.data);
      })
      .catch(() => {
        /* a failed refresh just leaves the cached profile in place */
      });
  }, [loggedIn]);

  useEffect(() => subscribeBrandName(setBrandName), []);

  useEffect(() => {
    let cancelled = false;
    if (!loggedIn) return;
    resolveBrandName().then((name) => {
      if (!cancelled) setBrandName(name);
    });
    return () => {
      cancelled = true;
    };
  }, [loggedIn]);

  // Keep the tab title as "<Page> — <Company>".
  useEffect(() => {
    const titlePrefix = PAGE_TITLES[activeKey] || "ERP";
    document.title = `${titlePrefix} — ${brandName || DEFAULT_BRAND_NAME}`;
  }, [activeKey, brandName]);

  const handlePasswordDone = useCallback(() => {
    setPasswordModalDismissed(true);
    window.location.reload();
  }, []);

  if (!loggedIn) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // Page-level access check. A page whose nav entry is gated sends the user to
  // /403 with the module name, so the denial names what was refused.
  const navItem = NAV_ITEMS_BY_KEY[activeKey];
  if (navItem && activeKey !== "403") {
    const deniedBySuperAdmin = navItem.superAdminOnly && !isSuperAdmin;
    const deniedByPermission = navItem.permission && !hasPermission(navItem.permission);
    if (deniedBySuperAdmin || deniedByPermission) {
      const moduleName = PAGE_TITLES[activeKey] || activeKey;
      return <Navigate to={`/403?module=${encodeURIComponent(moduleName)}`} replace />;
    }
  }

  const mustChangePassword = Boolean(profile?.must_change_password) && !passwordModalDismissed;

  return (
    <div className={`app-shell ${pageClassName || ""}`.trim()}>
      <Sidebar activeKey={activeKey} brandName={brandName} />
      <div className="main-column">
        <Topbar />
        {children}
      </div>
      {mustChangePassword && <ForcePasswordChangeModal onDone={handlePasswordDone} />}
    </div>
  );
}
