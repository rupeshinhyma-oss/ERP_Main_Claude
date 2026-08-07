/**
 * Cities master. Ported from masters-cities.html.
 *
 * The State dropdown is scoped to the currently selected Country. The original
 * did this with an imperative populateStateOptions() call from both the change
 * handler and fillForm(); here the option list derives from form.country_id, so
 * it stays correct without either.
 */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { SelectField, StatusSelectField, TextField } from "@/components/fields";
import { useLookup, useNameMap } from "@/lib/lookups";
import type { City, Country, State } from "@/types";

const EMPTY: FormState = { country_id: "", state_id: "", name: "", status: "active" };

export function CitiesPage() {
  const countries = useLookup<Country>("/masters/countries", 250);
  const states = useLookup<State>("/masters/states", 1000);
  const countryName = useNameMap(countries.items, (c) => c.name);
  const stateName = useNameMap(states.items, (s) => s.name);

  return (
    <MasterPage<City>
      activeKey="masters-cities"
      apiBase="/masters/cities"
      permissionPrefix="city"
      entityName="city"
      heading="Cities"
      subtitle="Belongs to a state and country; city names are unique within their state."
      breadcrumbTrail={["Master Data", "Cities"]}
      newButtonLabel="+ New City"
      searchPlaceholder="Search city name or Sr. No..."
      reloadToken={`${countries.loaded}-${states.loaded}`}
      columnHeaders={["City", "State", "Country", "Status"]}
      columns={[
        { header: "City", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "State", render: (c) => stateName(c.state_id) },
        { header: "Country", render: (c) => countryName(c.country_id) },
        { header: "Status", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "country_code", label: "Country Code", required: true },
        { key: "state_name", label: "State/Province Name", required: true },
        { key: "name", label: "City Name", required: true },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        country_id: item?.country_id ?? "",
        state_id: item?.state_id ?? "",
        name: item?.name ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => {
        if (!f.country_id) throw new Error("Please select a valid Country.");
        if (!f.state_id) throw new Error("Please select a valid State.");
        return {
          country_id: f.country_id,
          state_id: f.state_id,
          name: f.name.trim(),
          status: f.status,
        };
      }}
      renderFields={(f, set) => {
        const scopedStates = f.country_id
          ? states.items.filter((s) => s.country_id === f.country_id)
          : states.items;
        return (
          <div className="form-grid">
            <SelectField
              id="country_id"
              label="Country *"
              required
              value={f.country_id}
              onChange={(v) => {
                set("country_id", v);
                // Changing country invalidates the chosen state.
                set("state_id", "");
              }}
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
            <SelectField
              id="state_id"
              label="State *"
              required
              value={f.state_id}
              onChange={(v) => set("state_id", v)}
            >
              <option value="">
                {scopedStates.length
                  ? "-- Select State --"
                  : "-- No States Found! Create State First --"}
              </option>
              {scopedStates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
            <TextField id="name" label="City Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
            <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
          </div>
        );
      }}
      detailFields={(c) => [
        { label: "City Name", value: c.name, fullWidth: true },
        { label: "State / Province", value: stateName(c.state_id) },
        { label: "Country", value: countryName(c.country_id) },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}
