/** Brands master. Ported from masters-brands.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import type { Brand } from "@/types";

const EMPTY: FormState = { name: "", code: "", status: "active" };

export function BrandsPage() {
  return (
    <MasterPage<Brand>
      activeKey="masters-brands"
      apiBase="/masters/brands"
      permissionPrefix="brand"
      liveModule="brands"
      entityName="brand"
      heading="Brands"
      subtitle="Product brand names, referenced by the Product master."
      breadcrumbTrail={["Master Data", "Brands"]}
      newButtonLabel="+ New Brand"
      hideQuickAdd
      searchPlaceholder="Search name or Sr. No..."
      columnHeaders={["Name", "Status"]}
      columns={[
        { header: "Name", render: (b) => <span className="cell-primary">{b.name}</span> },
        { header: "Status", render: (b) => <StatusBadge status={b.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Brand Name", required: true },
        { key: "code", label: "Brand Code" },
        { key: "description", label: "Description" },
        { key: "logo_url", label: "Logo URL" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: nullIfBlank(f.code),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Brand Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(b) => [
        { label: "Brand Name", value: b.name, fullWidth: true },
        { label: "Brand Code", value: b.code },
        { label: "Current Status", value: <StatusBadge status={b.status} /> },
        { label: "Description", value: dash(b.description), fullWidth: true },
      ]}
    />
  );
}