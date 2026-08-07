/**
 * Products master. Ported from masters-products.html.
 *
 * Notes on behaviour carried over:
 *  - Sub-Category options are scoped to the selected Category. The original
 *    called populateSubCategoryOptions() imperatively from the change handler
 *    and again from fillForm(); here the list derives from form.category_id.
 *  - Choosing an HSN code auto-fills Refund VAT % from that code's rate.
 *  - Packaging Unit CBM is computed live from L x W x H / 1,000,000 and the
 *    field stays read-only.
 *  - The payload sends both the `*_cm` dimension keys and the legacy bare
 *    `length`/`width`/`height` keys, and mirrors the Tally name into
 *    `product_name`, exactly as before.
 */

import { useState } from "react";
import { MasterPage, type FormState, type MasterPageHandle } from "@/components/MasterPage";
import { SideDrawer, DetailFieldGrid } from "@/components/SideDrawer";
import { StatusBadge } from "@/components/ui";
import {
  SelectField,
  StatusSelectField,
  TextAreaField,
  TextField,
  nullIfBlank,
  numOrNull,
} from "@/components/fields";
import { apiGet, apiPostMultipart } from "@/lib/api";
import { useLookup } from "@/lib/lookups";
import type {
  Brand,
  Hsn,
  Product,
  ProductCategory,
  ProductSubCategory,
  Uom,
} from "@/types";

const EMPTY: FormState = {
  product_code: "",
  product_name_tally: "",
  product_name_invoice: "",
  barcode: "",
  category_id: "",
  sub_category_id: "",
  brand_id: "",
  hsn_id: "",
  uom_id: "",
  secondary_uom_id: "",
  refund_vat_percent: "",
  license_certificate_required: "",
  conversion_factor: "",
  specification: "",
  description: "",
  packaging_quantity: "",
  packaging_net_weight: "",
  packaging_gross_weight: "",
  length_cm: "",
  width_cm: "",
  height_cm: "",
  packaging_unit_cbm: "",
  color: "",
  material: "",
  minimum_order_quantity: "",
  reorder_level: "",
  standard_cost: "",
  standard_price: "",
  is_purchasable: "true",
  is_sellable: "true",
  status: "active",
};

/** L x W x H in cm -> cubic metres, to 6dp. Blank unless all three are set. */
function computeCbm(length: string, width: string, height: string): string {
  const l = parseFloat(length) || 0;
  const w = parseFloat(width) || 0;
  const h = parseFloat(height) || 0;
  if (l > 0 && w > 0 && h > 0) {
    return ((l * w * h) / 1000000).toFixed(6);
  }
  return "";
}

export function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `http://localhost:8000${url.startsWith("/") ? "" : "/"}${url}`;
}

