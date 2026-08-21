/** Currencies master. Ported from masters-currencies.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import type { Currency } from "@/types";

const EMPTY: FormState = { name: "", code: "", symbol: "", decimal_places: "2", status: "active" };

export function CurrenciesPage() {
  return (
    <MasterPage<Currency>
      activeKey="masters-currencies"
      apiBase="/masters/currencies"
      permissionPrefix="currency"
      exportPermission="currency.export"
      bulkActionPermission="currency.bulk_action"
      liveModule="currencies"
      entityName="currency"
      heading="Currencies"
      subtitle="Reference currencies for pricing, invoicing, and finance."
      breadcrumbTrail={["Master Data", "Currencies"]}
      newButtonLabel="+ New Currency"
      searchPlaceholder="Search name or code or Sr. No..."
      hideQuickAdd={true}
      columnHeaders={["CURRENCY NAME", "CODE", "SYMBOL", "DECIMAL PLACES", "STATUS"]}
      columns={[
        { header: "CURRENCY NAME", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "CODE", render: (c) => c.code },
        { header: "SYMBOL", render: (c) => dash(c.symbol) },
        { header: "DECIMAL PLACES", render: (c) => c.decimal_places },
        { header: "STATUS", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Currency Name", required: true },
        { key: "code", label: "Currency Code (ISO 4217)", required: true },
        { key: "symbol", label: "Symbol" },
        { key: "decimal_places", label: "Decimal Places" },
        { key: "status", label: "Status" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        symbol: item?.symbol ?? "",
        decimal_places: item ? String(item.decimal_places) : "2",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: f.code.trim(),
        symbol: nullIfBlank(f.symbol),
        decimal_places: parseInt(f.decimal_places, 10) || 0,
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Currency Name *" required maxLength={100} value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="code" label="Currency Code *" required maxLength={10} placeholder="INR" value={f.code} onChange={(v) => set("code", v)} />
          <TextField id="symbol" label="Currency Symbol" maxLength={10} placeholder="₹" value={f.symbol} onChange={(v) => set("symbol", v)} />
          <TextField id="decimal_places" label="Decimal Places" type="number" min={0} max={6} value={f.decimal_places} onChange={(v) => set("decimal_places", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(c) => [
        { label: "Currency Name", value: c.name, fullWidth: true },
        { label: "ISO Code", value: c.code },
        { label: "Symbol", value: dash(c.symbol) },
        { label: "Decimal Places", value: c.decimal_places },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}