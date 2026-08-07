import { useState, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { SideDrawer, DetailFieldGrid } from "@/components/SideDrawer";
import { apiGet } from "@/lib/api";
import { useLookup } from "@/lib/lookups";
import type {
  Product,
  Brand,
  Hsn,
  ProductCategory,
  ProductSubCategory,
  Uom,
} from "@/types";

function resolveImageUrl(url: string | null | undefined): string {
  if (!url) return "";
  if (url.startsWith("data:") || url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return `http://localhost:8000${url.startsWith("/") ? "" : "/"}${url}`;
}

export function ProductGalleryPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const categories = useLookup<ProductCategory>("/masters/categories", 250);
  const subCategories = useLookup<ProductSubCategory>("/masters/subcategories", 250);
  const brands = useLookup<Brand>("/masters/brands", 250);
  const hsnCodes = useLookup<Hsn>("/masters/hsn", 250);
  const uoms = useLookup<Uom>("/masters/uom", 250);

  useEffect(() => {
    fetchProducts();
  }, [categoryFilter, subCategoryFilter, brandFilter]);

  async function fetchProducts() {
    setLoading(true);
    try {
      const params: Record<string, string> = { limit: "250" };
      if (categoryFilter) params.category_id = categoryFilter;
      if (subCategoryFilter) params.sub_category_id = subCategoryFilter;
      if (brandFilter) params.brand_id = brandFilter;

      const query = new URLSearchParams(params).toString();
      const { data } = await apiGet<Product[] | { items: Product[] }>(`/masters/products?${query}`);
      const items = Array.isArray(data) ? data : (data?.items || []);
      setProducts(items);
    } catch (err) {
      console.error("Failed to load products gallery:", err);
    } finally {
      setLoading(false);
    }
  }

  const scopedSubCategories = categoryFilter
    ? subCategories.items.filter((sc) => sc.category_id === categoryFilter)
    : subCategories.items;

  const filteredProducts = products.filter((p) => {
    if (!search.trim()) return true;
    const term = search.toLowerCase();
    const name = (p.product_name_tally || p.product_name || "").toLowerCase();
    const code = (p.product_code || "").toLowerCase();
    return name.includes(term) || code.includes(term);
  });

  const p = selectedProduct;
  const cat = p ? categories.items.find((c) => c.id === p.category_id) : undefined;
  const subCat = p ? subCategories.items.find((sc) => sc.id === p.sub_category_id) : undefined;
  const brand = p ? brands.items.find((b) => b.id === p.brand_id) : undefined;
  const hsn = p ? hsnCodes.items.find((h) => h.id === p.hsn_id) : undefined;
  const uom = p ? uoms.items.find((u) => u.id === p.uom_id) : undefined;

  return (
    <AppShell activeKey="product-gallery">
      <main className="page">
        <Breadcrumb trail={["Inventory", "Product Gallery"]} />

        <div className="page-header">
          <div>
            <h1>Product Gallery</h1>
            <div className="page-subtitle">
              Visual catalog of all products and physical images.
            </div>
          </div>
        </div>

        {/* Filters */}
        <div
          className="card"
          style={{
            padding: "16px 20px",
            marginBottom: "24px",
            display: "flex",
            gap: "16px",
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <input
            type="text"
            placeholder="Search products by code or name..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: "9px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e0",
              fontSize: "13.5px",
              flex: 1,
              minWidth: "220px",
            }}
          />

          <select
            value={categoryFilter}
            onChange={(e) => {
              setCategoryFilter(e.target.value);
              setSubCategoryFilter("");
            }}
            style={{
              padding: "9px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e0",
              fontSize: "13.5px",
              background: "#ffffff",
              minWidth: "160px",
            }}
          >
            <option value="">All Categories</option>
            {categories.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>

          <select
            value={subCategoryFilter}
            onChange={(e) => setSubCategoryFilter(e.target.value)}
            style={{
              padding: "9px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e0",
              fontSize: "13.5px",
              background: "#ffffff",
              minWidth: "160px",
            }}
          >
            <option value="">All Sub Categories</option>
            {scopedSubCategories.map((sc) => (
              <option key={sc.id} value={sc.id}>
                {sc.name}
              </option>
            ))}
          </select>

          <select
            value={brandFilter}
            onChange={(e) => setBrandFilter(e.target.value)}
            style={{
              padding: "9px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e0",
              fontSize: "13.5px",
              background: "#ffffff",
              minWidth: "160px",
            }}
          >
            <option value="">All Brands</option>
            {brands.items.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        {/* Gallery Grid */}
        {loading ? (
          <div style={{ textAlign: "center", padding: "60px", color: "#64748b" }}>
            Loading product gallery...
          </div>
        ) : filteredProducts.length === 0 ? (
          <div className="card" style={{ padding: "60px", textAlign: "center", color: "#94a3b8" }}>
            <h3>No products found</h3>
            <p>Try adjusting your search query or top filters.</p>
          </div>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
              gap: "20px",
            }}
          >
            {filteredProducts.map((prod) => {
              const img = prod.image_url || (prod.images && prod.images[0]);
              const brandObj = brands.items.find((b) => b.id === prod.brand_id);
              const subCatObj = subCategories.items.find((sc) => sc.id === prod.sub_category_id);

              return (
                <div
                  key={prod.id}
                  className="card"
                  onClick={() => setSelectedProduct(prod)}
                  style={{
                    borderRadius: "10px",
                    overflow: "hidden",
                    border: "1px solid #e2e8f0",
                    cursor: "pointer",
                    transition: "transform 0.15s ease, box-shadow 0.15s ease",
                    display: "flex",
                    flexDirection: "column",
                  }}
                  onMouseOver={(e) => {
                    e.currentTarget.style.transform = "translateY(-3px)";
                    e.currentTarget.style.boxShadow = "0 10px 15px -3px rgba(0,0,0,0.1)";
                  }}
                  onMouseOut={(e) => {
                    e.currentTarget.style.transform = "translateY(0)";
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  {/* Photo Container */}
                  <div
                    style={{
                      height: "180px",
                      background: "#f8fafc",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      borderBottom: "1px solid #f1f5f9",
                      position: "relative",
                    }}
                  >
                    {img ? (
                      <img
                        src={resolveImageUrl(img)}
                        alt={prod.product_name_tally || prod.product_name || "Product Photo"}
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      <div style={{ textAlign: "center", color: "#cbd5e1" }}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <polyline points="21 15 16 10 5 21" />
                        </svg>
                        <div style={{ fontSize: "12px", marginTop: "4px", fontWeight: 500 }}>No Photo</div>
                      </div>
                    )}

                    {prod.product_code && (
                      <span
                        style={{
                          position: "absolute",
                          top: "10px",
                          left: "10px",
                          background: "rgba(15, 23, 42, 0.75)",
                          color: "#ffffff",
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: "4px",
                        }}
                      >
                        {prod.product_code}
                      </span>
                    )}
                  </div>

                  {/* Card Body */}
                  <div style={{ padding: "14px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                    <div>
                      <h4
                        style={{
                          margin: "0 0 6px 0",
                          fontSize: "14px",
                          fontWeight: 600,
                          color: "#0f172a",
                          lineHeight: "1.3",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {prod.product_name_tally || prod.product_name}
                      </h4>
                      <div style={{ fontSize: "12px", color: "#64748b", display: "flex", gap: "8px", flexWrap: "wrap", marginTop: "4px" }}>
                        {brandObj && <span>Brand: {brandObj.name}</span>}
                        {subCatObj && <span>Sub-Cat: {subCatObj.name}</span>}
                      </div>
                    </div>

                    {prod.refund_vat_percent != null && (
                      <div style={{ marginTop: "12px", fontSize: "12px", color: "#16a34a", fontWeight: 600 }}>
                        Refund VAT: {prod.refund_vat_percent}%
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Product Detail Drawer */}
      <SideDrawer
        open={Boolean(selectedProduct)}
        title={p ? `Product #${p.product_code || p.id.slice(0, 6)}` : "Product Detail"}
        subtitle={p ? p.product_name_tally || p.product_name || "" : ""}
        onClose={() => setSelectedProduct(null)}
      >
        {p && (
          <>
            {(p.image_url || (p.images && p.images.length > 0)) && (
              <div style={{ marginBottom: "20px", textAlign: "center", background: "#f8fafc", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                <img
                  src={resolveImageUrl(p.image_url || p.images?.[0])}
                  alt="Product Photo"
                  style={{
                    maxHeight: "240px",
                    maxWidth: "100%",
                    borderRadius: "8px",
                    objectFit: "contain",
                    boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
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
                  label: "Refund VAT %",
                  value: <span style={{ color: "#16a34a" }}>{p.refund_vat_percent != null ? `${p.refund_vat_percent}%` : "0%"}</span>,
                },
                { label: "UOM", value: uom ? `${uom.name} (${uom.code})` : "—" },
                { label: "Packaging Quantity", value: p.packaging_quantity != null ? p.packaging_quantity : "—" },
              ]}
            />
          </>
        )}
      </SideDrawer>
    </AppShell>
  );
}
