/** Product Categories master. Ported from masters-categories.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { StatusSelectField, TextField, nullIfBlank } from "@/components/fields";
import type { ProductCategory } from "@/types";

const EMPTY: FormState = { code: "", name: "", status: "active" };

export function CategoriesPage() {
  return (
    <MasterPage<ProductCategory>
      activeKey="masters-categories"
      apiBase="/masters/product-categories"
      permissionPrefix="category"
      exportPermission="category.export"
      bulkActionPermission="category.bulk_action"
      liveModule="categories"
      entityName="category"
      heading="Product Categories"
      subtitle={<>The top level of the category &rarr; sub-category product classification.</>}
      breadcrumbTrail={["Master Data", "Categories"]}
      newButtonLabel="+ New Category"
      hideQuickAdd
      searchPlaceholder="Search name or Sr. No..."
      columnHeaders={["Name", "Status"]}
      columns={[
        { header: "Name", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "Status", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Category Name", required: true },
        { key: "status", label: "Status" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        code: item?.code ?? "",
        name: item?.name ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        code: nullIfBlank(f.code),
        name: f.name.trim(),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <div className="form-grid">
          <TextField id="name" label="Category Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
          <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
        </div>
      )}
      detailFields={(c) => [
        { label: "Category Name", value: c.name, fullWidth: true },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}