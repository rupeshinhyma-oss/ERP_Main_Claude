/** Company List master. Allows managing group operating companies (Inhyma, FNB Solution, etc.). */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { StatusSelectField, TextField } from "@/components/fields";
import type { MasterRecord } from "@/types";

interface MasterCompanyItem extends MasterRecord {
  name: string;
  code: string;
  description?: string;
  status: string;
}

const EMPTY: FormState = { name: "", code: "", description: "", status: "active" };

export function CompanyListPage() {
  return (
    <MasterPage<MasterCompanyItem>
      activeKey="masters-company-list"
      apiBase="/masters/company-list"
      permissionPrefix="company"
      entityName="organization"
      heading="Organization List"
      subtitle="Manage group operating entities and companies (e.g. Inhyma, FNB Solution)."
      breadcrumbTrail={["Master Data", "Organization List"]}
      newButtonLabel="+ ADD NEW ORGANIZATION"
      searchPlaceholder="Search organization name or Sr. No..."
      columnHeaders={["ORGANIZATION NAME", "STATUS"]}
      columns={[
        { header: "ORGANIZATION NAME", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "STATUS", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Organization Name", required: true },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        description: item?.description ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => {
        if (!f.name.trim()) throw new Error("Organization Name is required.");
        return {
          name: f.name.trim(),
          code: f.code.trim(),
          description: f.description.trim(),
          status: f.status,
        };
      }}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Organization Name *" required maxLength={150} placeholder="e.g. Inhyma" value={f.name} onChange={(v) => set("name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(c) => [
        { label: "Organization Name", value: c.name, fullWidth: true },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}
