/**
 * "Feature coming soon" placeholder.
 *
 * Ported verbatim from the near-identical markup in buyers.html and
 * inquiries.html -- both modules are stubs with a page header, breadcrumb,
 * and a centered coming-soon card, differing only in title/copy.
 */

import { Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";

export function ComingSoonPage({
  activeKey,
  title,
  subtitle,
  breadcrumbLabel,
  featureName,
}: {
  activeKey: string;
  title: string;
  subtitle: string;
  breadcrumbLabel: string;
  featureName: string;
}) {
  return (
    <AppShell activeKey={activeKey}>
      <main className="page">
        <Breadcrumb trail={[breadcrumbLabel]} />
        <div className="page-header">
          <div>
            <h1>{title}</h1>
            <div className="page-subtitle">{subtitle}</div>
          </div>
        </div>

        <div
          style={{
            maxWidth: "600px",
            margin: "40px auto",
            padding: "48px 36px",
            textAlign: "center",
            background: "#ffffff",
            borderRadius: "16px",
            boxShadow: "0 10px 30px -5px rgba(15,23,42,0.08)",
            border: "1px solid #e2e8f0",
          }}
        >
          <div
            style={{
              width: "72px",
              height: "72px",
              margin: "0 auto 20px auto",
              background: "#eff6ff",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "32px",
            }}
          >
            🚀
          </div>
          <h2
            style={{
              fontSize: "22px",
              fontWeight: 800,
              color: "#0f172a",
              marginBottom: "10px",
            }}
          >
            Feature Coming Soon
          </h2>
          <p
            style={{
              color: "#64748b",
              fontSize: "14.5px",
              lineHeight: 1.6,
              marginBottom: "28px",
              maxWidth: "460px",
              marginLeft: "auto",
              marginRight: "auto",
            }}
          >
            The <strong>{featureName}</strong> module is currently under active development and
            will be available in an upcoming system release.
          </p>
          <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
            <Link
              to="/"
              className="btn btn-primary"
              style={{
                padding: "11px 24px",
                fontSize: "14px",
                fontWeight: 600,
                borderRadius: "8px",
                textDecoration: "none",
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
