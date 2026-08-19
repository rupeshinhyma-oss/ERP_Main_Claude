import { useState, useEffect, useMemo } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { SideDrawer, DetailFieldGrid } from "@/components/SideDrawer";
import { apiGet, apiPatch } from "@/lib/api";
import { usePendingGuard, useAuth } from "@/lib/hooks";
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
  if (clean.toLowerCase().startsWith("/static/uploads/")) {
    clean = "/static/uploads/" + clean.slice("/static/uploads/".length);
  } else if (clean.toLowerCase().startsWith("/uploads/")) {
    clean = "/uploads/" + clean.slice("/uploads/".length);
  }
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

function dataURLtoBlob(dataurl: string): Blob {
  const arr = dataurl.split(",");
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : "image/png";
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

function getSafeFileExtension(url: string, isVideo = false): string {
  if (!url) return isVideo ? "mp4" : "jpg";
  const clean = url.trim();
  if (clean.startsWith("data:")) {
    if (clean.includes("data:image/png")) return "png";
    if (clean.includes("data:image/jpeg") || clean.includes("data:image/jpg")) return "jpg";
    if (clean.includes("data:image/webp")) return "webp";
    if (clean.includes("data:image/gif")) return "gif";
    if (clean.includes("data:video/webm")) return "webm";
    if (clean.includes("data:video/mp4")) return "mp4";
    return isVideo ? "mp4" : "jpg";
  }
  const cleanUrl = clean.split("?")[0].split("#")[0];
  const parts = cleanUrl.split(".");
  if (parts.length > 1) {
    const ext = parts.pop()?.toLowerCase() || "";
    if (ext.length >= 2 && ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)) {
      return ext;
    }
  }
  return isVideo ? "mp4" : "jpg";
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").slice(0, 60);
}

