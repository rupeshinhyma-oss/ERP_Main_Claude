/** Countries master. Ported from masters-countries.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import type { Country } from "@/types";

const EMPTY: FormState = {
  name: "",
  code: "",
  iso2: "",
  iso3: "",
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
      entityName="country"
      heading="Countries"
      subtitle="The root of the geography hierarchy — referenced by states, cities, and future modules."
      breadcrumbTrail={["Master Data", "Countries"]}
      newButtonLabel="+ New Country"
      searchPlaceholder="Search code or name or Sr. No..."
      columnHeaders={["Name", "Code", "ISO2 / ISO3", "Phone Code", "Currency", "Status"]}
      columns={[
        { header: "Name", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "Code", render: (c) => c.code },
        { header: "ISO", render: (c) => `${dash(c.iso2)} / ${dash(c.iso3)}` },
        { header: "Phone Code", render: (c) => dash(c.phone_code) },
        { header: "Currency", render: (c) => dash(c.currency) },
        { header: "Status", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Country Name", required: true },
        { key: "code", label: "ISO Code", required: true },
        { key: "iso2", label: "ISO2 Code" },
        { key: "iso3", label: "ISO3 Code" },
        { key: "phone_code", label: "Phone Code" },
        { key: "nationality", label: "Nationality" },
        { key: "currency", label: "Currency Code" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        iso2: item?.iso2 ?? "",
        iso3: item?.iso3 ?? "",
        phone_code: item?.phone_code ?? "",
        nationality: item?.nationality ?? "",
        currency: item?.currency ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        name: f.name.trim(),
        code: f.code.trim(),
        iso2: nullIfBlank(f.iso2),
        iso3: nullIfBlank(f.iso3),
        phone_code: nullIfBlank(f.phone_code),
        nationality: nullIfBlank(f.nationality),
        currency: nullIfBlank(f.currency),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Country Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="code" label="Country Code (ISO) *" required maxLength={10} value={f.code} onChange={(v) => set("code", v)} />
          <TextField id="iso2" label="ISO2" maxLength={2} value={f.iso2} onChange={(v) => set("iso2", v)} />
          <TextField id="iso3" label="ISO3" maxLength={3} value={f.iso3} onChange={(v) => set("iso3", v)} />
          <TextField id="phone_code" label="Phone Code" maxLength={10} placeholder="+91" value={f.phone_code} onChange={(v) => set("phone_code", v)} />
          <TextField id="nationality" label="Nationality" maxLength={100} value={f.nationality} onChange={(v) => set("nationality", v)} />
          <TextField id="currency" label="Currency Code" maxLength={10} placeholder="INR" value={f.currency} onChange={(v) => set("currency", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(c) => [
        { label: "Country Name", value: c.name, fullWidth: true },
        { label: "Country Code", value: c.code },
        { label: "ISO2", value: dash(c.iso2) },
        { label: "ISO3", value: dash(c.iso3) },
        { label: "Phone Code", value: dash(c.phone_code) },
        { label: "Nationality", value: dash(c.nationality) },
        { label: "Primary Currency", value: dash(c.currency) },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}
