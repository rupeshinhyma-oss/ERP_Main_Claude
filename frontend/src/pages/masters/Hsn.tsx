/** HSN Codes master. Ported from masters-hsn.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextAreaField, TextField, nullIfBlank } from "@/components/fields";
import type { Hsn } from "@/types";

const EMPTY: FormState = {
  code: "",
  gst_percent: "0",
  refund_vat_percent: "0",
  description: "",
  status: "active",
};

export function HsnPage() {
  return (
    <MasterPage<Hsn>
      activeKey="masters-hsn"
      apiBase="/masters/hsn"
      permissionPrefix="hsn"
      exportPermission="hsn.export"
      bulkActionPermission="hsn.bulk_action"
      liveModule="hsn"
      entityName="HSN code"
      heading="HSN Codes"
      subtitle="Harmonized System Nomenclature codes for GST classification."
      breadcrumbTrail={["Master Data", "HSN Codes"]}
      newButtonLabel="+ New HSN Code"
      searchPlaceholder="Search code or description or Sr. No..."
      hideQuickAdd={true}
      columnHeaders={["HSN Code", "Description", "GST %", "Refund VAT %", "Status"]}
      columns={[
        { header: "HSN Code", render: (h) => <span className="cell-primary">{h.code}</span> },
        { header: "Description", render: (h) => dash(h.description) },
        { header: "GST %", render: (h) => `${h.gst_percent}%` },
        { header: "Refund VAT %", render: (h) => `${h.refund_vat_percent || 0}%` },
        { header: "Status", render: (h) => <StatusBadge status={h.status} /> },
      ]}
      importHeaders={[
        { key: "code", label: "HSN Code", required: true },
        { key: "gst_percent", label: "GST %" },
        { key: "refund_vat_percent", label: "Refund VAT %" },
        { key: "description", label: "Description" },
        { key: "status", label: "Status" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        code: item?.code ?? "",
        gst_percent: item ? String(item.gst_percent) : "0",
        refund_vat_percent: item ? String(item.refund_vat_percent ?? 0) : "0",
        description: item?.description ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        code: f.code.trim(),
        gst_percent: parseFloat(f.gst_percent) || 0,
        refund_vat_percent: parseFloat(f.refund_vat_percent) || 0,
        description: nullIfBlank(f.description),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <>
          <div className="form-grid">
            <TextField id="code" label="HSN Code *" required maxLength={20} value={f.code} onChange={(v) => set("code", v)} />
            <TextField id="gst_percent" label="GST %" type="number" min={0} max={100} step="0.01" value={f.gst_percent} onChange={(v) => set("gst_percent", v)} />
            <TextField id="refund_vat_percent" label="Refund VAT %" type="number" min={0} max={100} step="0.01" value={f.refund_vat_percent} onChange={(v) => set("refund_vat_percent", v)} />
            <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
          </div>
          <TextAreaField id="description" label="Description" value={f.description} onChange={(v) => set("description", v)} />
        </>
      )}
      detailFields={(h) => [
        { label: "HSN Code", value: h.code, fullWidth: true },
        { label: "GST %", value: `${h.gst_percent}%` },
        { label: "Refund VAT %", value: `${h.refund_vat_percent || 0}%` },
        { label: "Current Status", value: <StatusBadge status={h.status} /> },
        { label: "Description", value: dash(h.description), fullWidth: true },
      ]}
    />
  );
}