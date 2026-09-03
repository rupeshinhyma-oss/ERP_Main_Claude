/**
 * Positions / Designations master (Part 3 of the Org/Employee/IAM upgrade
 * brief). Deliberately holds no reporting-hierarchy or permission
 * information -- see app.org_structure.models.Position docstring.
 */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { StatusSelectField, TextAreaField, TextField, nullIfBlank } from "@/components/fields";
import type { Position } from "@/types";

const EMPTY: FormState = { name: "", code: "", description: "", status: "active" };

export function PositionsPage() {
  return (
    <MasterPage<Position>
      activeKey="positions"
      apiBase="/positions"
      permissionPrefix="position"
      liveModule="positions"
      entityName="position"
      heading="Positions & Designations"
      subtitle="Job titles employees can hold. Does not determine reporting hierarchy or software permissions."
      breadcrumbTrail={["User & Organization Management", "Positions"]}
      newButtonLabel="+ New Position"
      hideQuickAdd
      searchPlaceholder="Search position name..."
      importHeaders={[]}
      columnHeaders={["Name", "Code", "Employees", "Status"]}
      columns={[
        { header: "Name", render: (p) => <span className="cell-primary">{p.name}</span> },
        { header: "Code", render: (p) => p.code || <span className="muted">--</span> },
        {
          header: "Employees",
          render: (p) => {
            const count = p.employee_count ?? 0;
            return count > 0 ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  padding: "2px 8px",
                  borderRadius: "9999px",
                  fontSize: "12px",
                  fontWeight: 600,
                  border: "1px solid #bfdbfe",
                }}
                title={`${count} employee(s) assigned`}
              >
                👤 {count}
              </span>
            ) : (
              <span className="muted">0</span>
            );
          },
        },
        { header: "Status", render: (p) => <StatusBadge status={p.status} /> },
      ]}
      canDeleteItem={(p) => {
        const count = p.employee_count ?? 0;
        if (count > 0) {
          return {
            allowed: false,
            reason: `Cannot delete "${p.name}": There is already ${count === 1 ? "1 employee" : `${count} employees`} currently holding this position. Deletion is locked.`,
          };
        }
        return true;
      }}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        description: item?.description ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: nullIfBlank(f.code),
        description: nullIfBlank(f.description),
        status: (f.status || "ACTIVE").toUpperCase(),
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Position Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="code" label="Code" maxLength={50} value={f.code} onChange={(v) => set("code", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
          <TextAreaField id="description" label="Description" value={f.description} onChange={(v) => set("description", v)} />
        </div>
      )}
      detailFields={(p) => [
        { label: "Position Name", value: p.name, fullWidth: true },
        { label: "Code", value: p.code || "--" },
        { label: "Assigned Employees", value: `${p.employee_count ?? 0} active holder(s)` },
        { label: "Description", value: p.description || "--", fullWidth: true },
        { label: "Current Status", value: <StatusBadge status={p.status} /> },
      ]}
    />
  );
}