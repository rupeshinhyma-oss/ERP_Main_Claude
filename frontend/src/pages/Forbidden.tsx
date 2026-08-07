/**
 * 403 page. Ported from 403.html -- names the refused module when the
 * redirecting page passed one along as `?module=`.
 */

import { Link, useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";

export function ForbiddenPage() {
  const [params] = useSearchParams();
  const moduleName = params.get("module");

  return (
    <AppShell activeKey="403">
      <main className="page">
        <div
          style={{
            maxWidth: "560px",
            margin: "80px auto",
            padding: "40px",
            textAlign: "center",
            background: "#ffffff",
            borderRadius: "12px",
            boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div style={{ fontSize: "56px", marginBottom: "16px" }}>🚫</div>
          <h2
            style={{
              fontSize: "22px",
              fontWeight: 700,
              color: "#1a202c",
              marginBottom: "8px",
            }}
          >
            403 - Access Denied
          </h2>
          <p
            style={{
              color: "#4a5568",
              fontSize: "15px",
              lineHeight: 1.5,
              marginBottom: "24px",
            }}
          >
            {moduleName ? (
              <>
                You do not have permission to access the <strong>{moduleName}</strong> module.
              </>
            ) : (
              "You do not have the required permissions to access this page or module."
            )}
          </p>
          <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
            <Link
              to="/"
              className="btn btn-primary"
              style={{
                padding: "10px 24px",
                textDecoration: "none",
                borderRadius: "6px",
                fontWeight: 600,
                backgroundColor: "#3182ce",
                color: "#ffffff",
              }}
            >
              Return to Dashboard
            </Link>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
