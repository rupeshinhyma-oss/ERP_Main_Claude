/** Product Sub-Categories master. Ported from masters-subcategories.html. */

import { useState } from "react";
import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import {
  SearchableSelectField,
  StatusSelectField,
  TextField,
  nullIfBlank,
} from "@/components/fields";
import { useLookup, useNameMap } from "@/lib/lookups";
import type { ProductCategory, ProductSubCategory } from "@/types";

const EMPTY: FormState = {
  category_id: "",
  code: "",
  name: "",
  status: "active",
};

export function SubCategoriesPage() {
  const categories = useLookup<ProductCategory>("/masters/product-categories", 250, true);
  const categoryName = useNameMap(categories.items, (c) => `${c.name}${c.status === "inactive" ? " (Inactive)" : ""}`);
  const [categoryFilter, setCategoryFilter] = useState("");

  return (
    <MasterPage<ProductSubCategory>
      activeKey="masters-subcategories"
      apiBase="/masters/product-sub-categories"
      permissionPrefix="subcategory"
      exportPermission="subcategory.export"
      bulkActionPermission="subcategory.bulk_action"
      liveModule="subcategories"
      entityName="sub-category"
      heading="Product Sub-Categories"
      subtitle="Belongs to a category; names are unique within their category."
      breadcrumbTrail={["Master Data", "Sub-Categories"]}
      newButtonLabel="+ New Sub-Category"
      hideQuickAdd
      searchPlaceholder="Search name or Sr. No..."
      reloadToken={categories.loaded}
      extraFilters={categoryFilter ? { category_id: categoryFilter } : undefined}
      toolbarExtras={
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
          <option value="">All categories</option>
          {categories.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}{c.status === "inactive" ? " (Inactive)" : ""}
            </option>
          ))}
        </select>
      }
      columnHeaders={["Name", "Category", "Status"]}
      columns={[
        { header: "Name", render: (s) => <span className="cell-primary">{s.name}</span> },
        { header: "Category", render: (s) => categoryName(s.category_id) },
        { header: "Status", render: (s) => <StatusBadge status={s.status} /> },
      ]}
      importHeaders={[
        { key: "category_code", label: "Category Code", required: true },
        { key: "code", label: "Sub-Category Code" },
        { key: "name", label: "Sub-Category Name", required: true },
        { key: "description", label: "Description" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        category_id: item?.category_id ?? "",
        code: item?.code ?? "",
        name: item?.name ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => {
        if (!f.category_id) {
          throw new Error("Please select a valid Category.");
        }
        return {
          category_id: f.category_id,
          code: nullIfBlank(f.code),
          name: f.name.trim(),
          status: f.status,
        };
      }}
      renderFields={(f, set) => (
        <div className="form-grid">
          <SearchableSelectField
            id="category_id"
            label="Category *"
            required
            value={f.category_id}
            onChange={(v) => set("category_id", v)}
          >
            <option value="">
              {categories.items.length
                ? "-- Select Category --"
                : "-- No Categories Found! Create Category First --"}
            </option>
            {categories.items
              .filter((c) => c.status === "active" || c.id === f.category_id)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.status === "inactive" ? " (Inactive)" : ""}
                </option>
              ))}
          </SearchableSelectField>
          <TextField id="name" label="Sub-Category Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(s) => [
        { label: "Sub-Category Name", value: s.name, fullWidth: true },
        { label: "Category", value: categoryName(s.category_id) },
        { label: "Sub-Category Code", value: s.code },
        { label: "Current Status", value: <StatusBadge status={s.status} /> },
        { label: "Description", value: dash(s.description), fullWidth: true },
      ]}
    />
  );
}