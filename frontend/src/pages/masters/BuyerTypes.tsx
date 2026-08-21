/** Buyer Types master page. Configurable buyer classifications. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { StatusSelectField, TextField } from "@/components/fields";

export interface BuyerTypeItem {
  id: string;
  name: string;
  code: string;
  description?: string;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

const EMPTY: FormState = { name: "", status: "active" };

export function BuyerTypesPage() {
  return (
    <MasterPage<BuyerTypeItem>
      activeKey="masters-buyer-types"
      apiBase="/masters/buyer-types"
      permissionPrefix="buyertype"
      exportPermission="buyertype.export"
      bulkActionPermission="buyertype.bulk_action"
      entityName="buyer type"
      heading="Buyer Types"
      subtitle="Manufacturer, Dealer / Trader, Agent, Importer, Distributor, etc."
      breadcrumbTrail={["Master Data", "Buyer Types"]}
      newButtonLabel="+ New Buyer Type"
      hideQuickAdd
      searchPlaceholder="Search name or Sr. No..."
      columnHeaders={["Name", "Status"]}
      columns={[
        { header: "Name", render: (b) => <span className="cell-primary">{b.name}</span> },
        { header: "Status", render: (b) => <StatusBadge status={b.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Buyer Type Name", required: true },
        { key: "status", label: "Status" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: f.name.trim() ? `BT-${f.name.trim().toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 15)}` : "BT-GEN",
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Buyer Type Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(b) => [
        { label: "Buyer Type Name", value: b.name, fullWidth: true },
        { label: "Current Status", value: <StatusBadge status={b.status} /> },
      ]}
    />
  );
}