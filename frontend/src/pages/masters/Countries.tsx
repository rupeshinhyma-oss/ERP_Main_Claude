/** Countries master. Ported from masters-countries.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import type { Country } from "@/types";

const EMPTY: FormState = {
  name: "",
  code: "",
  phone_code: "",
  nationality: "",
  currency: "",
  status: "active",
};

export function CountriesPage() {
  return (
    <MasterPage<Country>
      activeKey="masters-countries"
      apiBase="/masters/countries"
      permissionPrefix="country"
      liveModule="countries"
      entityName="country"
      heading="Countries (National Level)"
      subtitle="National-level administrative divisions — People's Republic of China and international trading partners."
      breadcrumbTrail={["Master Data", "Countries"]}
      newButtonLabel="+ New Country"
      searchPlaceholder="Search code or name or Sr. No..."
      hideQuickAdd={true}
      columnHeaders={["COUNTRY NAME", "CODE", "PHONE CODE", "CURRENCY", "STATUS"]}
      columns={[
        { header: "COUNTRY NAME", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "CODE", render: (c) => c.code },
        { header: "PHONE CODE", render: (c) => dash(c.phone_code) },
        { header: "CURRENCY", render: (c) => dash(c.currency) },
        { header: "STATUS", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Country Name", required: true },
        { key: "code", label: "ISO Code", required: true },
        { key: "phone_code", label: "Phone Code" },
        { key: "nationality", label: "Nationality" },
        { key: "currency", label: "Currency Code" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        phone_code: item?.phone_code ?? "",
        nationality: item?.nationality ?? "",
        currency: item?.currency ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: f.code.trim(),
        phone_code: nullIfBlank(f.phone_code),
        nationality: nullIfBlank(f.nationality),
        currency: nullIfBlank(f.currency),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Country Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="code" label="Country Code (ISO) *" required maxLength={10} value={f.code} onChange={(v) => set("code", v)} />
          <TextField id="phone_code" label="Phone Code" maxLength={10} placeholder="+91" value={f.phone_code} onChange={(v) => set("phone_code", v)} />
          <TextField id="nationality" label="Nationality" maxLength={100} value={f.nationality} onChange={(v) => set("nationality", v)} />
          <TextField id="currency" label="Currency Code" maxLength={10} placeholder="INR" value={f.currency} onChange={(v) => set("currency", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(c) => [
        { label: "Country Name", value: c.name, fullWidth: true },
        { label: "Country Code", value: c.code },
        { label: "Phone Code", value: dash(c.phone_code) },
        { label: "Nationality", value: dash(c.nationality) },
        { label: "Primary Currency", value: dash(c.currency) },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}