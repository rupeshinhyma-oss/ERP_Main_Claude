/** Brands master. Ported from masters-brands.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextAreaField, TextField, nullIfBlank } from "@/components/fields";
import type { Brand } from "@/types";

const EMPTY: FormState = { name: "", code: "", logo_url: "", description: "", status: "active" };

export function BrandsPage() {
  return (
    <MasterPage<Brand>
      activeKey="masters-brands"
      apiBase="/masters/brands"
      permissionPrefix="brand"
      entityName="brand"
      heading="Brands"
      subtitle="Product brand names, referenced by the Product master."
      breadcrumbTrail={["Master Data", "Brands"]}
      newButtonLabel="+ New Brand"
      hideQuickAdd
      searchPlaceholder="Search name or code or Sr. No..."
      columnHeaders={["Name", "Code", "Description", "Status"]}
      columns={[
        { header: "Name", render: (b) => <span className="cell-primary">{b.name}</span> },
        { header: "Code", render: (b) => b.code },
        { header: "Description", render: (b) => dash(b.description) },
        { header: "Status", render: (b) => <StatusBadge status={b.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Brand Name", required: true },
        { key: "code", label: "Brand Code", required: true },
        { key: "description", label: "Description" },
        { key: "logo_url", label: "Logo URL" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        logo_url: item?.logo_url ?? "",
        description: item?.description ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: f.code.trim(),
        logo_url: nullIfBlank(f.logo_url),
        description: nullIfBlank(f.description),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <>
          <div className="form-grid">
            <TextField id="name" label="Brand Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
            <TextField id="code" label="Brand Code *" required maxLength={50} value={f.code} onChange={(v) => set("code", v)} />
            <TextField id="logo_url" label="Logo URL" maxLength={500} placeholder="https://..." value={f.logo_url} onChange={(v) => set("logo_url", v)} />
            <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
          </div>
          <TextAreaField id="description" label="Description" value={f.description} onChange={(v) => set("description", v)} />
        </>
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
