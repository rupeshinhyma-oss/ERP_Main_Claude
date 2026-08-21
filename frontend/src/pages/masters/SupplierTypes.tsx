/** Supplier Types master page. Simplified to Name and Status only. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { StatusSelectField, TextField } from "@/components/fields";
import type { SupplierType } from "@/types";

const EMPTY: FormState = { name: "", status: "active" };

export function SupplierTypesPage() {
  return (
    <MasterPage<SupplierType>
      activeKey="masters-supplier-types"
      apiBase="/masters/supplier-types"
      permissionPrefix="suppliertype"
      exportPermission="suppliertype.export"
      bulkActionPermission="suppliertype.bulk_action"
      entityName="supplier type"
      heading="Supplier Types"
      subtitle="Manufacturer, Dealer / Trader, Agent, Importer, Service Provider, etc."
      breadcrumbTrail={["Master Data", "Supplier Types"]}
      newButtonLabel="+ New Supplier Type"
      hideQuickAdd
      searchPlaceholder="Search name or Sr. No..."
      columnHeaders={["Name", "Status"]}
      columns={[
        { header: "Name", render: (b) => <span className="cell-primary">{b.name}</span> },
        { header: "Status", render: (b) => <StatusBadge status={b.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Supplier Type Name", required: true },
        { key: "status", label: "Status" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: f.name.trim() ? `ST-${f.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 15)}` : "ST-GEN",
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Supplier Type Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(b) => [
        { label: "Supplier Type Name", value: b.name, fullWidth: true },
        { label: "Current Status", value: <StatusBadge status={b.status} /> },
      ]}
    />
  );
}