function downloadMediaFile(url: string | null | undefined, filenamePrefix = "media", index = 1) {
  if (!url) return;
  const clean = url.trim();
  const isVid = isVideoUrl(clean);
  const ext = getSafeFileExtension(clean, isVid);
  const safePrefix = sanitizeFilename(filenamePrefix);
  const fileName = `${safePrefix}_${index}_${Date.now()}.${ext}`;

  if (clean.startsWith("data:")) {
    try {
      const blob = dataURLtoBlob(clean);
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
      return;
    } catch (e) {
      console.error("Failed to convert data URL to blob:", e);
    }
  }

  const fullUrl = resolveImageUrl(clean);
  fetch(fullUrl)
    .then((res) => res.blob())
    .then((blob) => {
      const blobUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => window.URL.revokeObjectURL(blobUrl), 1000);
    })
    .catch(() => {
      const link = document.createElement("a");
      link.href = fullUrl;
      link.target = "_blank";
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
}

function downloadAllMediaFiles(urls: string[], filenamePrefix = "media") {
  if (!urls || urls.length === 0) return;
  urls.forEach((url, i) => {
    setTimeout(() => {
      downloadMediaFile(url, filenamePrefix, i + 1);
    }, i * 250);
  });
}

function isDirectMediaUrl(url: string): boolean {
  if (!url) return false;
  const str = url.trim().toLowerCase();
  if (str.startsWith("data:image/") || str.startsWith("data:video/")) return true;
  if (str.includes("/storage/v1/object/public/") || str.includes("/uploads/")) return true;
  if (str.match(/\.(jpg|jpeg|png|webp|gif|svg|bmp|avif)(\?.*)?$/i)) return true;
  if (str.match(/\.(mp4|webm|mov|mkv|avi|m4v)(\?.*)?$/i)) return true;
  return false;
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
    .filter((str) => Boolean(str) && isDirectMediaUrl(str));
}

function getSupplierFolderLinks(supplier: Supplier): string[] {
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
    .filter((str) => Boolean(str) && !isDirectMediaUrl(str));
}

function ProductGallerySkeletonGrid({ count = 12 }: { count?: number }) {
  const titleWidths = ["85%", "70%", "90%", "65%", "75%", "80%"];
  const subWidths = ["45%", "60%", "40%", "50%", "55%", "35%"];

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: "20px",
      }}
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={`gallery-sk-${idx}`}
          className="card"
          style={{
            borderRadius: "10px",
            overflow: "hidden",
            border: "1px solid #e2e8f0",
            display: "flex",
            flexDirection: "column",
            background: "#ffffff",
          }}
        >
          {/* Image Thumbnail Placeholder */}
          <div
            style={{
              height: "180px",
              background: "#f8fafc",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div className="skeleton-box" style={{ width: "100%", height: "100%", borderRadius: 0 }} />
            <div
              className="skeleton-line"
              style={{
                position: "absolute",
                top: "10px",
                left: "10px",
                width: "60px",
                height: "18px",
                borderRadius: "4px",
              }}
            />
            <div
              className="skeleton-line"
              style={{
                position: "absolute",
                bottom: "10px",
                right: "10px",
                width: "65px",
                height: "18px",
                borderRadius: "4px",
              }}
            />
          </div>

          {/* Card Body */}
          <div style={{ padding: "14px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div
                className="skeleton-line"
                style={{
                  width: titleWidths[idx % titleWidths.length],
                  height: "15px",
                  marginBottom: "8px",
                  borderRadius: "4px",
                }}
              />
              <div
                className="skeleton-line"
                style={{
                  width: subWidths[idx % subWidths.length],
                  height: "12px",
                  borderRadius: "4px",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "14px" }}>
              <div
                className="skeleton-line"
                style={{ width: "50px", height: "18px", borderRadius: "10px" }}
              />
              <div
                className="skeleton-line"
                style={{ width: "70px", height: "24px", borderRadius: "4px" }}
              />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

type GalleryTab = "all" | "products" | "suppliers";

export function ProductGalleryPage() {
  const { hasPermission } = useAuth();
  const canDeleteProductMedia = hasPermission("product.update");
  const canDeleteSupplierMedia = hasPermission("supplier.update");

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
  const [selectedMediaIndices, setSelectedMediaIndices] = useState<number[]>([]);
  // Phase 7: keyed by "productId:photoIndex" so deleting one photo never
  // disables the delete control for another photo/product.
  const { isPending: isPhotoDeletePending, guard: guardPhotoDelete } = usePendingGuard<string>();

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
      console.error("Failed to fetch gallery data:", err);
    } finally {
      setLoading(false);
    }
  }

  const allProductMediaCount = useMemo(() => {
    return products.reduce((acc, p) => {
      const imgList = Array.isArray(p.images) && p.images.length > 0
        ? p.images
        : (p.image_url ? [p.image_url] : []);
      return acc + imgList.length;
    }, 0);
  }, [products]);

  const allSupplierMediaCount = useMemo(() => {
    return suppliers.reduce((acc, s) => acc + getSupplierMedia(s).length, 0);
  }, [suppliers]);

  const filteredProducts = useMemo(() => {
    return products.filter((p) => {
      const imgList = Array.isArray(p.images) && p.images.length > 0
        ? p.images
        : (p.image_url ? [p.image_url] : []);
      if (imgList.length === 0) return false;

      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const codeMatch = (p.product_code || "").toLowerCase().includes(q);
        const nameMatch = (p.product_name_tally || p.product_name || "").toLowerCase().includes(q);
        if (!codeMatch && !nameMatch) return false;
      }
      return true;
    });
  }, [products, search]);

  const filteredSuppliers = useMemo(() => {
    return suppliers.filter((s) => {
      const media = getSupplierMedia(s);
      if (media.length === 0) return false;

      if (search.trim()) {
        const q = search.toLowerCase().trim();
        const nameMatch = (s.company_name || "").toLowerCase().includes(q);
        const remarkMatch = (s.visit_remarks || "").toLowerCase().includes(q);
        if (!nameMatch && !remarkMatch) return false;
      }
      return true;
    });
  }, [suppliers, search]);

  const scopedSubCategories = useMemo(() => {
    if (!categoryFilter) return subCategories.items;
    return subCategories.items.filter((sc) => sc.category_id === categoryFilter);
  }, [subCategories.items, categoryFilter]);

  const p = selectedProduct;
  const prodBrand = p ? brands.items.find((b) => b.id === p.brand_id) : null;
  const prodCat = p ? categories.items.find((c) => c.id === p.category_id) : null;
  const prodSubCat = p ? subCategories.items.find((sc) => sc.id === p.sub_category_id) : null;
  const prodHsn = p ? hsnCodes.items.find((h) => h.id === p.hsn_id) : null;
  const prodUom = p ? uoms.items.find((u) => u.id === p.uom_id) : null;

  const supp = selectedSupplier;
  const suppMedia = supp ? getSupplierMedia(supp) : [];
  const suppCountry = supp ? countries.items.find((c) => c.id === supp.country_id)?.name : null;
  const suppCity = supp ? cities.items.find((c) => c.id === supp.city_id)?.name : null;

  const toggleMediaIndexSelection = (idx: number) => {
    setSelectedMediaIndices((prev) =>
      prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]
    );
  };

  return (
    <AppShell activeKey="product-gallery">
      <main className="page">
        <Breadcrumb trail={["Inventory", "Product & Supplier Gallery"]} />

        <div className="page-header" style={{ marginBottom: "20px" }}>
          <div>
            <h1>Product &amp; Supplier Gallery</h1>
            <div className="page-subtitle">
              Visual catalog of product images and supplier factory/office visit media.
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "12px", marginBottom: "20px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn"
            onClick={() => setGalleryTab("all")}
            style={{
              background: galleryTab === "all" ? "#0061f2" : "#ffffff",
              color: galleryTab === "all" ? "#ffffff" : "#475569",
              border: galleryTab === "all" ? "none" : "1px solid #cbd5e0",
              borderRadius: "6px",
              padding: "8px 16px",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
            }}
          >
            🌐 All Combined Media ({allProductMediaCount + allSupplierMediaCount})
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setGalleryTab("products")}
            style={{
              background: galleryTab === "products" ? "#0061f2" : "#ffffff",
              color: galleryTab === "products" ? "#ffffff" : "#475569",
              border: galleryTab === "products" ? "none" : "1px solid #cbd5e0",
              borderRadius: "6px",
              padding: "8px 16px",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
            }}
          >
            📦 Product Photos ({allProductMediaCount})
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setGalleryTab("suppliers")}
            style={{
              background: galleryTab === "suppliers" ? "#0061f2" : "#ffffff",
              color: galleryTab === "suppliers" ? "#ffffff" : "#475569",
              border: galleryTab === "suppliers" ? "none" : "1px solid #cbd5e0",
              borderRadius: "6px",
              padding: "8px 16px",
              fontWeight: 600,
              fontSize: "13.5px",
              cursor: "pointer",
            }}
          >
            🏭 Supplier Visit Photos ({allSupplierMediaCount})
          </button>
        </div>

        <div
          className="card"
          style={{
            padding: "16px",
            marginBottom: "24px",
            display: "flex",
            gap: "14px",
            flexWrap: "wrap",
            alignItems: "center",
            background: "#ffffff",
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
            {scopedSubCategories.map((sc: ProductSubCategory) => (
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
          <ProductGallerySkeletonGrid count={12} />
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
              filteredProducts.map((prod: Product) => {
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
                      setSelectedMediaIndices([]);
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

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px" }}>
                        {prod.refund_vat_percent != null ? (
                          <div style={{ fontSize: "12px", color: "#16a34a", fontWeight: 600 }}>
                            Refund VAT: {prod.refund_vat_percent}%
                          </div>
                        ) : <div />}

                        {imgList.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadAllMediaFiles(imgList, `product_${prod.product_code || prod.product_name || "item"}`);
                            }}
                            style={{
                              background: "#0061f2",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "6px",
                              padding: "4px 10px",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                              transition: "all 0.15s ease",
                            }}
                            title={`Download all ${imgList.length} media file(s) directly`}
                          >
                            📥 Download ({imgList.length})
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

            {(galleryTab === "all" || galleryTab === "suppliers") &&
              filteredSuppliers.map((supp: Supplier) => {
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
                      setSelectedMediaIndices([]);
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
                          <div style={{ fontSize: "12px", marginTop: "4px", fontWeight: 500 }}>No Visit Photos</div>
                        </div>
                      )}

                      <span
                        style={{
                          position: "absolute",
                          top: "10px",
                          left: "10px",
                          background: "#0284c7",
                          color: "#ffffff",
                          fontSize: "11px",
                          fontWeight: 600,
                          padding: "3px 8px",
                          borderRadius: "4px",
                        }}
                      >
                        SUPPLIER VISIT
                      </span>

                      {sMedia.length > 0 && (
                        <span
                          style={{
                            position: "absolute",
                            bottom: "10px",
                            right: "10px",
                            background: "rgba(2, 132, 199, 0.9)",
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
                          {firstIsVideo ? "🎬" : "📷"} {sMedia.length} Photos
                        </span>
                      )}
                    </div>

                    <div style={{ padding: "14px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
                      <div>
                        <h4
                          style={{
                            margin: "0 0 4px 0",
                            fontSize: "14px",
                            fontWeight: 600,
                            color: "#0369a1",
                            lineHeight: "1.3",
                          }}
                        >
                          {supp.company_name}
                        </h4>
                        <div style={{ fontSize: "12px", color: "#475569", display: "flex", gap: "6px", flexWrap: "wrap", marginTop: "4px" }}>
                          {(sCity || sCountry) && <span>📍 {[sCity, sCountry].filter(Boolean).join(", ")}</span>}
                        </div>
                      </div>

                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "10px" }}>
                        <div style={{ fontSize: "11.5px", color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "120px" }}>
                          {supp.visit_remarks ? `💬 ${supp.visit_remarks}` : ""}
                        </div>
                        {sMedia.length > 0 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadAllMediaFiles(sMedia, `supplier_visit_${supp.company_name.replace(/[^a-zA-Z0-9]/g, "_")}`);
                            }}
                            style={{
                              background: "#0284c7",
                              color: "#ffffff",
                              border: "none",
                              borderRadius: "6px",
                              padding: "4px 10px",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "4px",
                              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                              transition: "all 0.15s ease",
                            }}
                            title={`Download all ${sMedia.length} visit media file(s) directly`}
                          >
                            📥 Download ({sMedia.length})
                          </button>
                        )}
                      </div>
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

            await guardPhotoDelete(`${p.id}:${indexToDelete}`, async () => {
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
                setSelectedMediaIndices([]);
              } catch (err) {
                console.error("Failed to delete media:", err);
                alert("Failed to delete media. Please try again.");
              }
            });
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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", padding: "0 4px", flexWrap: "wrap", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>
                      Media {selectedImageIndex + 1} of {detailImgList.length} {activeIsVideo ? "(Video)" : "(Photo)"}
                    </span>

                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                      {selectedMediaIndices.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            const selectedUrls = selectedMediaIndices.map((idx) => detailImgList[idx]).filter(Boolean);
                            downloadAllMediaFiles(selectedUrls, `product_${p.product_code || "selected"}`);
                          }}
                          style={{
                            background: "#16a34a",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                          }}
                          title="Download all checked photos"
                        >
                          📥 Download Selected ({selectedMediaIndices.length})
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => downloadAllMediaFiles(detailImgList, `product_${p.product_code || "all"}`)}
                          style={{
                            background: "#2563eb",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                          }}
                          title="Download all photos at once"
                        >
                          📦 Download All ({detailImgList.length})
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => downloadMediaFile(activeMedia, `product_${p.product_code || "media"}`, selectedImageIndex + 1)}
                        style={{
                          background: "#eff6ff",
                          color: "#2563eb",
                          border: "1px solid #93c5fd",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                        title={`Download ${activeIsVideo ? "video" : "photo"}`}
                      >
                        📥 Active Only
                      </button>

                      {canDeleteProductMedia && (
                        <button
                          type="button"
                          onClick={() => handleDeletePhoto(selectedImageIndex)}
                          disabled={isPhotoDeletePending(`${p.id}:${selectedImageIndex}`)}
                          style={{
                            background: "#fee2e2",
                            color: "#dc2626",
                            border: "1px solid #fca5a5",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: isPhotoDeletePending(`${p.id}:${selectedImageIndex}`) ? "default" : "pointer",
                            opacity: isPhotoDeletePending(`${p.id}:${selectedImageIndex}`) ? 0.6 : 1,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                          title="Delete this media from product"
                        >
                          {isPhotoDeletePending(`${p.id}:${selectedImageIndex}`) ? "Deleting…" : "🗑️ Delete"}
                        </button>
                      )}
                    </div>
                  </div>

                  {detailImgList.length > 1 && (
                    <div style={{ marginTop: "14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "11.5px", color: "#64748b", fontWeight: 600 }}>
                          Thumbnails (Check boxes to select multiple for batch download):
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedMediaIndices.length === detailImgList.length) {
                              setSelectedMediaIndices([]);
                            } else {
                              setSelectedMediaIndices(detailImgList.map((_, i) => i));
                            }
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#2563eb",
                            fontSize: "11.5px",
                            fontWeight: 600,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          {selectedMediaIndices.length === detailImgList.length ? "Deselect All" : "Select All"}
                        </button>
                      </div>

                      <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
                        {detailImgList.map((imgUri, idx) => {
                          const isChecked = selectedMediaIndices.includes(idx);
                          return (
                            <div
                              key={idx}
                              style={{ position: "relative", display: "inline-block" }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  toggleMediaIndexSelection(idx);
                                }}
                                style={{
                                  position: "absolute",
                                  top: "4px",
                                  right: "4px",
                                  zIndex: 10,
                                  cursor: "pointer",
                                  width: "16px",
                                  height: "16px",
                                  accentColor: "#2563eb",
                                }}
                                title="Select photo for batch download"
                              />

                              {isVideoUrl(imgUri) ? (
                                <div
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
                                    transform: idx === selectedImageIndex ? "scale(1.06)" : "scale(1)",
                                    transition: "all 0.15s ease",
                                  }}
                                >
                                  🎬
                                </div>
                              ) : (
                                <img
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
                                    transform: idx === selectedImageIndex ? "scale(1.06)" : "scale(1)",
                                    transition: "all 0.15s ease",
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
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
          const suppFolderLinks = getSupplierFolderLinks(supp);
          const activeSuppMedia = suppMedia[selectedImageIndex] || suppMedia[0];
          const activeSuppIsVideo = isVideoUrl(activeSuppMedia);

          const handleDeleteSupplierPhoto = async (indexToDelete: number) => {
            if (!supp) return;
            if (!window.confirm("Are you sure you want to delete this visit photo from the supplier?")) return;

            const photoToDelete = suppMedia[indexToDelete];
            if (!photoToDelete) return;

            let rawAll: string[] = [];
            if (Array.isArray(supp.visit_media)) {
              rawAll = supp.visit_media.map(String);
            } else if (typeof supp.visit_media === "string") {
              try {
                const parsed = JSON.parse(supp.visit_media);
                rawAll = Array.isArray(parsed) ? parsed.map(String) : [supp.visit_media];
              } catch {
                rawAll = (supp.visit_media as string).split(",");
              }
            }

            const updatedRaw = rawAll
              .map((s) => s.trim())
              .filter((s) => Boolean(s) && s !== photoToDelete);

            await guardPhotoDelete(`supp:${supp.id}:${indexToDelete}`, async () => {
              try {
                const updatedPayload = {
                  visit_media: updatedRaw.length ? updatedRaw : null,
                };
                await apiPatch<Supplier>(`/suppliers/${supp.id}`, updatedPayload);

                const newSuppObj: Supplier = {
                  ...supp,
                  visit_media: updatedRaw.length ? updatedRaw : undefined,
                };

                setSuppliers((prev) =>
                  prev.map((s) => (s.id === supp.id ? newSuppObj : s))
                );
                setSelectedSupplier(newSuppObj);
                setSelectedImageIndex(0);
                setSelectedMediaIndices([]);
              } catch (err) {
                console.error("Failed to delete supplier visit photo:", err);
                alert("Failed to delete visit photo. Please try again.");
              }
            });
          };

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
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "12px", padding: "0 4px", flexWrap: "wrap", gap: "8px" }}>
                    <span style={{ fontSize: "12px", color: "#0369a1", fontWeight: 600 }}>
                      Visit Media {selectedImageIndex + 1} of {suppMedia.length} {activeSuppIsVideo ? "(Video)" : "(Image)"}
                    </span>

                    <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
                      {selectedMediaIndices.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => {
                            const selectedUrls = selectedMediaIndices.map((idx) => suppMedia[idx]).filter(Boolean);
                            downloadAllMediaFiles(selectedUrls, `supplier_visit_${supp.company_name.replace(/[^a-zA-Z0-9]/g, "_")}`);
                          }}
                          style={{
                            background: "#16a34a",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                          }}
                          title="Download all checked visit media"
                        >
                          📥 Download Selected ({selectedMediaIndices.length})
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => downloadAllMediaFiles(suppMedia, `supplier_visit_${supp.company_name.replace(/[^a-zA-Z0-9]/g, "_")}`)}
                          style={{
                            background: "#0284c7",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: "pointer",
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                            boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                          }}
                          title="Download all visit media at once"
                        >
                          📦 Download All ({suppMedia.length})
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => downloadMediaFile(activeSuppMedia, `supplier_visit_${supp.company_name.replace(/[^a-zA-Z0-9]/g, "_")}`, selectedImageIndex + 1)}
                        style={{
                          background: "#e0f2fe",
                          color: "#0369a1",
                          border: "1px solid #7dd3fc",
                          borderRadius: "6px",
                          padding: "4px 10px",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                        }}
                        title={`Download ${activeSuppIsVideo ? "video" : "photo"}`}
                      >
                        📥 Active Only
                      </button>

                      {canDeleteSupplierMedia && (
                        <button
                          type="button"
                          onClick={() => handleDeleteSupplierPhoto(selectedImageIndex)}
                          disabled={isPhotoDeletePending(`supp:${supp.id}:${selectedImageIndex}`)}
                          style={{
                            background: "#fee2e2",
                            color: "#dc2626",
                            border: "1px solid #fca5a5",
                            borderRadius: "6px",
                            padding: "4px 10px",
                            fontSize: "12px",
                            fontWeight: 600,
                            cursor: isPhotoDeletePending(`supp:${supp.id}:${selectedImageIndex}`) ? "default" : "pointer",
                            opacity: isPhotoDeletePending(`supp:${supp.id}:${selectedImageIndex}`) ? 0.6 : 1,
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "4px",
                          }}
                          title="Delete this visit photo from supplier"
                        >
                          {isPhotoDeletePending(`supp:${supp.id}:${selectedImageIndex}`) ? "Deleting…" : "🗑️ Delete"}
                        </button>
                      )}
                    </div>
                  </div>

                  {suppMedia.length > 1 && (
                    <div style={{ marginTop: "14px" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                        <span style={{ fontSize: "11.5px", color: "#0369a1", fontWeight: 600 }}>
                          Thumbnails (Check boxes to select multiple for batch download):
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedMediaIndices.length === suppMedia.length) {
                              setSelectedMediaIndices([]);
                            } else {
                              setSelectedMediaIndices(suppMedia.map((_, i) => i));
                            }
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#0284c7",
                            fontSize: "11.5px",
                            fontWeight: 600,
                            cursor: "pointer",
                            padding: 0,
                          }}
                        >
                          {selectedMediaIndices.length === suppMedia.length ? "Deselect All" : "Select All"}
                        </button>
                      </div>

                      <div style={{ display: "flex", gap: "10px", justifyContent: "center", flexWrap: "wrap" }}>
                        {suppMedia.map((imgUri, idx) => {
                          const isChecked = selectedMediaIndices.includes(idx);
                          return (
                            <div
                              key={idx}
                              style={{ position: "relative", display: "inline-block" }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  toggleMediaIndexSelection(idx);
                                }}
                                style={{
                                  position: "absolute",
                                  top: "4px",
                                  right: "4px",
                                  zIndex: 10,
                                  cursor: "pointer",
                                  width: "16px",
                                  height: "16px",
                                  accentColor: "#0284c7",
                                }}
                                title="Select photo for batch download"
                              />

                              {isVideoUrl(imgUri) ? (
                                <div
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
                                    transform: idx === selectedImageIndex ? "scale(1.06)" : "scale(1)",
                                    transition: "all 0.15s ease",
                                  }}
                                >
                                  🎬
                                </div>
                              ) : (
                                <img
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
                                    transform: idx === selectedImageIndex ? "scale(1.06)" : "scale(1)",
                                    transition: "all 0.15s ease",
                                  }}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
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
                  ...(suppFolderLinks.length > 0
                    ? [
                      {
                        label: "Factory Video / Inspection Folder Link",
                        value: (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginTop: "4px" }}>
                            {suppFolderLinks.map((link, idx) => (
                              <a
                                key={idx}
                                href={link.startsWith("http") ? link : `https://${link}`}
                                target="_blank"
                                rel="noreferrer"
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "6px",
                                  padding: "6px 12px",
                                  background: "#eff6ff",
                                  border: "1px solid #bfdbfe",
                                  borderRadius: "6px",
                                  color: "#1d4ed8",
                                  fontSize: "12.5px",
                                  fontWeight: 600,
                                  textDecoration: "none",
                                  boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
                                }}
                              >
                                📁 Open Inspection Folder / Link ({idx + 1}) ↗
                              </a>
                            ))}
                          </div>
                        ),
                        fullWidth: true,
                      },
                    ]
                    : []),
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