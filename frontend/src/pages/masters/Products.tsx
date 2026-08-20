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
  MultiSelectField,
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
  organization_id: "",
  organization_ids_json: "[]",
  branch_ids_json: "[]",
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
  images_json: "[]",
  image_url: "",
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
  let clean = url.trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith("'") && clean.endsWith("'"))) {
    clean = clean.slice(1, -1).trim();
  }
  if (!clean) return "";
  if (clean.startsWith("data:") || clean.startsWith("http://") || clean.startsWith("https://")) {
    return encodeURI(clean);
  }
  const fullUrl = `http://localhost:8000${clean.startsWith("/") ? "" : "/"}${clean}`;
  return encodeURI(fullUrl);
}

function BranchPopoverCell({ branches }: { branches: string[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!branches.length) return <span style={{ color: "#94a3b8" }}>—</span>;

  if (branches.length === 1) {
    return (
      <span className="cell-truncate" title={branches[0]} style={{ maxWidth: "160px", color: "#1e293b", fontSize: "13px" }}>
        🏢 {branches[0]}
      </span>
    );
  }

  return (
    <div
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span className="cell-truncate" title={branches[0]} style={{ maxWidth: "120px", color: "#1e293b", fontSize: "13px" }}>
          🏢 {branches[0]}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen((prev) => !prev);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "2px 7px",
            fontSize: "11px",
            fontWeight: 600,
            color: "#2563eb",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            borderRadius: "12px",
            cursor: "pointer",
            lineHeight: 1.2,
            transition: "all 0.15s ease",
            boxShadow: "0 1px 2px rgba(37,99,235,0.08)",
          }}
          title="Click or hover to view all branches"
        >
          👁️ +{branches.length - 1}
        </button>
      </div>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: "8px",
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 12px 28px -4px rgba(0, 0, 0, 0.18), 0 8px 12px -6px rgba(0, 0, 0, 0.1)",
            padding: "10px 12px",
            minWidth: "230px",
            maxWidth: "340px",
            maxHeight: "240px",
            overflowY: "auto",
            zIndex: 99999,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", marginBottom: "6px", borderBottom: "1px solid #f1f5f9", paddingBottom: "4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>📍 Assigned Branches ({branches.length})</span>
            <span style={{ fontSize: "11px", color: "#2563eb", fontWeight: 600 }}>👁️ View</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {branches.map((b, i) => (
              <div
                key={i}
                style={{
                  fontSize: "12px",
                  color: "#1e293b",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  background: "#f8fafc",
                }}
              >
                <span style={{ color: "#3b82f6", fontSize: "12px" }}>🏢</span>
                <span>{b}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OrgPopoverCell({ orgNames }: { orgNames: string[] }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!orgNames.length) return <span style={{ color: "#94a3b8" }}>—</span>;

  if (orgNames.length === 1) {
    return (
      <span className="cell-truncate" title={orgNames[0]} style={{ maxWidth: "160px", color: "#1e293b", fontSize: "13px" }}>
        {orgNames[0]}
      </span>
    );
  }

  return (
    <div
      style={{ position: "relative", display: "inline-flex", alignItems: "center" }}
      onMouseEnter={() => setIsOpen(true)}
      onMouseLeave={() => setIsOpen(false)}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
        <span className="cell-truncate" title={orgNames[0]} style={{ maxWidth: "120px", color: "#1e293b", fontSize: "13px" }}>
          {orgNames[0]}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsOpen((prev) => !prev);
          }}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "3px",
            padding: "2px 7px",
            fontSize: "11px",
            fontWeight: 600,
            color: "#059669",
            background: "#ecfdf5",
            border: "1px solid #a7f3d0",
            borderRadius: "12px",
            cursor: "pointer",
            lineHeight: 1.2,
            transition: "all 0.15s ease",
            boxShadow: "0 1px 2px rgba(5,150,105,0.08)",
          }}
          title="Click or hover to view all organizations"
        >
          👁️ +{orgNames.length - 1}
        </button>
      </div>

      {isOpen && (
        <div
          style={{
            position: "absolute",
            bottom: "100%",
            left: 0,
            marginBottom: "8px",
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 12px 28px -4px rgba(0, 0, 0, 0.18), 0 8px 12px -6px rgba(0, 0, 0, 0.1)",
            padding: "10px 12px",
            minWidth: "210px",
            maxWidth: "320px",
            maxHeight: "240px",
            overflowY: "auto",
            zIndex: 99999,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div style={{ fontSize: "11.5px", fontWeight: 700, color: "#475569", marginBottom: "6px", borderBottom: "1px solid #f1f5f9", paddingBottom: "4px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>🏢 Organizations ({orgNames.length})</span>
            <span style={{ fontSize: "11px", color: "#059669", fontWeight: 600 }}>👁️ View</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "5px" }}>
            {orgNames.map((name, i) => (
              <div
                key={i}
                style={{
                  fontSize: "12px",
                  color: "#1e293b",
                  fontWeight: 500,
                  display: "flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "4px 8px",
                  borderRadius: "4px",
                  background: "#f8fafc",
                }}
              >
                <span style={{ color: "#10b981", fontSize: "12px" }}>🏢</span>
                <span>{name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProductsPage() {
  const categories = useLookup<ProductCategory>("/masters/product-categories", 250, true);
  const subCategories = useLookup<ProductSubCategory>("/masters/product-sub-categories", 500, true);
  const brands = useLookup<Brand>("/masters/brands", 250, true);
  const hsnCodes = useLookup<Hsn>("/masters/hsn", 250, true);
  const uoms = useLookup<Uom>("/masters/uom", 250, true);
  const organizations = useLookup<{ id: string; name: string }>("/masters/company-list", 250, true);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);


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
    organizations.loaded,
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
      exportPermission="product.export"
      bulkActionPermission="product.bulk_action"
      liveModule="inventory"
      entityName="product"
      clientSideSearch={true}
      customSearchMatcher={(p: Product, term: string, cleanTerm: string) => {
        const brand = brands.items.find((x) => x.id === p.brand_id);
        const cat = categories.items.find((x) => x.id === p.category_id);
        const subCat = subCategories.items.find((x) => x.id === p.sub_category_id);
        const hsn = hsnCodes.items.find((x) => x.id === p.hsn_id);
        const uom = uoms.items.find((x) => x.id === p.uom_id);

        const orgIds = p.organization_ids && p.organization_ids.length > 0
          ? p.organization_ids
          : (p.organization_id ? [p.organization_id] : []);
        const orgNames = orgIds
          .map((id: string) => organizations.items.find((x) => x.id === id)?.name)
          .filter(Boolean);

        const searchBlob = [
          p.product_name,
          p.product_name_tally,
          p.product_name_invoice,
          p.product_code,
          p.barcode,
          p.description,
          p.specification,
          p.material,
          p.color,
          brand?.name,
          brand?.code,
          cat?.name,
          cat?.code,
          subCat?.name,
          subCat?.code,
          hsn?.code,
          hsn?.description,
          uom?.name,
          uom?.code,
          uom?.short_name,
          ...orgNames,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return (
          searchBlob.includes(term) ||
          searchBlob.replace(/[\s-]/g, "").includes(cleanTerm)
        );
      }}
      heading="Products Master"
      subtitle="Manage items, packaging weights, CBM, refund VAT, and license warnings."
      breadcrumbTrail={["Master Data", "Products"]}
      newButtonLabel="+ New Product"
      searchPlaceholder="Search code, name, or barcode or Sr. No..."
      reloadToken={lookupsReady}
      onItemsLoaded={setCatalogProducts}
      useFullPageForm={true}
      hideQuickAdd={true}
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
        "Organization",
        "Branches",
        "Pack. Qty",
        "Pack. Gross Weight",
        "Pack. Unit CBM",
        "Status",
      ]}
      actionsHeader="Action"
      columns={[
        {
          header: "Product Name (Tally)",
          render: (p) => {
            const name = p.product_name_tally || p.product_name || "—";
            return (
              <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", maxWidth: "340px", minWidth: "240px" }}>
                <a
                  href="#"
                  className="cell-primary"
                  title={name}
                  style={{ color: "var(--color-primary)", fontWeight: 600, maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  onClick={(e) => {
                    e.preventDefault();
                    openProductDetailView(p.id);
                  }}
                >
                  {name}
                </a>
                {p.license_certificate_required && (
                  <span title="License Required" style={{ color: "#ef4444", fontSize: "11px", fontWeight: "bold", flexShrink: 0 }}>
                    ⚠️
                  </span>
                )}
              </div>
            );
          },
        },
        {
          header: "Product Code",
          render: (p) => (
            <span title={p.product_code || ""} style={{ fontWeight: 500, fontFamily: "monospace", fontSize: "13px" }}>
              {p.product_code || "—"}
            </span>
          ),
        },
        {
          header: "Brand",
          render: (p) => {
            const b = brands.items.find((x) => x.id === p.brand_id);
            const name = b ? `${b.name}${b.status === "inactive" ? " (Inactive)" : ""}` : "—";
            return (
              <span className="cell-truncate" title={name} style={{ maxWidth: "130px" }}>
                {name}
              </span>
            );
          },
        },
        {
          header: "Sub-Category",
          render: (p) => {
            const sc = subCategories.items.find((x) => x.id === p.sub_category_id);
            const name = sc ? `${sc.name}${sc.status === "inactive" ? " (Inactive)" : ""}` : "—";
            return (
              <span className="cell-truncate" title={name} style={{ maxWidth: "180px", color: "#334155" }}>
                {name}
              </span>
            );
          },
        },
        {
          header: "HSN Code",
          render: (p) => {
            const code = hsnCodes.items.find((x) => x.id === p.hsn_id)?.code ?? "—";
            return (
              <span title={code} style={{ fontFamily: "monospace", fontSize: "12.5px" }}>
                {code}
              </span>
            );
          },
        },
        {
          header: "UOM",
          render: (p) => {
            const u = uoms.items.find((x) => x.id === p.uom_id);
            const label = u ? `${u.name} (${u.code})` : "—";
            return <span title={label}>{u ? u.code : "—"}</span>;
          },
        },
        {
          header: "Organization",
          render: (p) => {
            const orgIds = p.organization_ids && p.organization_ids.length > 0
              ? p.organization_ids
              : (p.organization_id ? [p.organization_id] : []);
            if (!orgIds.length) return <span style={{ color: "#94a3b8" }}>—</span>;
            const names = orgIds
              .map((id) => organizations.items.find((x) => x.id === id)?.name)
              .filter(Boolean) as string[];
            return <OrgPopoverCell orgNames={names} />;
          },
        },
        {
          header: "Branches",
          render: (p) => {
            const branchIds = p.branch_ids || [];
            if (!branchIds.length) return <span style={{ color: "#94a3b8" }}>—</span>;
            const allBranches = organizations.items.flatMap((org: any) => org.branches || []);
            const matchingBranches = branchIds
              .map((bId) => {
                const found = allBranches.find((b: any) => b.id === bId || `${bId}`.endsWith(b.name));
                return found ? `${found.name}${found.code_prefix ? ` (${found.code_prefix})` : ""}` : null;
              })
              .filter(Boolean) as string[];

            return <BranchPopoverCell branches={matchingBranches} />;
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
        { key: "Product Name (As Per Tally)", label: "Product Name (As Per Tally)", required: true },
        { key: "Product Code", label: "Product Code" },
        { key: "Brand", label: "Brand" },
        { key: "Category", label: "Category", required: true },
        { key: "Sub Category", label: "Sub Category" },
        { key: "HSN Code", label: "HSN Code" },
        { key: "UOM", label: "UOM", required: true },
        { key: "Pack. Qty", label: "Packaging Quantity" },
        { key: "Pack. Net Weight", label: "Packaging Net Weight (kg)" },
        { key: "Pack. Gross Weight", label: "Packaging Gross Weight (kg)" },
        { key: "Length (cm)", label: "Length (cm)" },
        { key: "Width (cm)", label: "Width (cm)" },
        { key: "Height (cm)", label: "Height (cm)" },
        { key: "Pack. Unit CBM", label: "Packaging Unit CBM" },
        { key: "Refund VAT %", label: "Refund VAT %" },
        { key: "Compliance & License Requirements", label: "Compliance & License Requirements" },
        { key: "Specification", label: "Specification" },
        { key: "Status", label: "Status (active/inactive)" },
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
          organization_id: str(item?.organization_id),
          organization_ids_json: JSON.stringify(
            item
              ? (item.organization_ids && item.organization_ids.length > 0
                ? item.organization_ids
                : (item.organization_id ? [item.organization_id] : []))
              : []
          ),
          branch_ids_json: JSON.stringify(item?.branch_ids || []),
          refund_vat_percent: str(item?.refund_vat_percent),
          license_certificate_required: str(item?.license_certificate_required),
          conversion_factor: str(item?.conversion_factor),
          specification: str(item?.specification),
          description: str(item?.description),
          images_json: JSON.stringify(item ? (Array.isArray(item.images) && item.images.length > 0 ? item.images : (item.image_url ? [item.image_url] : [])) : []),
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
          _editing_id: item?.id ?? "",
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
        if (!f.sub_category_id) throw new Error("Please select a Sub-Category.");
        if (!f.hsn_id) throw new Error("Please select a HSN Code.");
        if (!f.uom_id) throw new Error("Please select a Primary UOM.");
        if (numOrNull(f.packaging_quantity) === null) throw new Error("Packaging Quantity (unit) is required.");

        // A secondary UOM identical to the primary carries no information.
        let secUomId: string | null = f.secondary_uom_id || null;
        if (secUomId === f.uom_id) secUomId = null;

        const tallyName = f.product_name_tally.trim();
        if (!tallyName) throw new Error("Product Name (As per Tally) is required.");

        const cleanTally = tallyName.toLowerCase().replace(/[\s-]/g, "");
        const duplicate = catalogProducts.find((p) => {
          const pName = (p.product_name_tally || p.product_name || "").toLowerCase().replace(/[\s-]/g, "");
          return pName === cleanTally;
        });

        if (duplicate && (!f._editing_id || duplicate.id !== f._editing_id)) {
          throw new Error(`Product "${tallyName}" already exists in Product Master! Duplicate products are not allowed.`);
        }

        const codeClean = (f.product_code || "").trim().toLowerCase();
        if (codeClean) {
          const duplicateCode = catalogProducts.find((p) => {
            const pCode = (p.product_code || "").trim().toLowerCase();
            return pCode === codeClean;
          });
          if (duplicateCode && (!f._editing_id || duplicateCode.id !== f._editing_id)) {
            throw new Error(`Product Code "${f.product_code}" already exists in Product Master (used by "${duplicateCode.product_name_tally || duplicateCode.product_name}")! Duplicate Product Code is not allowed.`);
          }
        }

        return {
          product_code: nullIfBlank(f.product_code),
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

          organization_id: (() => {
            try {
              const list = JSON.parse(f.organization_ids_json || "[]");
              return list[0] || null;
            } catch {
              return f.organization_id || null;
            }
          })(),
          organization_ids: (() => {
            try { return JSON.parse(f.organization_ids_json || "[]"); }
            catch { return []; }
          })(),
          branch_ids: (() => {
            try { return JSON.parse(f.branch_ids_json || "[]"); }
            catch { return []; }
          })(),
          refund_vat_percent: numOrNull(f.refund_vat_percent) ?? 0,
          license_certificate_required: nullIfBlank(f.license_certificate_required),
          conversion_factor: numOrNull(f.conversion_factor),
          specification: nullIfBlank(f.specification),
          description: nullIfBlank(f.description),
          images: (() => {
            try { return JSON.parse(f.images_json || "[]"); }
            catch { return f.image_url ? [f.image_url] : []; }
          })(),
          image_url: nullIfBlank(f.image_url),
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
          ? subCategories.items.filter((sc) => sc.category_id === f.category_id && (sc.status === "active" || sc.id === f.sub_category_id))
          : subCategories.items.filter((sc) => sc.status === "active" || sc.id === f.sub_category_id);

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
              <div style={{ position: "relative" }}>
                <TextField
                  id="product_name_tally"
                  label="Product Name (As per Tally) *"
                  required
                  maxLength={255}
                  placeholder="Name as in Tally"
                  value={f.product_name_tally}
                  onChange={(v) => set("product_name_tally", v)}
                />
                {(() => {
                  const cleanTyped = (f.product_name_tally || "").trim().toLowerCase().replace(/[\s-]/g, "");
                  if (!cleanTyped) return null;
                  const matches = catalogProducts.filter((p) => {
                    if (f._editing_id && p.id === f._editing_id) return false;
                    const pName = (p.product_name_tally || p.product_name || "").toLowerCase().replace(/[\s-]/g, "");
                    const pCode = (p.product_code || "").toLowerCase().replace(/[\s-]/g, "");
                    return pName.includes(cleanTyped) || pCode.includes(cleanTyped);
                  }).slice(0, 5);
                  const exact = catalogProducts.find((p) => {
                    if (f._editing_id && p.id === f._editing_id) return false;
                    const pName = (p.product_name_tally || p.product_name || "").toLowerCase().replace(/[\s-]/g, "");
                    const pCode = (p.product_code || "").toLowerCase().replace(/[\s-]/g, "");
                    return pName === cleanTyped || pCode === cleanTyped;
                  });

                  if (matches.length === 0) return null;

                  return (
                    <>
                      {exact && (
                        <div style={{ marginTop: "4px", fontSize: "12px", color: "#dc2626", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
                          <span>⚠️</span> Product Name "{exact.product_name_tally || exact.product_name}" already exists!
                        </div>
                      )}
                      {!exact && matches.length > 0 && (
                        <div
                          style={{
                            position: "absolute",
                            top: "calc(100% + 2px)",
                            left: 0,
                            right: 0,
                            zIndex: 100,
                            background: "#ffffff",
                            border: "1px solid #cbd5e1",
                            borderRadius: "6px",
                            boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
                            maxHeight: "150px",
                            overflowY: "auto",
                            padding: "4px",
                          }}
                        >
                          <div style={{ fontSize: "11px", fontWeight: 700, color: "#64748b", padding: "4px 8px", borderBottom: "1px solid #f1f5f9" }}>
                            Similar Products ({matches.length})
                          </div>
                          {matches.map((p) => (
                            <div
                              key={p.id}
                              style={{
                                padding: "6px 8px",
                                fontSize: "12.5px",
                                cursor: "pointer",
                                borderRadius: "4px",
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                              onClick={() => {
                                set("product_name_tally", p.product_name_tally || p.product_name || "");
                              }}
                            >
                              <span style={{ fontWeight: 600, color: "#1e293b" }}>{p.product_name_tally || p.product_name}</span>
                              <span style={{ color: "#64748b", fontSize: "11.5px" }}>Code: {p.product_code || "—"}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
              <TextField id="product_name_invoice" label="Product Name (As per Invoice)" maxLength={255} placeholder="Name for Tax Invoices" value={f.product_name_invoice} onChange={(v) => set("product_name_invoice", v)} />
              <div style={{ position: "relative" }}>
                <TextField id="product_code" label="Product Code" maxLength={50} placeholder="e.g. PRD-001" value={f.product_code} onChange={(v) => set("product_code", v)} />
                {(() => {
                  const cleanCode = (f.product_code || "").trim().toLowerCase();
                  if (!cleanCode) return null;
                  const exactCode = catalogProducts.find((p) => {
                    if (f._editing_id && p.id === f._editing_id) return false;
                    return (p.product_code || "").trim().toLowerCase() === cleanCode;
                  });
                  if (exactCode) {
                    return (
                      <div style={{ marginTop: "4px", fontSize: "12px", color: "#dc2626", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
                        <span>⚠️</span> Product Code "{exactCode.product_code}" already exists (used by "{exactCode.product_name_tally || exactCode.product_name}")!
                      </div>
                    );
                  }
                  return null;
                })()}
              </div>
            </div>

            <div className="section-title">Classification &amp; Tax</div>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {/* Row 2: Brand, Category, Sub-Category */}
              <SelectField id="brand_id" label="Brand" value={f.brand_id} onChange={(v) => set("brand_id", v)}>
                <option value="">-- Select Brand --</option>
                {brands.items
                  .filter((b) => b.status === "active" || b.id === f.brand_id)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}{b.status === "inactive" ? " (Inactive)" : ""}
                    </option>
                  ))}
              </SelectField>
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
                {categories.items
                  .filter((c) => c.status === "active" || c.id === f.category_id)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}{c.status === "inactive" ? " (Inactive)" : ""}
                    </option>
                  ))}
              </SelectField>
              <SelectField id="sub_category_id" label="Sub-Category *" value={f.sub_category_id} onChange={(v) => set("sub_category_id", v)}>
                <option value="">-- Select Sub-Category --</option>
                {scopedSubCategories.map((sc) => (
                  <option key={sc.id} value={sc.id}>
                    {sc.name}{sc.status === "inactive" ? " (Inactive)" : ""}
                  </option>
                ))}
              </SelectField>

              {/* Row 3: HSN Code, Refund VAT %, Organization, UOM */}
              <SelectField
                id="hsn_id"
                label="HSN Code *"
                value={f.hsn_id}
                onChange={(v) => {
                  set("hsn_id", v);
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
              <MultiSelectField
                id="organization_ids_json"
                label="Organization"
                placeholder="-- Select Organizations --"
                values={(() => {
                  try { return JSON.parse(f.organization_ids_json || "[]"); }
                  catch { return []; }
                })()}
                options={organizations.items.map((org) => ({ id: org.id, name: org.name }))}
                onChange={(newVals) => {
                  set("organization_ids_json", JSON.stringify(newVals));
                  set("organization_id", newVals[0] || "");

                  // Automatically check / pre-select all branches belonging to the selected organization(s)
                  const selectedOrgs = organizations.items.filter((org) => newVals.includes(org.id));
                  const autoBranchIds: string[] = selectedOrgs.flatMap((org) => {
                    const branches: any[] = (org as any).branches || [];
                    return branches.map((b: any) => b.id || `${org.id}_${b.name}`);
                  });
                  set("branch_ids_json", JSON.stringify(autoBranchIds));
                }}
              />

              {/* Dependent Branch Selection */}
              {(() => {
                const selectedOrgIds: string[] = (() => {
                  try { return JSON.parse(f.organization_ids_json || "[]"); }
                  catch { return []; }
                })();
                const selectedOrgs = organizations.items.filter((org) => selectedOrgIds.includes(org.id));
                const availableBranchOptions: { id: string; name: string }[] = selectedOrgs.flatMap((org) => {
                  const branches: any[] = (org as any).branches || [];
                  return branches.map((b: any) => ({
                    id: b.id || `${org.id}_${b.name}`,
                    name: `${org.name} — ${b.name}${b.code_prefix ? ` (${b.code_prefix})` : ""}`,
                  }));
                });

                return (
                  <MultiSelectField
                    id="branch_ids_json"
                    label="Branches / Operating Locations"
                    placeholder={availableBranchOptions.length > 0 ? "-- Select Branches --" : "-- Select Organization First --"}
                    values={(() => {
                      try { return JSON.parse(f.branch_ids_json || "[]"); }
                      catch { return []; }
                    })()}
                    options={availableBranchOptions}
                    onChange={(newVals) => set("branch_ids_json", JSON.stringify(newVals))}
                  />
                );
              })()}
            </div>

            <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: "20px" }}>
              <div>
                <div className="section-title" style={{ marginTop: 0 }}>Compliance &amp; License Requirements</div>
                <TextAreaField
                  id="license_certificate_required"
                  label="Any License / Certificate (if needed)"
                  rows={3}
                  placeholder="e.g. Import License, Drug Certificate. Highlighted RED in Inquiry if set."
                  value={f.license_certificate_required}
                  onChange={(v) => set("license_certificate_required", v)}
                />
              </div>
              <div>
                <div className="section-title" style={{ marginTop: 0 }}>Specifications</div>
                <TextAreaField
                  id="specification"
                  label="Specification"
                  rows={3}
                  placeholder="Enter detailed product specifications..."
                  value={f.specification}
                  onChange={(v) => set("specification", v)}
                />
              </div>
            </div>

            <div className="section-title">Packaging &amp; Physical Attributes</div>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              <SelectField id="uom_id" label="UOM (Unit of Measure) *" required value={f.uom_id} onChange={(v) => set("uom_id", v)}>
                <option value="">-- Select UOM --</option>
                {uoms.items.map((u) => (
                  <option key={u.id} value={u.id}>
                    {`${u.name} (${u.code})`}
                  </option>
                ))}
              </SelectField>
              <TextField id="packaging_quantity" label="Packaging Quantity (unit) *" required type="number" step="0.001" min={0} value={f.packaging_quantity} onChange={(v) => set("packaging_quantity", v)} />
              <TextField id="packaging_net_weight" label="Packaging Net Weight (kg)" type="number" step="0.001" min={0} value={f.packaging_net_weight} onChange={(v) => set("packaging_net_weight", v)} />
              <TextField id="packaging_gross_weight" label="Packaging Gross Weight (kg)" type="number" step="0.001" min={0} value={f.packaging_gross_weight} onChange={(v) => set("packaging_gross_weight", v)} />
            </div>


            <div className="section-title" style={{ marginTop: "16px" }}>Dimensions For CBM</div>
            <div className="form-grid" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
              <TextField id="length_cm" label="Length (cm)" type="number" step="0.001" min={0} className="cbm-calc" value={f.length_cm} onChange={(v) => setDimension("length_cm", v)} />
              <TextField id="width_cm" label="Width (cm)" type="number" step="0.001" min={0} className="cbm-calc" value={f.width_cm} onChange={(v) => setDimension("width_cm", v)} />
              <TextField id="height_cm" label="Height (cm)" type="number" step="0.001" min={0} className="cbm-calc" value={f.height_cm} onChange={(v) => setDimension("height_cm", v)} />
              <TextField
                id="packaging_unit_cbm"
                label="Packaging Unit CBM"
                type="number"
                step="0.000001"
                min={0}
                placeholder="Auto-calculated or enter directly"
                value={f.packaging_unit_cbm}
                onChange={(v) => set("packaging_unit_cbm", v)}
              />
            </div>

            <div className="section-title">Image Of Product (Max 5 images, &lt;5MB each)</div>
            <div className="form-grid" style={{ gridTemplateColumns: "1fr" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <label style={{ fontSize: "12.5px", fontWeight: 600, color: "var(--color-text-secondary)" }}>
                  Product Images (Photos)
                </label>
                {(() => {
                  let imageList: string[] = [];
                  try {
                    imageList = JSON.parse(f.images_json || "[]");
                  } catch {
                    imageList = f.image_url ? [f.image_url] : [];
                  }

                  return (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "14px", alignItems: "center" }}>
                      {imageList.map((imgUrl, index) => (
                        <div
                          key={index}
                          style={{
                            position: "relative",
                            width: "110px",
                            height: "110px",
                            borderRadius: "8px",
                            border: "1px solid #cbd5e0",
                            background: "#f8fafc",
                            overflow: "hidden",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                          }}
                        >
                          <img src={resolveImageUrl(imgUrl)} alt={`Product Preview ${index + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                          <button
                            type="button"
                            style={{
                              position: "absolute",
                              top: "4px",
                              right: "4px",
                              background: "rgba(220, 38, 38, 0.9)",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "50%",
                              width: "22px",
                              height: "22px",
                              cursor: "pointer",
                              fontSize: "12px",
                              fontWeight: "bold",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              boxShadow: "0 2px 4px rgba(0,0,0,0.2)",
                            }}
                            title="Remove Image"
                            onClick={() => {
                              const updated = imageList.filter((_, i) => i !== index);
                              set("images_json", JSON.stringify(updated));
                              set("image_url", updated[0] || "");
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}

                      {imageList.length < 5 && (
                        <div>
                          <input
                            type="file"
                            accept="image/*"
                            multiple
                            id="product_multi_image_file"
                            style={{ display: "none" }}
                            onChange={async (e) => {
                              const rawFiles = Array.from(e.target.files || []);
                              if (rawFiles.length === 0) return;

                              const availableSlots = 5 - imageList.length;
                              if (availableSlots <= 0) {
                                alert("Maximum limit of 5 images per product reached.");
                                e.target.value = "";
                                return;
                              }

                              if (rawFiles.length > availableSlots) {
                                alert(`You selected ${rawFiles.length} images, but only ${availableSlots} more image(s) can be added (max 5 total).`);
                              }

                              const filesToProcess = rawFiles.slice(0, availableSlots);
                              const newBase64s: string[] = [];

                              for (const file of filesToProcess) {
                                if (file.size > 5 * 1024 * 1024) {
                                  alert(`File "${file.name}" exceeds 5MB size limit and was skipped.`);
                                  continue;
                                }

                                const base64Data = await new Promise<string>((resolve) => {
                                  const reader = new FileReader();
                                  reader.onload = (ev) => resolve((ev.target?.result as string) || "");
                                  reader.readAsDataURL(file);
                                });

                                if (base64Data) {
                                  newBase64s.push(base64Data);
                                }
                              }

                              if (newBase64s.length > 0) {
                                const combinedList = [...imageList, ...newBase64s];
                                set("images_json", JSON.stringify(combinedList));
                                set("image_url", combinedList[0]);

                                // Upload files to server in background and replace base64 with server URLs if successful
                                filesToProcess.forEach((file, idx) => {
                                  const base64Str = newBase64s[idx];
                                  if (!base64Str) return;

                                  const formData = new FormData();
                                  formData.append("file", file);
                                  apiPostMultipart<{ url: string }>("/masters/products/upload-image", formData)
                                    .then((res) => {
                                      if (res.data?.url) {
                                        const serverUrl = res.data.url;
                                        // Read latest image list and swap matching base64
                                        const currentList: string[] = [...combinedList];
                                        const matchIdx = currentList.indexOf(base64Str);
                                        if (matchIdx !== -1) {
                                          currentList[matchIdx] = serverUrl;
                                          set("images_json", JSON.stringify(currentList));
                                          set("image_url", currentList[0]);
                                        }
                                      }
                                    })
                                    .catch((err) => {
                                      console.warn("Background upload fell back to local preview:", err);
                                    });
                                });
                              }

                              e.target.value = "";
                            }}
                          />
                          <label
                            htmlFor="product_multi_image_file"
                            style={{
                              width: "110px",
                              height: "110px",
                              borderRadius: "8px",
                              border: "2px dashed #3b82f6",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              background: "#eff6ff",
                              cursor: "pointer",
                              color: "#2563eb",
                              fontSize: "12px",
                              fontWeight: 600,
                              textAlign: "center",
                              padding: "8px",
                            }}
                          >
                            <span style={{ fontSize: "20px" }}>📷</span>
                            <span>+ Add Image</span>
                            <span style={{ fontSize: "10px", color: "#64748b", fontWeight: 400 }}>({imageList.length}/5, &lt;5MB)</span>
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })()}
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
                { label: "Brand", value: brand ? `${brand.name}${brand.status === "inactive" ? " (Inactive)" : ""}` : "—" },
                { label: "Category", value: cat ? `${cat.name}${cat.status === "inactive" ? " (Inactive)" : ""}` : "—" },
                { label: "Sub Category", value: subCat ? `${subCat.name}${subCat.status === "inactive" ? " (Inactive)" : ""}` : "—" },
                { label: "HSN Code", value: hsn ? hsn.code : "—" },
                {
                  label: "Organization",
                  value: (() => {
                    const orgIds = p.organization_ids && p.organization_ids.length > 0
                      ? p.organization_ids
                      : (p.organization_id ? [p.organization_id] : []);
                    if (!orgIds.length) return "—";
                    const names = orgIds
                      .map((id) => organizations.items.find((x) => x.id === id)?.name)
                      .filter(Boolean);
                    return names.length > 0 ? names.join(", ") : "—";
                  })(),
                },
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