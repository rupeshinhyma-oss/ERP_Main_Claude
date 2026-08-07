/** Product Categories master. Ported from masters-categories.html. */

import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge, dash } from "@/components/ui";
import { StatusSelectField, TextAreaField, TextField, nullIfBlank } from "@/components/fields";
import type { ProductCategory } from "@/types";

const EMPTY: FormState = { code: "", name: "", description: "", status: "active" };

export function CategoriesPage() {
  return (
    <MasterPage<ProductCategory>
      activeKey="masters-categories"
      apiBase="/masters/product-categories"
      permissionPrefix="category"
      entityName="category"
      heading="Product Categories"
      subtitle={<>The top level of the category &rarr; sub-category product classification.</>}
      breadcrumbTrail={["Master Data", "Categories"]}
      newButtonLabel="+ New Category"
      hideQuickAdd
      searchPlaceholder="Search name or code or Sr. No..."
      columnHeaders={["Name", "Code", "Description", "Status"]}
      columns={[
        { header: "Name", render: (c) => <span className="cell-primary">{c.name}</span> },
        { header: "Code", render: (c) => c.code },
        { header: "Description", render: (c) => dash(c.description) },
        { header: "Status", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "code", label: "Category Code", required: true },
        { key: "name", label: "Category Name", required: true },
        { key: "description", label: "Description" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        code: item?.code ?? "",
        name: item?.name ?? "",
        description: item?.description ?? "",
        status: item?.status ?? "active",
      })}
      toPayload={(f) => ({
        code: f.code.trim(),
        name: f.name.trim(),
        description: nullIfBlank(f.description),
        status: f.status,
      })}
      renderFields={(f, set) => (
        <>
          <div className="form-grid">
            <TextField id="code" label="Category Code *" required maxLength={50} value={f.code} onChange={(v) => set("code", v)} />
            <TextField id="name" label="Category Name *" required maxLength={150} value={f.name} onChange={(v) => set("name", v)} />
            <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
          </div>
          <TextAreaField id="description" label="Description" value={f.description} onChange={(v) => set("description", v)} />
        </>
      )}
      detailFields={(c) => [
        { label: "Category Name", value: c.name, fullWidth: true },
        { label: "Category Code", value: c.code },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
        { label: "Description", value: dash(c.description), fullWidth: true },
      ]}
    />
  );
}
