/**
 * Dashboard. Ported from index.html.
 *
 * Every tile is permission-gated, and only the endpoints the user may actually
 * read are requested -- the original built its fetch list the same way, then
 * ran them through Promise.allSettled so one failing count never blanks the
 * rest of the page. The Master Data heading hides itself when none of its four
 * tiles are visible.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Banner, Can } from "@/components/ui";
import { apiGet } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import {
  IconStatAward,
  IconStatBriefcase,
  IconStatBuilding,
  IconStatTask,
  IconStatTruck,
  IconStatUsers,
} from "@/components/icons";
import type { ApiResult, ItemsPage, Organization, Task, User } from "@/types";

type StatValue = string | number;

interface Stats {
  user: StatValue;
  supplier: StatValue;
  task: StatValue;
  dept: StatValue;
  desig: StatValue;
  org: StatValue;
  country: StatValue;
  state: StatValue;
  city: StatValue;
  product: StatValue;
}

const EM_DASH = "—";

const INITIAL_STATS: Stats = {
  user: EM_DASH,
  supplier: EM_DASH,
  task: EM_DASH,
  dept: EM_DASH,
  desig: EM_DASH,
  org: "Not set up",
  country: EM_DASH,
  state: EM_DASH,
  city: EM_DASH,
  product: EM_DASH,
};

/** Pull a record count out of the pagination envelope. */
function totalRecords(res: ApiResult<unknown>): StatValue {
  return res.meta?.pagination?.total_records ?? EM_DASH;
}

function StatCard({
  permission,
  tone,
  value,
  label,
  icon,
  valueStyle,
}: {
  permission: string;
  tone?: "success" | "warning" | "danger";
  value: ReactNode;
  label: string;
  icon?: ReactNode;
  valueStyle?: React.CSSProperties;
}) {
  return (
    <Can permission={permission}>
      <div className={`stat-card${tone ? ` tone-${tone}` : ""}`}>
        <div>
          <div className="stat-value" style={valueStyle}>
            {value}
          </div>
          <div className="stat-label">{label}</div>
        </div>
        {icon && <div className="stat-icon">{icon}</div>}
      </div>
    </Can>
  );
}

