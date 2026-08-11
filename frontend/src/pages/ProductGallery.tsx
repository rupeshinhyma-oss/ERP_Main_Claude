import { useState, useEffect } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { SideDrawer, DetailFieldGrid } from "@/components/SideDrawer";
import { apiGet, apiPatch } from "@/lib/api";
import { useLookup } from "@/lib/lookups";
import type {
  Product,
  Supplier,
  Brand,
  Hsn,
  ProductCategory,
  ProductSubCategory,
  Uom,
  Country,
  City,
} from "@/types";

function resolveImageUrl(url: string | null | undefined): string {
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

function isVideoUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  const clean = url.split("?")[0].toLowerCase();
  return Boolean(clean.match(/\.(mp4|webm|ogg|mov|avi|mkv|m4v|3gp|flv)$/i));
}

function getSupplierMedia(supplier: Supplier): string[] {
  let rawItems: string[] = [];

  const visitMediaVal = supplier.visit_media as unknown;
  const mediaUrlsVal = supplier.media_urls as unknown;

  if (Array.isArray(visitMediaVal) && visitMediaVal.length > 0) {
    rawItems = visitMediaVal.map(String);
  } else if (typeof visitMediaVal === "string" && visitMediaVal.trim().length > 0) {
    try {
      const parsed = JSON.parse(visitMediaVal);
      if (Array.isArray(parsed)) rawItems = parsed.map(String);
      else rawItems = [visitMediaVal];
    } catch {
      rawItems = visitMediaVal.split(",");
    }
  } else if (typeof mediaUrlsVal === "string" && mediaUrlsVal.trim().length > 0) {
    try {
      const parsed = JSON.parse(mediaUrlsVal);
      if (Array.isArray(parsed)) rawItems = parsed.map(String);
      else rawItems = mediaUrlsVal.split(",");
    } catch {
      rawItems = mediaUrlsVal.split(",");
    }
  }

  return rawItems
    .map((item) => {
      let str = String(item || "").trim();
      if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        str = str.slice(1, -1).trim();
      }
      return str;
    })
    .filter((str) => Boolean(str));
}

type GalleryTab = "all" | "products" | "suppliers";