export function ProductsPage() {
  const categories = useLookup<ProductCategory>("/masters/product-categories", 250);
  const subCategories = useLookup<ProductSubCategory>("/masters/product-sub-categories", 500);
  const brands = useLookup<Brand>("/masters/brands", 250);
  const hsnCodes = useLookup<Hsn>("/masters/hsn", 250);
  const uoms = useLookup<Uom>("/masters/uom", 250);

  const [categoryFilter, setCategoryFilter] = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");

  const [drawerProduct, setDrawerProduct] = useState<Product | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const masterHandleRef = useState<{ current: MasterPageHandle | null }>(() => ({
    current: null,
  }))[0];

  const lookupsReady = [
    categories.loaded,
    subCategories.loaded,
    brands.loaded,
    hsnCodes.loaded,
    uoms.loaded,
  ].join("-");

  const scopedFilterSubCategories = categoryFilter
    ? subCategories.items.filter((sc) => sc.category_id === categoryFilter)
    : subCategories.items;

  const extraFilters: Record<string, string> = {};
  if (categoryFilter) extraFilters.category_id = categoryFilter;
  if (subCategoryFilter) extraFilters.sub_category_id = subCategoryFilter;
  if (brandFilter) extraFilters.brand_id = brandFilter;

  /** Fetches the product fresh and opens the detail drawer, matching openProductDetailView() in the source. */
  async function openProductDetailView(productId: string) {
    setDrawerLoading(true);
    setDrawerProduct(null);
    try {
      const { data } = await apiGet<Product>(`/masters/products/${productId}`);
      setDrawerProduct(data);
    } catch (err) {
      alert(`Failed to load product detail: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDrawerLoading(false);
    }
  }

  const masterPage = (
    <MasterPage<Product>
      activeKey="masters-products"
      apiBase="/masters/products"
      permissionPrefix="product"
      entityName="product"
      heading="Products Master"
      subtitle="Manage items, packaging weights, CBM, refund VAT, and license warnings."
      breadcrumbTrail={["Master Data", "Products"]}
      newButtonLabel="+ New Product"
      searchPlaceholder="Search code, name, or barcode or Sr. No..."
      reloadToken={lookupsReady}
      useFullPageForm={true}
      extraFilters={Object.keys(extraFilters).length ? extraFilters : undefined}
      toolbarExtras={
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: "20px", width: "100%" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "#334155" }}>Category</label>
            <select
              value={categoryFilter}
              onChange={(e) => {
                setCategoryFilter(e.target.value);
                setSubCategoryFilter("");
              }}
              style={{
                padding: "9px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e0",
                fontSize: "13.5px",
                background: "#ffffff",
                color: "#1e293b",
                width: "100%",
              }}
            >
              <option value="">All</option>
              {categories.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "#334155" }}>Sub Category</label>
            <select
              value={subCategoryFilter}
              onChange={(e) => setSubCategoryFilter(e.target.value)}
              style={{
                padding: "9px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e0",
                fontSize: "13.5px",
                background: "#ffffff",
                color: "#1e293b",
                width: "100%",
              }}
            >
              <option value="">All</option>
              {scopedFilterSubCategories.map((sc) => (
                <option key={sc.id} value={sc.id}>
                  {sc.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <label style={{ fontSize: "13px", fontWeight: 600, color: "#334155" }}>Brand</label>
            <select
              value={brandFilter}
              onChange={(e) => setBrandFilter(e.target.value)}
              style={{
                padding: "9px 12px",
                borderRadius: "6px",
                border: "1px solid #cbd5e0",
                fontSize: "13.5px",
                background: "#ffffff",
                color: "#1e293b",
                width: "100%",
              }}
            >
              <option value="">All</option>
              {brands.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      }
      /**
       * The shipped thead carried 11 middle headers for only 10 rendered cells
       * -- "Category / Sub-Cat." has no matching data cell, so every header from
       * it rightwards sits one column left of its data. Reproduced as-is; see
       * the handover notes if you'd rather it were corrected.
       */
      columnHeaders={[
        "Product Name (As Per Tally)",
        "Product Code",
        "Brand",
        "Sub Category",
        "HSN Code",
        "UOM",
        "Pack. Qty",
        "Pack. Gross Weight",
        "Pack. Unit CBM",
        "Status",
      ]}
      actionsHeader="Action"
      columns={[
        {
          header: "Product Name (Tally)",
          render: (p) => (
            <>
              <a
                href="#"
                className="cell-primary"
                style={{ color: "var(--color-primary)", fontWeight: 600 }}
                onClick={(e) => {
                  e.preventDefault();
                  openProductDetailView(p.id);
                }}
              >
                {p.product_name_tally || p.product_name}
              </a>
              {p.license_certificate_required && (
                <>
                  <br />
                  <span style={{ color: "#ef4444", fontSize: "11px", fontWeight: "bold" }}>
                    ⚠️ License Required
                  </span>
                </>
              )}
            </>
          ),
        },
        { header: "Product Code", render: (p) => p.product_code },
        {
          header: "Brand",
          render: (p) => brands.items.find((x) => x.id === p.brand_id)?.name ?? "—",
        },
        {
          header: "Sub-Category",
          render: (p) => subCategories.items.find((x) => x.id === p.sub_category_id)?.name ?? "—",
        },
        {
          header: "HSN Code",
          render: (p) => hsnCodes.items.find((x) => x.id === p.hsn_id)?.code ?? "—",
        },
        {
          header: "UOM",
          render: (p) => {
            const u = uoms.items.find((x) => x.id === p.uom_id);
            return u ? `${u.name} (${u.code})` : "—";
          },
        },
        {
          header: "Pkg Qty",
          render: (p) => (p.packaging_quantity != null ? p.packaging_quantity : "—"),
        },
        {
          header: "Gross Wt (kg)",
          render: (p) => (p.packaging_gross_weight != null ? p.packaging_gross_weight : "—"),
        },
        {
          header: "Unit CBM",
          render: (p) =>
            p.packaging_unit_cbm != null ? Number(p.packaging_unit_cbm).toFixed(6) : "—",
        },
        { header: "Status", render: (p) => <StatusBadge status={p.status} /> },
      ]}
      importHeaders={[
        { key: "product_code", label: "Product Code", required: true },
        { key: "product_name", label: "Product Name", required: true },
        { key: "barcode", label: "Barcode" },
        { key: "category_code", label: "Category Code", required: true },
        { key: "sub_category_code", label: "Sub-Category Code" },
        { key: "brand_code", label: "Brand Code" },
        { key: "hsn_code", label: "HSN Code" },
        { key: "uom_code", label: "UOM Code", required: true },
        { key: "secondary_uom_code", label: "Secondary UOM Code" },
        { key: "specification", label: "Specification" },
        { key: "description", label: "Description" },
        { key: "weight", label: "Weight (kg)" },
        { key: "length", label: "Length (cm)" },
        { key: "width", label: "Width (cm)" },
        { key: "height", label: "Height (cm)" },
        { key: "color", label: "Color" },
        { key: "material", label: "Material" },
        { key: "conversion_factor", label: "Conversion Factor" },
        { key: "minimum_order_quantity", label: "Min. Order Qty" },
        { key: "reorder_level", label: "Reorder Level" },
        { key: "standard_cost", label: "Standard Cost" },
        { key: "standard_price", label: "Standard Price" },
        { key: "is_purchasable", label: "Purchasable (true/false)" },
        { key: "is_sellable", label: "Sellable (true/false)" },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => {
        const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
        return {
          product_code: str(item?.product_code),
          product_name_tally: str(item ? item.product_name_tally || item.product_name : ""),
          product_name_invoice: str(item?.product_name_invoice),
          barcode: str(item?.barcode),
          category_id: str(item?.category_id),
          sub_category_id: str(item?.sub_category_id),
          brand_id: str(item?.brand_id),
          hsn_id: str(item?.hsn_id),
          uom_id: str(item?.uom_id),
          secondary_uom_id: str(item?.secondary_uom_id),
          refund_vat_percent: str(item?.refund_vat_percent),
          license_certificate_required: str(item?.license_certificate_required),
          conversion_factor: str(item?.conversion_factor),
          specification: str(item?.specification),
          description: str(item?.description),
          image_url: str(item ? item.image_url || (item.images && item.images[0]) : ""),
          packaging_quantity: str(item?.packaging_quantity),
          packaging_net_weight: str(item?.packaging_net_weight),
          packaging_gross_weight: str(item?.packaging_gross_weight),
          length_cm: str(item ? item.length_cm ?? item.length : ""),
          width_cm: str(item ? item.width_cm ?? item.width : ""),
          height_cm: str(item ? item.height_cm ?? item.height : ""),
          packaging_unit_cbm: str(item?.packaging_unit_cbm),
          color: str(item?.color),
          material: str(item?.material),
          minimum_order_quantity: str(item?.minimum_order_quantity),
          reorder_level: str(item?.reorder_level),
          standard_cost: str(item?.standard_cost),
          standard_price: str(item?.standard_price),
          is_purchasable: item ? String(item.is_purchasable) : "true",
          is_sellable: item ? String(item.is_sellable) : "true",
          status: item?.status ?? "active",
        };
      }}
      toPayload={(f) => {
        const l = numOrNull(f.length_cm);
        const w = numOrNull(f.width_cm);
        const h = numOrNull(f.height_cm);
        const cbm =
          l && w && h
            ? Number(((l * w * h) / 1000000).toFixed(6))
            : numOrNull(f.packaging_unit_cbm);

        if (!f.category_id) throw new Error("Please select a Category.");
        if (!f.uom_id) throw new Error("Please select a Primary UOM.");

        // A secondary UOM identical to the primary carries no information.
        let secUomId: string | null = f.secondary_uom_id || null;
        if (secUomId === f.uom_id) secUomId = null;

        const tallyName = f.product_name_tally.trim();

        return {
          product_code: f.product_code.trim(),
          product_name_tally: tallyName,
          product_name_invoice: nullIfBlank(f.product_name_invoice),
          product_name: tallyName,
          barcode: nullIfBlank(f.barcode),
          category_id: f.category_id,
          sub_category_id: f.sub_category_id || null,
          brand_id: f.brand_id || null,
          hsn_id: f.hsn_id || null,
          uom_id: f.uom_id,
          secondary_uom_id: secUomId,
          refund_vat_percent: numOrNull(f.refund_vat_percent) ?? 0,
          license_certificate_required: nullIfBlank(f.license_certificate_required),
          conversion_factor: numOrNull(f.conversion_factor),
          specification: nullIfBlank(f.specification),
          description: nullIfBlank(f.description),
          images: f.image_url ? [f.image_url] : [],
          packaging_quantity: numOrNull(f.packaging_quantity),
          packaging_net_weight: numOrNull(f.packaging_net_weight),
          packaging_gross_weight: numOrNull(f.packaging_gross_weight),
          length_cm: l,
          width_cm: w,
          height_cm: h,
          length: l,
          width: w,
          height: h,
          packaging_unit_cbm: cbm,
          color: nullIfBlank(f.color),
          material: nullIfBlank(f.material),
          minimum_order_quantity: numOrNull(f.minimum_order_quantity),
          reorder_level: numOrNull(f.reorder_level),
          standard_cost: numOrNull(f.standard_cost),
          standard_price: numOrNull(f.standard_price),
          is_purchasable: f.is_purchasable === "true",
          is_sellable: f.is_sellable === "true",
          status: f.status,
        };
      }}
      renderFields={(f, set) => {
        const scopedSubCategories = f.category_id
          ? subCategories.items.filter((sc) => sc.category_id === f.category_id)
          : subCategories.items;

        /** Dimension change also refreshes the read-only CBM preview. */
        const setDimension = (id: "length_cm" | "width_cm" | "height_cm", value: string) => {
          const next = { length_cm: f.length_cm, width_cm: f.width_cm, height_cm: f.height_cm };
          next[id] = value;
          set(id, value);
          const cbm = computeCbm(next.length_cm, next.width_cm, next.height_cm);
          if (cbm) set("packaging_unit_cbm", cbm);
        };

        return (
          <>
            <div className="section-title">Identity</div>
            <div className="form-grid">
              <TextField id="product_name_tally" label="Product Name (As per Tally) *" required maxLength={255} placeholder="Name as in Tally" value={f.product_name_tally} onChange={(v) => set("product_name_tally", v)} />
              <TextField id="product_name_invoice" label="Product Name (As per Invoice)" maxLength={255} placeholder="Name for Tax Invoices" value={f.product_name_invoice} onChange={(v) => set("product_name_invoice", v)} />
              <TextField id="product_code" label="Product Code" maxLength={50} placeholder="e.g. PRD-001" value={f.product_code} onChange={(v) => set("product_code", v)} />
            </div>

            <div className="section-title">Classification &amp; Tax</div>
            <div className="form-grid">
              <SelectField
                id="category_id"
                label="Category *"
                required
                value={f.category_id}
                onChange={(v) => {
                  set("category_id", v);
                  set("sub_category_id", "");
                }}
              >
                <option value="">-- Select Category --</option>
                {categories.items.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </SelectField>
              <SelectField id="sub_category_id" label="Sub-Category *" value={f.sub_category_id} onChange={(v) => set("sub_category_id", v)}>
                <option value="">-- Select Sub-Category --</option>
                {scopedSubCategories.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.name}
                  </option>
                ))}
              </SelectField>
              <SelectField id="brand_id" label="Brand *" value={f.brand_id} onChange={(v) => set("brand_id", v)}>
                <option value="">-- Select Brand --</option>
                {brands.items.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </SelectField>
              <SelectField
                id="hsn_id"
                label="HSN Code *"
                value={f.hsn_id}
                onChange={(v) => {
                  set("hsn_id", v);
                  // Selecting an HSN code auto-fills its refund VAT rate.
                  const picked = hsnCodes.items.find((h) => h.id === v);
                  set("refund_vat_percent", String(picked?.refund_vat_percent ?? 0));
                }}
              >
                <option value="">-- Select HSN Code --</option>
                {hsnCodes.items.map((h) => (
                  <option key={h.id} value={h.id}>
                    {`${h.code} - ${h.description || ""} (Refund VAT: ${h.refund_vat_percent || 0}%)`}
                  </option>
                ))}
              </SelectField>
              <TextField id="refund_vat_percent" label="Refund VAT %" type="number" step="0.01" min={0} max={100} placeholder="Auto from HSN or manual" value={f.refund_vat_percent} onChange={(v) => set("refund_vat_percent", v)} />
              <SelectField id="uom_id" label="UOM (Unit of Measure) *" required value={f.uom_id} onChange={(v) => set("uom_id", v)}>
                <option value="">-- Select UOM --</option>
                {uoms.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {`${u.name} (${u.code})`}
                  </option>
                ))}
              </SelectField>
            </div>

            <div className="section-title">Compliance &amp; License Requirements</div>
            <div className="form-grid">
              <TextAreaField
                id="license_certificate_required"
                label="Any License / Certificate (if needed)"
                rows={2}
                placeholder="e.g. Import License, Drug Certificate. Highlighted RED in Inquiry if set."
                value={f.license_certificate_required}
                onChange={(v) => set("license_certificate_required", v)}
                style={{ gridColumn: "span 2" }}
              />
            </div>

            <div className="section-title">Specifications</div>
            <div className="form-grid">
              <TextAreaField id="specification" label="Specification" value={f.specification} onChange={(v) => set("specification", v)} style={{ gridColumn: "span 2" }} />
            </div>

            <div className="section-title">Packaging &amp; Physical Attributes</div>
            <div className="form-grid">
              <TextField id="packaging_quantity" label="Packaging Quantity (unit)" type="number" step="0.001" min={0} value={f.packaging_quantity} onChange={(v) => set("packaging_quantity", v)} />
              <TextField id="packaging_net_weight" label="Packaging Net Weight (kg)" type="number" step="0.001" min={0} value={f.packaging_net_weight} onChange={(v) => set("packaging_net_weight", v)} />
              <TextField id="packaging_gross_weight" label="Packaging Gross Weight (kg)" type="number" step="0.001" min={0} value={f.packaging_gross_weight} onChange={(v) => set("packaging_gross_weight", v)} />
              <TextField id="length_cm" label="Length (cm)" type="number" step="0.001" min={0} className="cbm-calc" value={f.length_cm} onChange={(v) => setDimension("length_cm", v)} />
              <TextField id="width_cm" label="Width (cm)" type="number" step="0.001" min={0} className="cbm-calc" value={f.width_cm} onChange={(v) => setDimension("width_cm", v)} />
              <TextField id="height_cm" label="Height (cm)" type="number" step="0.001" min={0} className="cbm-calc" value={f.height_cm} onChange={(v) => setDimension("height_cm", v)} />
              <TextField
                id="packaging_unit_cbm"
                label="Packaging Unit CBM (auto)"
                type="number"
                step="0.000001"
                readOnly
                inputStyle={{ backgroundColor: "var(--color-surface-hover)" }}
                placeholder="Auto-calculated (L*W*H / 1,000,000)"
                value={f.packaging_unit_cbm}
                onChange={(v) => set("packaging_unit_cbm", v)}
              />
            </div>

            <div className="section-title">Image Of Product</div>
            <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <label style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                  Product Image (Photo)
                </label>
                <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
                  <div
                    style={{
                      width: "110px",
                      height: "110px",
                      borderRadius: "8px",
                      border: "2px dashed #cbd5e0",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "#f8fafc",
                      overflow: "hidden",
                    }}
                  >
                    {f.image_url ? (
                      <img src={resolveImageUrl(f.image_url)} alt="Product Preview" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <div style={{ textAlign: "center", color: "#94a3b8" }}>
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <polyline points="21 15 16 10 5 21" />
                        </svg>
                        <div style={{ fontSize: "11px", marginTop: "4px" }}>No Image</div>
                      </div>
                    )}
                  </div>

                  <div>
                    <input
                      type="file"
                      accept="image/*"
                      id="product_image_file"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          // Instant on-screen preview
                          const reader = new FileReader();
                          reader.onload = (uploadEvent) => {
                            const base64Data = uploadEvent.target?.result as string;
                            if (base64Data) set("image_url", base64Data);
                          };
                          reader.readAsDataURL(file);

                          // Upload to Supabase Storage in background
                          const formData = new FormData();
                          formData.append("file", file);
                          apiPostMultipart<{ url: string }>("/masters/products/upload-image", formData)
                            .then((res) => {
                              if (res.data?.url) set("image_url", res.data.url);
                            })
                            .catch((err) => {
                              console.warn("Background upload to Supabase fell back to local preview:", err);
                            });
                        }
                      }}
                    />
                    <label
                      htmlFor="product_image_file"
                      className="btn btn-secondary"
                      style={{ padding: "8px 16px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      📁 Select Image
                    </label>
                    {f.image_url && (
                      <button
                        type="button"
                        className="btn"
                        style={{ marginLeft: "8px", background: "#ef4444", color: "#ffffff", padding: "8px 12px" }}
                        onClick={() => set("image_url", "")}
                      >
                        Remove
                      </button>
                    )}
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "6px" }}>
                      Upload PNG, JPG, or WEBP photo of the product.
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="section-title">Status</div>
            <div className="form-grid">
              <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
            </div>
          </>
        );
      }}
      onReady={(handle) => {
        masterHandleRef.current = handle;
      }}
    />
  );

  // Resolve display names for the drawer's related-entity fields the same
  // way the row columns do (in-memory lookups already loaded for the table).
  const p = drawerProduct;
  const cat = p ? categories.items.find((c) => c.id === p.category_id) : undefined;
  const subCat = p ? subCategories.items.find((sc) => sc.id === p.sub_category_id) : undefined;
  const brand = p ? brands.items.find((b) => b.id === p.brand_id) : undefined;
  const hsn = p ? hsnCodes.items.find((h) => h.id === p.hsn_id) : undefined;
  const uom = p ? uoms.items.find((u) => u.id === p.uom_id) : undefined;

  const length = p ? p.length_cm ?? p.length : null;
  const width = p ? p.width_cm ?? p.width : null;
  const height = p ? p.height_cm ?? p.height : null;
  const hasDimensions = Boolean(length || width || height);
  const hasSpecSection = Boolean(p?.description || p?.specification || p?.image_url);

  return (
    <>
      {masterPage}

      <SideDrawer
        open={drawerLoading || Boolean(drawerProduct)}
        title={
          p ? `Product Detail #${p.product_code || p.id.slice(0, 6)}` : "Product Detail"
        }
        subtitle={p ? p.product_name_tally || p.product_name || "" : ""}
        editLabel="✏️ Edit Product"
        onClose={() => setDrawerProduct(null)}
        onEdit={() => {
          const id = p?.id;
          setDrawerProduct(null);
          if (id) masterHandleRef.current?.openEdit(id);
        }}
      >
        {drawerLoading || !p ? (
          <div className="muted" style={{ textAlign: "center", padding: "40px" }}>
            Loading product details...
          </div>
        ) : (
          <>
            {(p.image_url || (p.images && p.images.length > 0)) && (
              <div style={{ marginBottom: "20px", textAlign: "center", background: "#f8fafc", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                <img
                  src={resolveImageUrl(p.image_url || p.images?.[0])}
                  alt="Product Photo"
                  style={{
                    maxHeight: "220px",
                    maxWidth: "100%",
                    borderRadius: "8px",
                    objectFit: "contain",
                    boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                  }}
                />
              </div>
            )}
            <DetailFieldGrid
              fields={[
                {
                  label: "Product Name (As Per Tally)",
                  value: p.product_name_tally || p.product_name || "—",
                  fullWidth: true,
                },
                { label: "Brand", value: brand ? brand.name : "—" },
                { label: "Category", value: cat ? cat.name : "—" },
                { label: "Sub Category", value: subCat ? subCat.name : "—" },
                { label: "HSN Code", value: hsn ? hsn.code : "—" },
                {
                  label: "Refund VAT % / GST %",
                  value: (
                    <span style={{ color: "#16a34a" }}>
                      {p.refund_vat_percent != null ? `${p.refund_vat_percent}%` : "0%"}
                    </span>
                  ),
                },
                { label: "UOM", value: uom ? `${uom.name} (${uom.code})` : "—" },
                {
                  label: "Packaging Quantity",
                  value: p.packaging_quantity != null ? p.packaging_quantity : "—",
                },
              ]}
            />

            <div>
              <DetailFieldGrid
                fields={[
                  {
                    label: "Product Name (As Per Invoice)",
                    value: p.product_name_invoice || "—",
                    fullWidth: true,
                  },
                  {
                    label: "Pkg Net Wt (kg)",
                    value: p.packaging_net_weight != null ? p.packaging_net_weight : "—",
                  },
                  {
                    label: "Pkg Gross Wt (kg)",
                    value: p.packaging_gross_weight != null ? p.packaging_gross_weight : "—",
                  },
                  {
                    label: "Dimensions (L x W x H cm)",
                    value: hasDimensions ? `${length || 0} x ${width || 0} x ${height || 0} cm` : "—",
                  },
                  {
                    label: "Packaging Unit CBM",
                    value: (
                      <span style={{ color: "var(--color-primary)" }}>
                        {p.packaging_unit_cbm != null
                          ? Number(p.packaging_unit_cbm).toFixed(6)
                          : "—"}
                      </span>
                    ),
                  },
                ]}
              />
              {p.license_certificate_required && (
                <div
                  style={{
                    marginTop: "16px",
                    padding: "12px 14px",
                    background: "#fff1f2",
                    border: "1px solid #fecdd3",
                    borderRadius: "6px",
                    color: "#9f1239",
                    fontSize: "13px",
                  }}
                >
                  <strong style={{ display: "block", marginBottom: "2px" }}>
                    ⚠️ Required License / Certificate:
                  </strong>
                  <span>{p.license_certificate_required}</span>
                </div>
              )}
            </div>

            {hasSpecSection && (
              <div
                style={{
                  background: "#f8fafc",
                  border: "1px solid #e2e8f0",
                  borderRadius: "8px",
                  padding: "20px",
                }}
              >
                <span
                  style={{
                    fontSize: "12px",
                    fontWeight: 600,
                    color: "#64748b",
                    display: "block",
                    marginBottom: "6px",
                  }}
                >
                  Specifications &amp; Attachments
                </span>
                {p.specification && (
                  <p style={{ margin: "0 0 8px", fontSize: "13px", color: "#0f172a" }}>
                    <strong>Spec:</strong> {p.specification}
                  </p>
                )}
                {p.description && (
                  <p style={{ margin: 0, fontSize: "13px", color: "#0f172a" }}>
                    <strong>Desc:</strong> {p.description}
                  </p>
                )}
                {p.image_url && (
                  <img
                    src={p.image_url}
                    alt={p.product_name_tally || p.product_name || "Product"}
                    style={{
                      maxWidth: "180px",
                      borderRadius: "6px",
                      marginTop: "10px",
                      border: "1px solid #cbd5e1",
                    }}
                  />
                )}
              </div>
            )}
          </>
        )}
      </SideDrawer>
    </>
  );
}