export function DashboardPage() {
  const { profile, hasPermission } = useAuth();
  const [stats, setStats] = useState<Stats>(INITIAL_STATS);
  const [error] = useState<unknown>(null);

  const loadStats = useCallback(async () => {
    const next: Partial<Stats> = {};

    const jobs: { key: keyof Stats; run: () => Promise<void> }[] = [];

    if (hasPermission("user.read")) {
      jobs.push({
        key: "user",
        run: async () => {
          const res = await apiGet<ItemsPage<User> & { total?: number }>(
            "/users?page=1&page_size=1"
          );
          next.user =
            res.data?.total ??
            res.meta?.pagination?.total_records ??
            res.data?.items?.length ??
            EM_DASH;
        },
      });
    }
    if (hasPermission("supplier.read")) {
      jobs.push({
        key: "supplier",
        run: async () => {
          next.supplier = totalRecords(await apiGet("/suppliers?page=1&page_size=1"));
        },
      });
    }
    if (hasPermission("task.read")) {
      jobs.push({
        key: "task",
        run: async () => {
          const res = await apiGet<ItemsPage<Task>>("/tasks?limit=100");
          if (res.data && Array.isArray(res.data.items)) {
            next.task = res.data.items.filter(
              (t) => t.status === "PENDING" || t.status === "IN_PROGRESS"
            ).length;
          }
        },
      });
    }
    if (hasPermission("department.read")) {
      jobs.push({
        key: "dept",
        run: async () => {
          next.dept = totalRecords(await apiGet("/departments?page=1&page_size=1"));
        },
      });
    }
    if (hasPermission("designation.read")) {
      jobs.push({
        key: "desig",
        run: async () => {
          next.desig = totalRecords(await apiGet("/designations?page=1&page_size=1"));
        },
      });
    }
    if (hasPermission("organization.manage")) {
      jobs.push({
        key: "org",
        run: async () => {
          const res = await apiGet<Organization>("/organizations");
          if (res.data) next.org = res.data.company_name;
        },
      });
    }
    if (hasPermission("country.read")) {
      jobs.push({
        key: "country",
        run: async () => {
          next.country = totalRecords(await apiGet("/masters/countries?page=1&page_size=1"));
        },
      });
    }
    if (hasPermission("state.read")) {
      jobs.push({
        key: "state",
        run: async () => {
          next.state = totalRecords(await apiGet("/masters/states?page=1&page_size=1"));
        },
      });
    }
    if (hasPermission("city.read")) {
      jobs.push({
        key: "city",
        run: async () => {
          next.city = totalRecords(await apiGet("/masters/cities?page=1&page_size=1"));
        },
      });
    }
    if (hasPermission("product.read")) {
      jobs.push({
        key: "product",
        run: async () => {
          next.product = totalRecords(await apiGet("/masters/products?page=1&page_size=1"));
        },
      });
    }

    // allSettled: one denied or failing count must not blank the others.
    await Promise.allSettled(jobs.map((job) => job.run()));
    setStats((prev) => ({ ...prev, ...next }));
  }, [hasPermission]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const hasMasterCards = ["country.read", "state.read", "city.read", "product.read"].some((p) =>
    hasPermission(p)
  );

  return (
    <AppShell activeKey="dashboard">
      <main className="page">
        <div className="page-header">
          <div>
            <h1 style={{ color: "#0061f2", fontWeight: 700, fontSize: "22px" }}>
              {profile ? `Welcome To ${profile.full_name || profile.username}` : "Welcome To Rupesh Malla"}
            </h1>
            <div className="page-subtitle">
              Here's what's happening across your organization today.
            </div>
          </div>
        </div>
        <Banner error={error} />

        <div className="stat-grid">
          <StatCard
            permission="user.read"
            value={stats.user}
            label="Users"
            icon={<IconStatUsers />}
          />
          <StatCard
            permission="supplier.read"
            tone="success"
            value={stats.supplier}
            label="Suppliers"
            icon={<IconStatTruck />}
          />
          <StatCard
            permission="task.read"
            tone="warning"
            value={stats.task}
            label="Active Tasks"
            icon={<IconStatTask />}
          />
          <StatCard
            permission="department.read"
            tone="success"
            value={stats.dept}
            label="Departments"
            icon={<IconStatBriefcase />}
          />
          <StatCard
            permission="designation.read"
            tone="warning"
            value={stats.desig}
            label="Designations"
            icon={<IconStatAward />}
          />
          <StatCard
            permission="organization.manage"
            value={stats.org}
            label="Organization"
            icon={<IconStatBuilding />}
            valueStyle={{ fontSize: "16px" }}
          />
        </div>

        {hasMasterCards && (
          <div className="card-header" style={{ marginTop: "var(--space-2)" }}>
            <div className="section-title" style={{ margin: 0 }}>
              Master Data
            </div>
          </div>
        )}
        <div className="stat-grid">
          <StatCard permission="country.read" value={stats.country} label="Countries" />
          <StatCard permission="state.read" value={stats.state} label="States" />
          <StatCard permission="city.read" value={stats.city} label="Cities" />
          <StatCard permission="product.read" value={stats.product} label="Products" />
        </div>

        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>
            Quick links
          </div>
          <div
            className="form-grid"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
          >
            <Can permission="user.read">
              <p>
                <Link to="/users">Manage users</Link>
              </p>
            </Can>
            <Can permission="supplier.read">
              <p>
                <Link to="/suppliers">Manage suppliers</Link>
              </p>
            </Can>
            <Can permission="department.read">
              <p>
                <Link to="/teams">Manage departments</Link>
              </p>
            </Can>
            <Can permission="country.read">
              <p>
                <Link to="/masters/countries">Manage countries</Link>
              </p>
            </Can>
            <Can permission="product.read">
              <p>
                <Link to="/masters/products">Manage products</Link>
              </p>
            </Can>
            <Can permission="brand.read">
              <p>
                <Link to="/masters/brands">Manage brands</Link>
              </p>
            </Can>
            <Can permission="organization.manage">
              <p>
                <Link to="/organization">Organization settings</Link>
              </p>
            </Can>
            <Can permission="settings.manage">
              <p>
                <Link to="/rbac">Roles &amp; Permissions</Link>
              </p>
            </Can>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