export function ProductGalleryPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);

  const [galleryTab, setGalleryTab] = useState<GalleryTab>("all");
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");

  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedSupplier, setSelectedSupplier] = useState<Supplier | null>(null);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);

  const categories = useLookup<ProductCategory>("/masters/product-categories", 250);
  const subCategories = useLookup<ProductSubCategory>("/masters/product-sub-categories", 250);
  const brands = useLookup<Brand>("/masters/brands", 250);
  const hsnCodes = useLookup<Hsn>("/masters/hsn", 250);
  const uoms = useLookup<Uom>("/masters/uom", 250);
  const countries = useLookup<Country>("/masters/countries", 250);
  const cities = useLookup<City>("/masters/cities", 250);

  useEffect(() => {
    fetchGalleryData();
  }, [categoryFilter, subCategoryFilter, brandFilter]);

  async function fetchGalleryData() {
    setLoading(true);
    try {
      const prodParams: Record<string, string> = {
        page_size: "1000",
        sort_by: "created_at",
        sort_order: "desc",
      };
      if (categoryFilter) prodParams.category_id = categoryFilter;
      if (subCategoryFilter) prodParams.sub_category_id = subCategoryFilter;
      if (brandFilter) prodParams.brand_id = brandFilter;

      const prodQuery = new URLSearchParams(prodParams).toString();
      const prodRes = await apiGet<Product[] | { items: Product[] }>(`/masters/products?${prodQuery}`);
      const prodItems = Array.isArray(prodRes.data) ? prodRes.data : (prodRes.data?.items || []);
      setProducts(prodItems);

      const suppRes = await apiGet<Supplier[] | { items: Supplier[] }>("/suppliers?page_size=1000");
      const suppItems = Array.isArray(suppRes.data) ? suppRes.data : (suppRes.data?.items || []);
      setSuppliers(suppItems);
    } catch (err) {
      console.error("Failed to load gallery data:", err);
    } finally {
      setLoading(false);
    }
  }

  const scopedSubCategories = categoryFilter
    ? subCategories.items.filter((sc) => sc.category_id === categoryFilter)
    : subCategories.items;

  const filteredProducts = products.filter((p) => {
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

  const filteredSuppliers = suppliers.filter((s) => {
    const media = getSupplierMedia(s);
    if (media.length === 0) return false;

    if (categoryFilter && s.category_ids && !s.category_ids.includes(categoryFilter)) {
      return false;
    }

    if (!search.trim()) return true;
    const cleanSearch = search.toLowerCase().replace(/[\s-]/g, "");
    const company = (s.company_name || "").toLowerCase().replace(/[\s-]/g, "");
    const remarks = (s.visit_remarks || s.overall_remarks || "").toLowerCase().replace(/[\s-]/g, "");
    return company.includes(cleanSearch) || remarks.includes(cleanSearch);
  });

  const p = selectedProduct;
  const prodCat = p ? categories.items.find((c) => c.id === p.category_id) : undefined;
  const prodSubCat = p ? subCategories.items.find((sc) => sc.id === p.sub_category_id) : undefined;
  const prodBrand = p ? brands.items.find((b) => b.id === p.brand_id) : undefined;
  const prodHsn = p ? hsnCodes.items.find((h) => h.id === p.hsn_id) : undefined;
  const prodUom = p ? uoms.items.find((u) => u.id === p.uom_id) : undefined;

  const supp = selectedSupplier;
  const suppMedia = supp ? getSupplierMedia(supp) : [];
  const suppCountry = supp ? countries.items.find((c) => c.id === supp.country_id)?.name : "";
  const suppCity = supp ? cities.items.find((c) => c.id === supp.city_id)?.name : "";

  return (
    <AppShell activeKey="product-gallery">
      <main className="page">
        <Breadcrumb trail={["Inventory", "Product & Supplier Gallery"]} />

        <div className="page-header">
          <div>
            <h1>Product &amp; Supplier Gallery</h1>
            <div className="page-subtitle">
              Visual catalog of product images and supplier factory/office visit media.
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
          <button
            type="button"
            onClick={() => setGalleryTab("all")}
            style={{
              padding: "9px 18px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: galleryTab === "all" ? "#0061f2" : "#ffffff",
              color: galleryTab === "all" ? "#ffffff" : "#334155",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            🌐 All Combined Media ({filteredProducts.length + filteredSuppliers.length})
          </button>

          <button
            type="button"
            onClick={() => setGalleryTab("products")}
            style={{
              padding: "9px 18px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: galleryTab === "products" ? "#0061f2" : "#ffffff",
              color: galleryTab === "products" ? "#ffffff" : "#334155",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            📦 Product Photos ({filteredProducts.length})
          </button>

          <button
            type="button"
            onClick={() => setGalleryTab("suppliers")}
            style={{
              padding: "9px 18px",
              borderRadius: "6px",
              border: "1px solid #cbd5e1",
              background: galleryTab === "suppliers" ? "#0061f2" : "#ffffff",
              color: galleryTab === "suppliers" ? "#ffffff" : "#334155",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            🏬 Supplier Visit Photos ({filteredSuppliers.length})
          </button>
        </div>

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
            placeholder="Search by code, product name, or supplier company..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              padding: "9px 14px",
              borderRadius: "6px",
              border: "1px solid #cbd5e0",
              fontSize: "13.5px",
              flex: 1,
              minWidth: "240px",
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

        {loading ? (
          <div style={{ textAlign: "center", padding: "60px", color: "#64748b" }}>
            Loading media gallery...
          </div>
        ) : (galleryTab === "products" && filteredProducts.length === 0) ||
          (galleryTab === "suppliers" && filteredSuppliers.length === 0) ||
          (galleryTab === "all" && filteredProducts.length === 0 && filteredSuppliers.length === 0) ? (
          <div className="card" style={{ padding: "60px", textAlign: "center", color: "#94a3b8" }}>
            <h3>No media found</h3>
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
            {(galleryTab === "all" || galleryTab === "products") &&
              filteredProducts.map((prod) => {
                const imgList = Array.isArray(prod.images) && prod.images.length > 0
                  ? prod.images
                  : (prod.image_url ? [prod.image_url] : []);
                const img = imgList[0];
                const brandObj = brands.items.find((b) => b.id === prod.brand_id);
                const subCatObj = subCategories.items.find((sc) => sc.id === prod.sub_category_id);

                return (
                  <div
                    key={`prod-${prod.id}`}
                    className="card"
                    onClick={() => {
                      setSelectedProduct(prod);
                      setSelectedSupplier(null);
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
                        isVideoUrl(img) ? (
                          <video
                            src={resolveImageUrl(img)}
                            muted
                            autoPlay
                            loop
                            playsInline
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <img
                            src={resolveImageUrl(img)}
                            alt={prod.product_name_tally || prod.product_name || "Product Photo"}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        )
                      ) : (
                        <div style={{ textAlign: "center", color: "#cbd5e1" }}>
                          <div style={{ fontSize: "12px", marginTop: "4px", fontWeight: 500 }}>No Photo</div>
                        </div>
                      )}

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
                        {prod.product_code || "PRODUCT"}
                      </span>

                      {imgList.length > 0 && (
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
                          {isVideoUrl(img) ? "🎬" : "📷"} {imgList.length} Photos
                        </span>
                      )}
                    </div>

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

            {(galleryTab === "all" || galleryTab === "suppliers") &&
              filteredSuppliers.map((supp) => {
                const sMedia = getSupplierMedia(supp);
                const firstImg = sMedia[0];
                const sCountry = countries.items.find((c) => c.id === supp.country_id)?.name;
                const sCity = cities.items.find((c) => c.id === supp.city_id)?.name;
                const firstIsVideo = isVideoUrl(firstImg);

                return (
                  <div
                    key={`supp-${supp.id}`}
                    className="card"
                    onClick={() => {
                      setSelectedSupplier(supp);
                      setSelectedProduct(null);
                      setSelectedImageIndex(0);
                    }}
                    style={{
                      borderRadius: "10px",
                      overflow: "hidden",
                      border: "1px solid #93c5fd",
                      background: "#f0f9ff",
                      cursor: "pointer",
                      transition: "transform 0.15s ease, box-shadow 0.15s ease",
                      display: "flex",
                      flexDirection: "column",
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.transform = "translateY(-3px)";
                      e.currentTarget.style.boxShadow = "0 10px 15px -3px rgba(37,99,235,0.2)";
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.transform = "translateY(0)";
                      e.currentTarget.style.boxShadow = "none";
                    }}
                  >
                    <div
                      style={{
                        height: "180px",
                        background: "#e0f2fe",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        borderBottom: "1px solid #bae6fd",
                        position: "relative",
                      }}
                    >
                      {firstImg ? (
                        firstIsVideo ? (
                          <video
                            src={resolveImageUrl(firstImg)}
                            muted
                            autoPlay
                            loop
                            playsInline
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        ) : (
                          <img
                            src={resolveImageUrl(firstImg)}
                            alt={supp.company_name}
                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          />
                        )
                      ) : (
                        <div style={{ textAlign: "center", color: "#0284c7" }}>
                          <div style={{ fontSize: "12px", marginTop: "4px", fontWeight: 500 }}>No Visit Media</div>
                        </div>
                      )}

                      <span
                        style={{
                          position: "absolute",
                          top: "10px",
                          left: "10px",
                          background: "#1d4ed8",
                          color: "#ffffff",
                          fontSize: "11px",
                          fontWeight: 700,
                          padding: "3px 8px",
                          borderRadius: "4px",
                        }}
                      >
                        🏬 SUPPLIER VISIT
                      </span>

                      <span
                        style={{
                          position: "absolute",
                          bottom: "10px",
                          right: "10px",
                          background: "rgba(15, 23, 42, 0.8)",
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
                        {firstIsVideo ? "🎬" : "📸"} {sMedia.length} Media
                      </span>
                    </div>

                    <div style={{ padding: "14px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                      <div>
                        <h4
                          style={{
                            margin: "0 0 6px 0",
                            fontSize: "14.5px",
                            fontWeight: 700,
                            color: "#0369a1",
                            lineHeight: "1.3",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {supp.company_name}
                        </h4>
                        <div style={{ fontSize: "12px", color: "#475569", display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                          {(sCity || sCountry) && <span>📍 {[sCity, sCountry].filter(Boolean).join(", ")}</span>}
                        </div>
                      </div>

                      {supp.visit_remarks && (
                        <div
                          style={{
                            marginTop: "10px",
                            fontSize: "11.5px",
                            color: "#334155",
                            background: "#ffffff",
                            padding: "6px 8px",
                            borderRadius: "4px",
                            border: "1px solid #cbd5e1",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          💬 {supp.visit_remarks}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </main>

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
            if (!window.confirm("Are you sure you want to delete this media from the product?")) return;

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
              console.error("Failed to delete media:", err);
              alert("Failed to delete media. Please try again.");
            }
          };

          const activeMedia = detailImgList[selectedImageIndex] || detailImgList[0];
          const activeIsVideo = isVideoUrl(activeMedia);

          return (
            <>
              {detailImgList.length > 0 && (
                <div style={{ marginBottom: "20px", background: "#f8fafc", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0" }}>
                  <div style={{ textAlign: "center", position: "relative" }}>
                    {activeIsVideo ? (
                      <video
                        src={resolveImageUrl(activeMedia)}
                        controls
                        autoPlay
                        style={{
                          maxHeight: "260px",
                          maxWidth: "100%",
                          borderRadius: "8px",
                          boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
                        }}
                      />
                    ) : (
                      <img
                        src={resolveImageUrl(activeMedia)}
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
                    )}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px", padding: "0 4px" }}>
                    <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>
                      Media {selectedImageIndex + 1} of {detailImgList.length}
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
                      title="Delete this media from product"
                    >
                      🗑️ Delete Media
                    </button>
                  </div>
                  {detailImgList.length > 1 && (
                    <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginTop: "12px" }}>
                      {detailImgList.map((imgUri, idx) => (
                        isVideoUrl(imgUri) ? (
                          <div
                            key={idx}
                            onClick={() => setSelectedImageIndex(idx)}
                            style={{
                              width: "56px",
                              height: "56px",
                              borderRadius: "6px",
                              background: "#0f172a",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "#ffffff",
                              cursor: "pointer",
                              fontSize: "16px",
                              border: idx === selectedImageIndex ? "2.5px solid #2563eb" : "1px solid #cbd5e0",
                              boxShadow: idx === selectedImageIndex ? "0 0 0 2px rgba(37,99,235,0.2)" : "0 1px 3px rgba(0,0,0,0.1)",
                              transform: idx === selectedImageIndex ? "scale(1.08)" : "scale(1)",
                              transition: "all 0.15s ease",
                            }}
                          >
                            🎬
                          </div>
                        ) : (
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
                        )
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
                  { label: "Brand", value: prodBrand ? prodBrand.name : "—" },
                  { label: "Category", value: prodCat ? prodCat.name : "—" },
                  { label: "Sub Category", value: prodSubCat ? prodSubCat.name : "—" },
                  { label: "HSN Code", value: prodHsn ? prodHsn.code : "—" },
                  {
                    label: "Refund VAT %",
                    value: <span style={{ color: "#16a34a" }}>{p.refund_vat_percent != null ? `${p.refund_vat_percent}%` : "0%"}</span>,
                  },
                  { label: "UOM", value: prodUom ? `${prodUom.name} (${prodUom.code})` : "—" },
                  { label: "Packaging Quantity", value: p.packaging_quantity != null ? p.packaging_quantity : "—" },
                ]}
              />
            </>
          );
        })()}
      </SideDrawer>

      <SideDrawer
        open={Boolean(selectedSupplier)}
        title={supp ? `Supplier Visit Media — ${supp.company_name}` : "Supplier Visit Details"}
        subtitle={supp ? [suppCity, suppCountry].filter(Boolean).join(", ") : ""}
        onClose={() => setSelectedSupplier(null)}
      >
        {supp && (() => {
          const activeSuppMedia = suppMedia[selectedImageIndex] || suppMedia[0];
          const activeSuppIsVideo = isVideoUrl(activeSuppMedia);

          return (
            <>
              {suppMedia.length > 0 && (
                <div style={{ marginBottom: "20px", background: "#f0f9ff", padding: "16px", borderRadius: "8px", border: "1px solid #bae6fd" }}>
                  <div style={{ textAlign: "center", position: "relative" }}>
                    {activeSuppIsVideo ? (
                      <video
                        src={resolveImageUrl(activeSuppMedia)}
                        controls
                        autoPlay
                        style={{
                          maxHeight: "260px",
                          maxWidth: "100%",
                          borderRadius: "8px",
                          boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
                        }}
                      />
                    ) : (
                      <img
                        src={resolveImageUrl(activeSuppMedia)}
                        alt="Supplier Visit Photo"
                        style={{
                          maxHeight: "260px",
                          maxWidth: "100%",
                          borderRadius: "8px",
                          objectFit: "contain",
                          boxShadow: "0 4px 6px -1px rgba(0,0,0,0.1)",
                          transition: "all 0.2s ease",
                        }}
                      />
                    )}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px", padding: "0 4px" }}>
                    <span style={{ fontSize: "12px", color: "#0369a1", fontWeight: 600 }}>
                      Visit Media {selectedImageIndex + 1} of {suppMedia.length} {activeSuppIsVideo ? "(Video)" : "(Image)"}
                    </span>
                  </div>
                  {suppMedia.length > 1 && (
                    <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap", marginTop: "12px" }}>
                      {suppMedia.map((imgUri, idx) => (
                        isVideoUrl(imgUri) ? (
                          <div
                            key={idx}
                            onClick={() => setSelectedImageIndex(idx)}
                            style={{
                              width: "56px",
                              height: "56px",
                              borderRadius: "6px",
                              background: "#0369a1",
                              display: "flex",
                              flexDirection: "column",
                              alignItems: "center",
                              justifyContent: "center",
                              color: "#ffffff",
                              cursor: "pointer",
                              fontSize: "16px",
                              border: idx === selectedImageIndex ? "2.5px solid #0284c7" : "1px solid #bae6fd",
                              boxShadow: idx === selectedImageIndex ? "0 0 0 2px rgba(2,132,199,0.2)" : "0 1px 3px rgba(0,0,0,0.1)",
                              transform: idx === selectedImageIndex ? "scale(1.08)" : "scale(1)",
                              transition: "all 0.15s ease",
                            }}
                          >
                            🎬
                          </div>
                        ) : (
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
                              border: idx === selectedImageIndex ? "2.5px solid #0284c7" : "1px solid #bae6fd",
                              boxShadow: idx === selectedImageIndex ? "0 0 0 2px rgba(2,132,199,0.2)" : "0 1px 3px rgba(0,0,0,0.1)",
                              transform: idx === selectedImageIndex ? "scale(1.08)" : "scale(1)",
                              transition: "all 0.15s ease",
                            }}
                          />
                        )
                      ))}
                    </div>
                  )}
                </div>
              )}

              <DetailFieldGrid
                fields={[
                  {
                    label: "Company Name",
                    value: supp.company_name || "—",
                    fullWidth: true,
                  },
                  { label: "Supplier Type", value: supp.supplier_type || "—" },
                  { label: "Country", value: suppCountry || "—" },
                  { label: "City", value: suppCity || "—" },
                  { label: "Visited Factory / Office", value: supp.visited_factory_office ? "Yes ✅" : "No ❌" },
                  { label: "Visit Remarks", value: supp.visit_remarks || "—", fullWidth: true },
                  { label: "Overall Remarks", value: supp.overall_remarks || "—", fullWidth: true },
                ]}
              />
            </>
          );
        })()}
      </SideDrawer>
    </AppShell>
  );
}
