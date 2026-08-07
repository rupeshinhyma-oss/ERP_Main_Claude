/** States master. Ported from masters-states.html. */

import { useState } from "react";
import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { SelectField, StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import { useLookup, useNameMap } from "@/lib/lookups";
import type { Country, State } from "@/types";

const EMPTY: FormState = { country_id: "", name: "", code: "", status: "active" };

export function StatesPage() {
  const countries = useLookup<Country>("/masters/countries", 250);
  const countryName = useNameMap(countries.items, (c) => c.name);
  const [countryFilter, setCountryFilter] = useState("");

  return (
    <MasterPage<State>
      activeKey="masters-states"
      apiBase="/masters/states"
      permissionPrefix="state"
      entityName="state"
      heading="States"
      subtitle="Belongs to a country; state names are unique within their country."
      breadcrumbTrail={["Master Data", "States"]}
      newButtonLabel="+ New State"
      searchPlaceholder="Search name or code or Sr. No..."
      reloadToken={countries.loaded}
      extraFilters={countryFilter ? { country_id: countryFilter } : undefined}
      toolbarExtras={
        <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
          <option value="">All countries</option>
          {countries.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      }
      columnHeaders={["Name", "Code", "Country", "Status"]}
      columns={[
        { header: "Name", render: (s) => <span className="cell-primary">{s.name}</span> },
        { header: "Code", render: (s) => dash(s.code) },
        { header: "Country", render: (s) => countryName(s.country_id) },
        { header: "Status", render: (s) => <StatusBadge status={s.status} /> },
      ]}
      importHeaders={[
        { key: "country_code", label: "Country Code", required: true },
        { key: "name", label: "State/Province Name", required: true },
        { key: "code", label: "State Code" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        country_id: item?.country_id ?? "",
        name: item?.name ?? "",
        code: item?.code ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => {
        if (!f.country_id) {
          throw new Error("Please select a valid Country.");
        }
        return {
          country_id: f.country_id,
          name: f.name.trim(),
          code: nullIfBlank(f.code),
          status: f.status,
        };
      }}
      renderFields={(f, set) => (
        <div className="form-grid">
          <SelectField
            id="country_id"
            label="Country *"
            required
            value={f.country_id}
            onChange={(v) => set("country_id", v)}
          >
            <option value="">
              {countries.items.length
                ? "-- Select Country --"
                : "-- No Countries Found! Create Country First --"}
            </option>
            {countries.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </SelectField>
          <TextField id="name" label="State Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="code" label="State Code" maxLength={20} value={f.code} onChange={(v) => set("code", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(s) => [
        { label: "State/Province Name", value: s.name, fullWidth: true },
        { label: "State Code", value: dash(s.code) },
        { label: "Country", value: countryName(s.country_id) },
        { label: "Current Status", value: <StatusBadge status={s.status} /> },
      ]}
    />
  );
}
