import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/lib/hooks";

export function DashboardPage() {
  const { profile } = useAuth();

  const titleName = profile && typeof profile === "object"
    ? profile.full_name || profile.username || "Rupesh Malla"
    : "Rupesh Malla";

  return (
    <AppShell activeKey="dashboard">
      <main className="page" style={{ background: "#f8fafc", minHeight: "calc(100vh - 60px)", padding: "24px 32px" }}>
        <div style={{ marginBottom: "24px" }}>
          <h1 style={{ color: "#0f172a", fontWeight: 600, fontSize: "20px", margin: 0 }}>
            {`Welcome To ${titleName}`}
          </h1>
        </div>
      </main>
    </AppShell>
  );
}
