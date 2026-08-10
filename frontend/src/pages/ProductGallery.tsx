import { useState, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { SideDrawer, DetailFieldGrid } from "@/components/SideDrawer";
import { apiGet, apiPatch } from "@/lib/api";
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
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  const categories = useLookup<ProductCategory>("/masters/product-categories", 250);
  const subCategories = useLookup<ProductSubCategory>("/masters/product-sub-categories", 250);
  const brands = useLookup<Brand>("/masters/brands", 250);
  const hsnCodes = useLookup<Hsn>("/masters/hsn", 250);
  const uoms = useLookup<Uom>("/masters/uom", 250);

  useEffect(() => {
    fetchProducts();
  }, [categoryFilter, subCategoryFilter, brandFilter]);

  async function fetchProducts() {
    setLoading(true);
    try {
      const params: Record<string, string> = {
        page_size: "1000",
        sort_by: "created_at",
        sort_order: "desc",
      };
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
    // Only include products that HAVE uploaded photos
    const imgList = Array.isArray(p.images) && p.images.length > 0
      ? p.images
      : (p.image_url ? [p.image_url] : []);

    const hasPhoto = imgList.length > 0 && imgList.some((img) => img && img.trim() !== "");
    if (!hasPhoto) return false;

    if (!search.trim()) return true;
    const cleanSearch = search.toLowerCase().replace(/[\s-]/g, "");
    const name = (p.product_name_tally || p.product_name || "").toLowerCase().replace(/[\s-]/g, "");
    const code = (p.product_code || "").toLowerCase().replace(/[\s-]/g, "");
    return name.includes(cleanSearch) || code.includes(cleanSearch);
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
              const imgList = Array.isArray(prod.images) && prod.images.length > 0
                ? prod.images
                : (prod.image_url ? [prod.image_url] : []);
              const img = imgList[0];
              const brandObj = brands.items.find((b) => b.id === prod.brand_id);
              const subCatObj = subCategories.items.find((sc) => sc.id === prod.sub_category_id);

              return (
                <div
                  key={prod.id}
                  className="card"
                  onClick={() => {
                    setSelectedProduct(prod);
                    setSelectedImageIndex(0);
                  }}
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

                    {imgList.length > 1 && (
                      <span
                        style={{
                          position: "absolute",
                          bottom: "10px",
                          right: "10px",
                          background: "rgba(37, 99, 235, 0.85)",
                          color: "#ffffff",
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: "4px",
                          display: "flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                      >
                        📷 {imgList.length} Photos
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
        {p && (() => {
          const detailImgList: string[] = Array.isArray(p.images) && p.images.length > 0
            ? p.images
            : (p.image_url ? [p.image_url] : []);

          const handleDeletePhoto = async (indexToDelete: number) => {
            if (!p) return;
            if (!window.confirm("Are you sure you want to delete this photo from the product?")) return;

            const updatedImages = detailImgList.filter((_, idx) => idx !== indexToDelete);
            const updatedPayload = {
              images: updatedImages,
              image_url: updatedImages[0] || null,
            };

            try {
              await apiPatch<Product>(`/masters/products/${p.id}`, updatedPayload);
              setProducts((prev) =>
                prev.map((prod) => (prod.id === p.id ? { ...prod, ...updatedPayload } : prod))
              );
              setSelectedProduct((prev) => (prev ? { ...prev, ...updatedPayload } : null));
              setSelectedImageIndex(0);
            } catch (err) {
              console.error("Failed to delete photo:", err);
              alert("Failed to delete photo. Please try again.");
            }
          };

          return (
            <>
              {detailImgList.length > 0 && (
                <div style={{ marginBottom: "20px", background: "#f8fafc", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ textAlign: "center", position: "relative" }}>
                    <img
                      src={resolveImageUrl(detailImgList[selectedImageIndex] || detailImgList[0])}
                      alt="Product Primary Photo"
                      style={{
                        maxHeight: "260px",
                        maxWidth: "100%",
                        borderRadius: "8px",
                        objectFit: "contain",
                        boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
                        transition: "all 0.2s ease",
                      }}
                    />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px", padding: "0 4px" }}>
                    <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>
                      Photo {selectedImageIndex + 1} of {detailImgList.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleDeletePhoto(selectedImageIndex)}
                      style={{
                        background: "#fee2e2",
                        color: "#dc2626",
                        border: "1px solid #fca5a5",
                        borderRadius: "6px",
                        padding: "4px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "4px",
                        transition: "all 0.15s ease",
                      }}
                      title="Delete this photo from product"
                    >
                      🗑️ Delete Photo
                    </button>
                  </div>
                  {detailImgList.length > 1 && (
                    <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginTop: "12px" }}>
                      {detailImgList.map((imgUri, idx) => (
                        <img
                          key={idx}
                          src={resolveImageUrl(imgUri)}
                          alt={`Thumbnail ${idx + 1}`}
                          onClick={() => setSelectedImageIndex(idx)}
                          style={{
                            width: "56px",
                            height: "56px",
                            borderRadius: "6px",
                            objectFit: "cover",
                            cursor: "pointer",
                            border: idx === selectedImageIndex ? "2.5px solid #2563eb" : "1px solid #cbd5e0",
                            boxShadow: idx === selectedImageIndex ? "0 0 0 2px rgba(37,99,235,0.2)" : "0 1px 3px rgba(0,0,0,0.1)",
                            transform: idx === selectedImageIndex ? "scale(1.08)" : "scale(1)",
                            transition: "all 0.15s ease",
                          }}
                        />
                      ))}
                    </div>
                  )}
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
        );
      })()}
      </SideDrawer>
    </AppShell>
  );
}
