/** Units of Measurement master. Ported from masters-uom.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextAreaField, TextField, nullIfBlank } from "@/components/fields";
import type { Uom } from "@/types";

const EMPTY: FormState = { code: "", name: "", short_name: "", description: "", status: "active" };

export function UomPage() {
  return (
    <MasterPage<Uom>
      activeKey="masters-uom"
      apiBase="/masters/uom"
      permissionPrefix="uom"
      entityName="unit of measurement"
      heading="Units of Measurement"
      subtitle="KG, GM, PCS, BOX, LTR, MTR, SET, PAIR and any others your products need."
      breadcrumbTrail={["Master Data", "Units of Measurement"]}
      newButtonLabel="+ New UOM"
      searchPlaceholder="Search code or name or Sr. No..."
      columnHeaders={["Code", "Name", "Short Name", "Description", "Status"]}
      columns={[
        { header: "Code", render: (u) => <span className="cell-primary">{u.code}</span> },
        { header: "Name", render: (u) => u.name },
        { header: "Short Name", render: (u) => dash(u.short_name) },
        { header: "Description", render: (u) => dash(u.description) },
        { header: "Status", render: (u) => <StatusBadge status={u.status} /> },
      ]}
      importHeaders={[
        { key: "code", label: "UOM Code", required: true },
        { key: "name", label: "UOM Name", required: true },
        { key: "short_name", label: "Short Name" },
        { key: "description", label: "Description" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        code: item?.code ?? "",
        name: item?.name ?? "",
        short_name: item?.short_name ?? "",
        description: item?.description ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        code: f.code.trim(),
        name: f.name.trim(),
        short_name: nullIfBlank(f.short_name),
        description: nullIfBlank(f.description),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <>
          <div className="form-grid">
            <TextField id="code" label="Code *" required maxLength={20} placeholder="KG" value={f.code} onChange={(v) => set("code", v)} />
            <TextField id="name" label="Name *" required maxLength={100} placeholder="Kilogram" value={f.name} onChange={(v) => set("name", v)} />
            <TextField id="short_name" label="Short Name" maxLength={20} placeholder="kg" value={f.short_name} onChange={(v) => set("short_name", v)} />
            <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
          </div>
          <TextAreaField id="description" label="Description" value={f.description} onChange={(v) => set("description", v)} />
        </>
      )}
      detailFields={(u) => [
        { label: "UOM Name", value: u.name, fullWidth: true },
        { label: "UOM Code", value: u.code },
        { label: "Short Name", value: dash(u.short_name) },
        { label: "Current Status", value: <StatusBadge status={u.status} /> },
        { label: "Description", value: dash(u.description), fullWidth: true },
      ]}
      detailTitle={(u) => u.name}
      detailSubtitle={(u) => `Code: ${u.code}`}
    />
  );
}
