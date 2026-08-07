/**
 * Sign-in page. Ported from the redesigned login.html.
 *
 * Two-pane layout: branding + illustration on the left, the sign-in form on
 * the right (the left pane hides below 768px, matching the source's
 * responsive breakpoint). The brand name and title are filled in from
 * `GET /organizations/public` -- deliberately the *public*, unauthenticated
 * endpoint, since this page runs before any token exists. An earlier version
 * of this page called the authenticated `/organizations` here, which 401s
 * with no session and silently fell back to the default brand every time;
 * `/organizations/public` exists precisely for this screen.
 */

import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "@/lib/api";
import { Auth, initials } from "@/lib/auth";
import { setBrandName } from "@/lib/brand";
import { ErrorBanner } from "@/components/ui";
import type { Profile, TokenPair } from "@/types";

const DEFAULT_LOGIN_BRAND = "ERP Admin";

interface PublicOrgInfo {
  company_name: string;
  legal_name?: string | null;
  logo_url?: string | null;
}

function EyeIcon({ visible }: { visible: boolean }) {
  return visible ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={18} height={18}>
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={18} height={18}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** The left pane's illustration -- a desk, monitor, and laptop scene, unchanged from the source. */
function LoginIllustration() {
  return (
    <svg className="illustration-svg" viewBox="0 0 360 260" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="220" y="30" width="110" height="70" rx="10" fill="#3B82F6" />
      <rect x="235" y="45" width="80" height="12" rx="4" fill="#60A5FA" />
      <rect x="235" y="65" width="50" height="12" rx="4" fill="#93C5FD" />

      <rect x="180" y="110" width="150" height="80" rx="10" fill="#1E3A8A" />
      <rect x="300" y="125" width="18" height="18" rx="4" fill="#FFFFFF" />

      <rect x="60" y="80" width="110" height="70" rx="10" fill="#FFFFFF" stroke="#CBD5E1" strokeWidth={3} />
      <rect x="75" y="100" width="45" height="25" rx="4" fill="#3B82F6" />
      <rect x="130" y="100" width="30" height="8" rx="3" fill="#94A3B8" />

      <path d="M70 200 L320 200" stroke="#0F172A" strokeWidth={4} strokeLinecap="round" />
      <path d="M100 200 L100 240" stroke="#0F172A" strokeWidth={4} strokeLinecap="round" />
      <path d="M290 200 L310 240" stroke="#0F172A" strokeWidth={4} strokeLinecap="round" />

      <rect x="110" y="170" width="50" height="30" rx="4" fill="#60A5FA" />
      <path d="M100 200 L170 200" stroke="#3B82F6" strokeWidth={4} strokeLinecap="round" />

      <circle cx="210" cy="130" r="16" fill="#F87171" />
      <path d="M195 150 C195 140 225 140 225 150 L225 240 L210 240 L210 180 L195 180 Z" fill="#2563EB" />

      <circle cx="120" cy="185" r="8" fill="#10B981" />
      <rect x="118" y="193" width="4" height="7" fill="#047857" />
    </svg>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const [brand, setBrand] = useState(DEFAULT_LOGIN_BRAND);
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  const identifierRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    document.title = `Sign In — ${DEFAULT_LOGIN_BRAND}`;
    (async () => {
      try {
        // Unauthenticated on purpose -- there is no session yet on this page.
        const { data } = await apiGet<PublicOrgInfo>("/organizations/public");
        if (cancelled || !data?.company_name) return;
        setBrand(data.company_name);
        setBrandName(data.company_name);
        document.title = `Sign In — ${data.company_name}`;
      } catch {
        /* fallback to default */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Autofocus the identifier field, matching a normal login form's behavior.
  useEffect(() => {
    identifierRef.current?.focus();
  }, []);

  if (Auth.isLoggedIn()) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { data: tokens } = await apiPost<TokenPair>("/auth/login", {
        identifier: identifier.trim(),
        password,
      });
      Auth.setSession(tokens);

      const { data: profile } = await apiGet<Profile>("/auth/profile");
      Auth.updateProfile(profile);

      navigate("/", { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-container">
        {/* Left Pane: Branding & Illustration */}
        <div className="left-pane">
          <div className="brand-header">
            <div className="brand-logo">{initials(brand)}</div>
            <div>
              <div className="brand-name">{brand}</div>
              <div className="brand-sub">ENTERPRISE SYSTEM</div>
            </div>
          </div>

          <div className="illustration-wrapper">
            <LoginIllustration />
          </div>

          <div className="left-footer">
            <div className="left-footer-title">{brand} Enterprise ERP System</div>
            <div className="left-footer-desc">
              Secure inventory, supplier &amp; consignment management
            </div>
          </div>
        </div>

        {/* Right Pane: Sign In Form */}
        <div className="right-pane">
          <div className="form-title">Sign In</div>
          <div className="form-subtitle">Welcome back! Please enter your details.</div>

          <ErrorBanner error={error} />

          <form onSubmit={handleSubmit}>
            <div className="input-group">
              <label className="input-label" htmlFor="identifier">
                Email address or Username
              </label>
              <div className="input-wrapper">
                <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
                <input
                  ref={identifierRef}
                  className="input-field"
                  id="identifier"
                  name="identifier"
                  type="text"
                  placeholder="user@gmail.com"
                  required
                  autoComplete="username"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                />
              </div>
            </div>

            <div className="input-group">
              <label className="input-label" htmlFor="password">
                Password
              </label>
              <div className="input-wrapper">
                <svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <input
                  className="input-field"
                  id="password"
                  name="password"
                  type={passwordVisible ? "text" : "password"}
                  placeholder="••••••••"
                  required
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="eye-toggle"
                  aria-label={passwordVisible ? "Hide password" : "Show password"}
                  onClick={() => setPasswordVisible((v) => !v)}
                >
                  <EyeIcon visible={passwordVisible} />
                </button>
              </div>
            </div>

            <div className="form-options">
              <label className="remember-me">
                <input
                  type="checkbox"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <span>Remember me</span>
              </label>
              <button
                type="button"
                className="forgot-link"
                onClick={() =>
                  alert("Please contact your system administrator to reset your password.")
                }
              >
                Forgot password?
              </button>
            </div>

            <button type="submit" className="submit-btn" disabled={submitting}>
              <span>{submitting ? "Signing In..." : "Sign In"}</span>
              {!submitting && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} width={18} height={18}>
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
