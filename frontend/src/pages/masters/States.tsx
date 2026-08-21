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
      exportPermission="state.export"
      bulkActionPermission="state.bulk_action"
      liveModule="states"
      entityName="state"
      heading="Provinces (First Level Divisions)"
      subtitle="First-level administrative divisions of China: 23 Provinces, 5 Autonomous Regions, 4 Direct-administered Municipalities (Beijing, Shanghai, Tianjin, Chongqing), and 2 SARs."
      breadcrumbTrail={["Master Data", "Provinces"]}
      newButtonLabel="+ New Province"
      searchPlaceholder="Search province name or code or Sr. No..."
      hideQuickAdd={true}
      reloadToken={countries.loaded}
      extraFilters={countryFilter ? { country_id: countryFilter } : undefined}
      toolbarExtras={
        <select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)}>
          <option value="">All Countries / National Levels</option>
          {countries.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      }
      columnHeaders={["Province Name", "Province Code", "Country", "Status"]}
      columns={[
        { header: "Province Name", render: (s) => <span className="cell-primary">{s.name}</span> },
        { header: "Province Code", render: (s) => dash(s.code) },
        { header: "Country", render: (s) => countryName(s.country_id) },
        { header: "Status", render: (s) => <StatusBadge status={s.status} /> },
      ]}
      importHeaders={[
        { key: "country_code", label: "Country Code", required: true },
        { key: "name", label: "Province / Region Name", required: true },
        { key: "code", label: "Province Code" },
        { key: "status", label: "Status" },
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
            label="Country / National Level *"
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
          <TextField id="name" label="Province / Region Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <TextField id="code" label="Province Code" maxLength={20} value={f.code} onChange={(v) => set("code", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(s) => [
        { label: "Province / Region Name", value: s.name, fullWidth: true },
        { label: "Province Code", value: dash(s.code) },
        { label: "Country", value: countryName(s.country_id) },
        { label: "Current Status", value: <StatusBadge status={s.status} /> },
      ]}
    />
  );
}