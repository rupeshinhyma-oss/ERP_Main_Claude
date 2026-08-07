/**
 * Sign-in page. Exact replica of INHYMA ERP Login Page.
 */

import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
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
    <svg className="illustration-svg" viewBox="0 0 440 340" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Background Soft Circle */}
      <circle cx="210" cy="180" r="130" fill="#E8EEFF" />
      <ellipse cx="210" cy="290" rx="160" ry="12" fill="#DFE6F9" />

      {/* Floating Chat Bubble Top */}
      <rect x="235" y="45" width="55" height="40" rx="8" fill="#3B82F6" />
      <path d="M245 75 L240 85 L255 75 Z" fill="#3B82F6" />
      <rect x="245" y="56" width="35" height="5" rx="2" fill="#FFFFFF" />
      <rect x="245" y="66" width="22" height="4" rx="2" fill="#93C5FD" />

      {/* Floating Window Left */}
      <rect x="55" y="105" width="110" height="75" rx="8" fill="#93C5FD" opacity="0.9" />
      <rect x="55" y="105" width="110" height="16" rx="8" fill="#60A5FA" />
      <circle cx="65" cy="113" r="2.5" fill="#FFFFFF" />
      <circle cx="73" cy="113" r="2.5" fill="#FFFFFF" />
      <circle cx="81" cy="113" r="2.5" fill="#FFFFFF" />
      <rect x="67" y="130" width="36" height="30" rx="4" fill="#FFFFFF" />
      <rect x="110" y="132" width="42" height="6" rx="2" fill="#FFFFFF" />
      <rect x="110" y="144" width="30" height="5" rx="2" fill="#BFDBFE" />

      {/* Floating Window Right */}
      <rect x="325" y="125" width="70" height="36" rx="6" fill="#1D4ED8" />
      <rect x="333" y="134" width="30" height="5" rx="2" fill="#FFFFFF" />
      <rect x="333" y="144" width="20" height="4" rx="2" fill="#93C5FD" />
      <rect x="372" y="134" width="16" height="18" rx="3" fill="#FFFFFF" />

      {/* Desk & Legs */}
      <rect x="105" y="208" width="140" height="5" fill="#1E293B" />
      <rect x="170" y="213" width="5" height="85" fill="#1E293B" />
      <rect x="235" y="213" width="5" height="85" fill="#1E293B" />

      {/* Laptop */}
      <path d="M140 185 L200 185 L215 208 L125 208 Z" fill="#3B82F6" />
      <path d="M142 142 L198 142 L200 185 L140 185 Z" fill="#60A5FA" />
      <circle cx="170" cy="163" r="4" fill="#FFFFFF" />

      {/* Person Sitting */}
      {/* Chair */}
      <path d="M250 180 L290 180 L285 240 L245 240 Z" fill="#1E293B" />
      <rect x="270" y="240" width="6" height="60" fill="#1E293B" />

      {/* Legs */}
      <path d="M225 210 C220 250 215 275 190 285 L180 290 L200 295 C225 285 235 255 245 220 Z" fill="#1E1B4B" />
      <path d="M255 220 C250 255 245 280 225 295 L215 300 L235 305 C255 290 265 260 275 225 Z" fill="#2E2A72" />
      {/* Shoes */}
      <path d="M175 285 L195 285 L190 295 L170 295 Z" fill="#1E293B" />
      <path d="M210 295 L230 295 L225 305 L205 305 Z" fill="#1E293B" />

      {/* Torso & Arm */}
      <path d="M255 170 C250 145 270 120 305 130 C315 150 310 180 295 210 Z" fill="#2563EB" />
      <path d="M265 175 L215 195 L200 185 L255 165 Z" fill="#2563EB" />
      <circle cx="210" cy="190" r="6" fill="#FCA5A5" />

      {/* Head & Hair */}
      <circle cx="270" cy="115" r="14" fill="#FCA5A5" />
      <path d="M250 110 C245 80 295 80 305 110 C300 135 285 140 270 140 C255 140 245 125 250 110 Z" fill="#1E1B4B" />
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
    <div style={{ minHeight: "100vh", width: "100%", background: "#f8fafc", display: "flex", flexDirection: "column" }}>
      {/* Top Header Logo */}
      <header style={{ padding: "20px 40px", background: "#ffffff", borderBottom: "1px solid #e2e8f0", display: "flex", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div style={{ background: "#0061f2", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "6px", width: "32px", height: "32px", fontWeight: "bold" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="13 17 18 12 13 7"></polyline>
              <polyline points="6 17 11 12 6 7"></polyline>
            </svg>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span style={{ fontWeight: 800, fontSize: "16px", color: "#0061f2", letterSpacing: "0.5px" }}>YINGLIMA</span>
            <span style={{ fontSize: "9px", color: "#d97706", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.4px" }}>YOUR INDUSTRIAL HYPERMARKET</span>
          </div>
        </div>
      </header>

      {/* Main Login Content */}
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 20px" }}>
        <div style={{ width: "100%", maxWidth: "1050px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: "40px", flexWrap: "wrap" }}>
          
          {/* Left Illustration Pane */}
          <div style={{ flex: 1, minWidth: "320px", display: "flex", justifyContent: "center" }}>
            <LoginIllustration />
          </div>

          {/* Right Sign In Form Pane */}
          <div style={{ width: "100%", maxWidth: "380px", background: "#ffffff", padding: "36px 32px", borderRadius: "12px", boxShadow: "0 10px 25px rgba(0,0,0,0.05)", border: "1px solid #e2e8f0" }}>
            <h2 style={{ fontSize: "24px", fontWeight: 800, color: "#1e293b", margin: "0 0 6px" }}>Sign In</h2>
            <p style={{ fontSize: "13px", color: "#64748b", margin: "0 0 24px" }}>Welcome Back! Please Signin To Continue.</p>

            <ErrorBanner error={error} />

            <form onSubmit={handleSubmit}>
              <div style={{ marginBottom: "18px" }}>
                <label htmlFor="identifier" style={{ display: "block", fontSize: "13px", fontWeight: "600", color: "#334155", marginBottom: "6px" }}>
                  Mobile Number
                </label>
                <input
                  ref={identifierRef}
                  id="identifier"
                  type="text"
                  placeholder="9999999999"
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
        © 2026 CREATED BY <span style={{ fontWeight: 700, color: "#0061f2" }}>THE DEZINE</span>
      </footer>
    </div>
  );
}

