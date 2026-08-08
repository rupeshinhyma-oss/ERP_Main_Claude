/**
 * Sign-in page. Exact replica of INHYMA ERP Login Page.
 */

import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { apiGet, apiPost } from "@/lib/api";
import { Auth } from "@/lib/auth";
import { setBrandName } from "@/lib/brand";
import { ErrorBanner } from "@/components/ui";
import type { Profile, TokenPair } from "@/types";

const DEFAULT_LOGIN_BRAND = "INHYMA SOLUTIONS LLP";

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

/** Vector illustration matching INHYMA ERP login screen: woman working on laptop at desk with chat bubbles */
function LoginIllustration() {
  return (
    <img
      src="/login-illustration.png"
      alt="ERP Login Illustration"
      style={{
        width: "100%",
        maxWidth: "400px",
        height: "auto",
        objectFit: "contain",
        display: "block",
      }}
    />
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
    document.title = `Sign In — ${brand}`;
    (async () => {
      try {
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

  useEffect(() => {
    identifierRef.current?.focus();
  }, []);

  if (Auth.isLoggedIn()) {
    return <Navigate to="/dashboard" replace />;
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

      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", width: "100%", background: "#f8fafc", display: "flex", flexDirection: "column" }}>
      {/* Top Header Logo */}
      <header style={{ padding: "10px 32px", background: "#ffffff", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center" }}>
        <Link to="/dashboard" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none", cursor: "pointer" }}>
          <img src="/logo.png" alt="IHM Logo" style={{ height: "40px", width: "auto", objectFit: "contain" }} />
        </Link>
      </header>

      {/* Main Login Content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 60px" }}>
        <div style={{ width: "100%", maxWidth: "1350px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "160px", flexWrap: "wrap" }}>

          {/* Left Illustration Pane */}
          <div style={{ flex: 1, minWidth: "320px", display: "flex", justifyContent: "center" }}>
            <LoginIllustration />
          </div>

          {/* Right Sign In Form Pane */}
          <div style={{ width: "100%", maxWidth: "380px", background: "transparent", padding: "0", borderRadius: "0", boxShadow: "none", border: "none" }}>
            <h2 style={{ fontSize: "24px", fontWeight: 800, color: "#1e293b", margin: "0 0 6px" }}>Sign In</h2>
            <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 24px" }}>Welcome Back! Please Signin To Continue.</p>

            <ErrorBanner error={error} />

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "18px" }}>
                <label htmlFor="identifier" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                  Username, Email or Mobile Number
                </label>
                <input
                  ref={identifierRef}
                  id="identifier"
                  type="text"
                  placeholder="Username, email, or mobile number"
                  autoComplete="username"
                  required
                  style={{ width: "100%", padding: "10px 14px", fontSize: "14px", borderRadius: "6px", border: "1px solid #cbd5e1", outline: "none" }}
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                />
              </div>

              <div style={{ marginBottom: "18px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <label htmlFor="password" style={{ fontSize: "13px", fontWeight: "600", color: "#334155" }}>
                    Password
                  </label>
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      alert("Please contact your system administrator to reset your password.");
                    }}
                    style={{ fontSize: "12px", color: "#0061f2", fontWeight: 600, textDecoration: "none" }}
                  >
                    Forgot Password?
                  </a>
                </div>
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <input
                    id="password"
                    type={passwordVisible ? "text" : "password"}
                    placeholder="Enter your password"
                    required
                    style={{ width: "100%", padding: "10px 40px 10px 14px", fontSize: "14px", borderRadius: "6px", border: "1px solid #cbd5e1", outline: "none" }}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => setPasswordVisible((v) => !v)}
                    style={{ position: "absolute", right: "12px", background: "none", border: "none", color: "#64748b", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                  >
                    <EyeIcon visible={passwordVisible} />
                  </button>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", marginBottom: "24px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px", color: "#475569" }}>
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    style={{ width: "16px", height: "16px", borderRadius: "4px" }}
                  />
                  Remember Me
                </label>
              </div>

              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "#003399",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: 700,
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                }}
              >
                {submitting ? "Signing In..." : "Sign In"}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer style={{ padding: "16px 40px", borderTop: "1px solid #e2e8f0", background: "#ffffff", fontSize: "12px", color: "#64748b", textTransform: "uppercase" }}>
        © 2026 CREATED BY <span style={{ fontWeight: 700, color: "#0061f2" }}>INHYMA</span>
      </footer>
    </div>
  );
}