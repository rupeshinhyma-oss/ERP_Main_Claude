/** Units of Measurement master. Ported from masters-uom.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import type { Uom } from "@/types";

const EMPTY: FormState = { name: "", short_name: "", status: "active" };

export function UomPage() {
  return (
    <MasterPage<Uom>
      activeKey="masters-uom"
      apiBase="/masters/uom"
      permissionPrefix="uom"
      exportPermission="uom.export"
      bulkActionPermission="uom.bulk_action"
      liveModule="uom"
      entityName="unit of measurement"
      heading="Units of Measurement"
      subtitle="KG, GM, PCS, BOX, LTR, MTR, SET, PAIR and any others your products need."
      breadcrumbTrail={["Master Data", "Units of Measurement"]}
      newButtonLabel="+ New UOM"
      searchPlaceholder="Search name or Sr. No..."
      hideQuickAdd={true}
      columnHeaders={["Name", "Short Name", "Status"]}
      columns={[
        { header: "Name", render: (u) => <span className="cell-primary">{u.name}</span> },
        { header: "Short Name", render: (u) => dash(u.short_name) },
        { header: "Status", render: (u) => <StatusBadge status={u.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "UOM Name", required: true },
        { key: "short_name", label: "Short Name" },
        { key: "status", label: "Status" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        short_name: item?.short_name ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        // auto-generate code from name so the backend required field is satisfied
        code: f.name.trim().toUpperCase().replace(/\s+/g, "_").slice(0, 20),
        name: f.name.trim(),
        short_name: nullIfBlank(f.short_name),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Name *" required maxLength={100} placeholder="Kilogram" value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="short_name" label="Short Name" maxLength={20} placeholder="kg" value={f.short_name} onChange={(v) => set("short_name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(u) => [
        { label: "UOM Name", value: u.name, fullWidth: true },
        { label: "Short Name", value: dash(u.short_name) },
        { label: "Current Status", value: <StatusBadge status={u.status} /> },
      ]}
      detailTitle={(u) => u.name}
      detailSubtitle={(u) => dash(u.short_name)}
    />
  );
}