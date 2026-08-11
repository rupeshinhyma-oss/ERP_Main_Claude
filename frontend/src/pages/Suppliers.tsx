/**
 * Supplier Profiles. Ported from suppliers.html + suppliers.js.
 *
 * Implements the list view (top filter fields, truncated multi-value columns
 * with a "+N more" expander, inline editable Grade/Potential dropdowns) and the
 * two-step First-Data-Form / Main-Profile creation flow, plus the Contacts
 * sub-panel.
 *
 * Country/State/City/Category/Sub-Category/Product selectors are all type-ahead
 * rather than pre-loaded <select> lists: Cities alone can realistically reach
 * tens of thousands of rows, and a browser <select> with that many options is
 * both slow to render and unusable to scroll. Table-column name lookups use a
 * bounded NameResolver that only resolves the IDs on the current page of
 * results, not the full related tables.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, ModalAlert, TableMessageRow } from "@/components/ui";
import { SideDrawer, DetailFieldGrid } from "@/components/SideDrawer";
import { Pagination } from "@/components/Pagination";
import { ImpExpDropdown, BulkActionsDropdown, ImportSummaryPanel } from "@/components/ImportWizard";
import {
  SearchableDropdown,
  SearchableDropdownMultiPanel,
  type DropdownOption,
} from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField, autoTitleCase } from "@/components/fields";
import { useLookup } from "@/lib/lookups";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPostMultipart,
  downloadExport,
  toQueryString,
} from "@/lib/api";
import { createNameResolver } from "@/lib/nameResolver";
import { useAuth, useSrNoJump, isSrNoQuery } from "@/lib/hooks";
import type {
  ImportHeader,
  ImportSummary,
  PaginationMeta,
  Product,
  Supplier,
  SupplierContact,
} from "@/types";

/** Document rule: show 5 chips inline, the rest behind a "+N more" expander. */
/** Import field list for Suppliers, shared by the Import Wizard button and the Sample Template downloader so the two can never drift apart. */
const SUPPLIER_IMPORT_HEADERS: ImportHeader[] = [
  { key: "company_name", label: "Company Name", required: true },
  { key: "supplier_type", label: "Supplier Type (manufacturer/trader)" },
  { key: "brand_description", label: "Brand Description" },
  { key: "country_code", label: "Country Code", required: true },
  { key: "state_name", label: "State/Province Name", required: true },
  { key: "city_name", label: "City Name", required: true },
  { key: "contact_salutation", label: "Contact Salutation" },
  { key: "contact_full_name", label: "Contact Full Name" },
  { key: "contact_designation", label: "Contact Designation" },
  { key: "contact_calling_number", label: "Contact Calling Number" },
  { key: "contact_whatsapp_number", label: "Contact WhatsApp Number" },
  { key: "contact_wechat_number", label: "Contact WeChat Number" },
  { key: "email", label: "Email" },
  { key: "tax_id_number", label: "Tax ID Number" },
  { key: "address", label: "Address" },
  { key: "town", label: "Town" },
  { key: "primary_website", label: "Primary Website" },
  { key: "secondary_website", label: "Secondary Website" },
  { key: "supplier_grade", label: "Supplier Grade (A/B/C)" },
  { key: "current_status", label: "Current Status (new/existing)" },
  { key: "potential", label: "Potential (yes/no)" },
  { key: "potential_reason", label: "Potential Reason" },
  { key: "secondary_products_description", label: "Secondary Products Description" },
  { key: "visited_factory_office", label: "Visited Factory/Office (true/false)" },
  { key: "visit_remarks", label: "Visit Remarks" },
  { key: "overall_remarks", label: "Overall Remarks" },
  { key: "is_active", label: "Is Active (true/false)" },
];

type ModalTab = "first" | "second" | "contacts" | "continue";

const EMPTY_SUPPLIER_FORM = {
  company_name: "",
  supplier_type: "",
  brand_description: "",
  contact_salutation: "",
  contact_full_name: "",
  contact_designation: "",
  contact_calling_number: "",
  contact_whatsapp_number: "",
  contact_wechat_number: "",
  emails_input: "",
  tax_id_number: "",
  town: "",
  primary_website: "",
  secondary_website: "",
  supplier_grade: "",
  current_status: "",
  potential: "",
  potential_reason: "",
  secondary_products_description: "",
  visited_factory_office: "false",
  visit_remarks: "",
  visit_media_input: "",
  overall_remarks: "",
  is_active: "true",
};

const EMPTY_CONTACT_FORM = {
  id: "",
  salutation: "",
  person_name: "",
  designation: "",
  handling_territory: "",
  calling_number: "",
  whatsapp_number: "",
  wechat_number: "",
  email: "",
};

/** Positive-sounding values read as active; everything else is neutral. */
function StatusPill({ value }: { value?: string | null }) {
  if (!value) return <span className="badge badge-neutral">Select</span>;
  const isPositive = value === "existing" || value === "yes" || value === "active";
  const cls = isPositive ? "badge-active" : "badge-neutral";
  const label =
    value === "existing"
      ? "Existing"
      : value === "new"
        ? "New"
        : value === "yes"
          ? "Yes"
          : value === "no"
            ? "No"
            : value;
  return <span className={`badge ${cls}`}>{label}</span>;
}

function validatePhoneNumber(val: string): string | null {
  if (!val.trim()) return null;
  const digits = val.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return "Phone number must have between 7 and 15 digits.";
  }
  return null;
}

export function SuppliersPage() {
  const { hasPermission } = useAuth();
  const canCreate = hasPermission("supplier.create");
  const canUpdate = hasPermission("supplier.update");
  const canDelete = hasPermission("supplier.delete");

  const [rows, setRows] = useState<Supplier[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [namesVersion, setNamesVersion] = useState(0);

  const [searchInput, setSearchInput] = useState("");
  const [effectiveSearch, setEffectiveSearch] = useState("");
  const srNoJump = useSrNoJump();
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);

  /* Filters */
  const [filterOpen, setFilterOpen] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [subCategoryFilter, setSubCategoryFilter] = useState<string | null>(null);
  const [productFilter, setProductFilter] = useState<string | null>(null);
  const [countryFilter, setCountryFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<string | null>(null);
  const [cityFilter, setCityFilter] = useState<string | null>(null);
  const [supplierTypeFilter, setSupplierTypeFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [potentialFilter, setPotentialFilter] = useState("");
  const [visitedFilter, setVisitedFilter] = useState("");

  const handleResetFilters = () => {
    setCategoryFilter(null);
    setSubCategoryFilter(null);
    setProductFilter(null);
    setCountryFilter(null);
    setStateFilter(null);
    setCityFilter(null);
    setSupplierTypeFilter("");
    setGradeFilter("");
    setStatusFilter("");
    setPotentialFilter("");
    setVisitedFilter("");
    setCurrentPage(1);
  };

  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [alertPopup, setAlertPopup] = useState<{ title: string; message: string } | null>(null);
  const [drawerSupplier, setDrawerSupplier] = useState<Supplier | null>(null);
  const [pinnedCols, setPinnedCols] = useState<Record<number, "left" | "right">>({ 0: "left", 1: "left", 2: "left" });
  const [colLeftOffsets, setColLeftOffsets] = useState<Record<number, number>>({});
  const [colRightOffsets, setColRightOffsets] = useState<Record<number, number>>({});
  const [pinMenuOpen, setPinMenuOpen] = useState(false);
  const pinMenuRef = useRef<HTMLDivElement>(null);

  const tableRef = useRef<HTMLTableElement>(null);

  // Close popup menu when clicking outside anywhere on screen
  useEffect(() => {
    if (!pinMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (pinMenuRef.current && !pinMenuRef.current.contains(e.target as Node)) {
        setPinMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [pinMenuOpen]);

  const togglePin = useCallback((colIdx: number) => {
    setPinnedCols((prev) => {
      const next = { ...prev };
      if (next[colIdx]) {
        delete next[colIdx];
      } else {
        if (colIdx >= 13) {
          next[colIdx] = "right";
        } else {
          next[colIdx] = "left";
        }
      }
      return next;
    });
  }, []);

  const displayOrder = useMemo(() => {
    const allIndices = Array.from({ length: 15 }, (_, i) => i);
    const lefts = allIndices.filter((idx) => pinnedCols[idx] === "left");
    const unpinned = allIndices.filter((idx) => !pinnedCols[idx]);
    const rights = allIndices.filter((idx) => pinnedCols[idx] === "right");
    return [...lefts, ...unpinned, ...rights];
  }, [pinnedCols]);

  useLayoutEffect(() => {
    if (!tableRef.current) return;
    const tableEl = tableRef.current;

    const updateOffsets = () => {
      const ths = tableEl.querySelectorAll("thead th");
      if (!ths.length) return;

      const lefts = displayOrder.filter((idx) => pinnedCols[idx] === "left");
      let accumLeft = 0;
      const nextLefts: Record<number, number> = {};
      for (const idx of lefts) {
        const thPos = displayOrder.indexOf(idx);
        if (ths[thPos]) {
          nextLefts[idx] = accumLeft;
          accumLeft += (ths[thPos] as HTMLElement).offsetWidth;
        }
      }

      const rights = displayOrder.filter((idx) => pinnedCols[idx] === "right").reverse();
      let accumRight = 0;
      const nextRights: Record<number, number> = {};
      for (const idx of rights) {
        const thPos = displayOrder.indexOf(idx);
        if (ths[thPos]) {
          nextRights[idx] = accumRight;
          accumRight += (ths[thPos] as HTMLElement).offsetWidth;
        }
      }

      setColLeftOffsets(nextLefts);
      setColRightOffsets(nextRights);
    };

    updateOffsets();

    const ro = new ResizeObserver(() => updateOffsets());
    ro.observe(tableEl);
    return () => ro.disconnect();
  }, [pinnedCols, rows, loading, displayOrder]);

  const getFreezeStyle = useCallback((colIdx: number, isHeader = false): React.CSSProperties => {
    const dir = pinnedCols[colIdx];
    if (!dir) return {};

    const lefts = displayOrder.filter((idx) => pinnedCols[idx] === "left");
    const rights = displayOrder.filter((idx) => pinnedCols[idx] === "right");

    const isLastLeft = dir === "left" && colIdx === lefts[lefts.length - 1];
    const isFirstRight = dir === "right" && colIdx === rights[0];

    if (dir === "left") {
      const left = colLeftOffsets[colIdx] ?? 0;
      return {
        position: "sticky",
        left: `${left}px`,
        zIndex: isHeader ? 12 : 10,
        backgroundColor: isHeader ? "#f8fafc" : "#ffffff",
        boxShadow: isLastLeft ? "3px 0 6px -2px rgba(0, 0, 0, 0.15)" : "none",
        borderRight: isLastLeft ? "2px solid #cbd5e1" : undefined,
      };
    }

    const right = colRightOffsets[colIdx] ?? 0;
    return {
      position: "sticky",
      right: `${right}px`,
      zIndex: isHeader ? 12 : 10,
      backgroundColor: isHeader ? "#f8fafc" : "#ffffff",
      boxShadow: isFirstRight ? "-3px 0 6px -2px rgba(0, 0, 0, 0.15)" : "none",
      borderLeft: isFirstRight ? "2px solid #cbd5e1" : undefined,
    };
  }, [pinnedCols, colLeftOffsets, colRightOffsets, displayOrder]);





  /* Modal state */
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<"quick" | "full">("full");
  const [modalTab, setModalTab] = useState<ModalTab>("first");
  const [currentSupplierId, setCurrentSupplierId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_SUPPLIER_FORM);
  const [formCountryId, setFormCountryId] = useState<string | null>(null);
  const [formStateId, setFormStateId] = useState<string | null>(null);
  const [formCityId, setFormCityId] = useState<string | null>(null);
  const [formCategoryIds, setFormCategoryIds] = useState<string[]>([]);
  const [formSubCategoryIds, setFormSubCategoryIds] = useState<string[]>([]);
  const [formProductIds, setFormProductIds] = useState<string[]>([]);
  const [lockNewStatus, setLockNewStatus] = useState(false);
  const [formStateCustomText, setFormStateCustomText] = useState("");
  const [formCityCustomText, setFormCityCustomText] = useState("");
  const [whatsappSameAsCalling, setWhatsappSameAsCalling] = useState(false);
  const [wechatSameAsCalling, setWechatSameAsCalling] = useState(false);
  const [callingNumberError, setCallingNumberError] = useState<string | null>(null);
  const [defaultChinaId, setDefaultChinaId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const existingSuppliers = useLookup<Supplier>("/suppliers", 500);

  const mediaList = useMemo(() => {
    return form.visit_media_input
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
  }, [form.visit_media_input]);

  const addMediaUrls = (newUrls: string[]) => {
    const combined = [...mediaList, ...newUrls];
    const unique = Array.from(new Set(combined));
    setField("visit_media_input", unique.join(", "));
  };

  const removeMediaUrl = (urlToRemove: string) => {
    const filtered = mediaList.filter((u) => u !== urlToRemove);
    setField("visit_media_input", filtered.join(", "));
  };

  const handleMediaFileUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploadingMedia(true);
    const uploadedUrls: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const formData = new FormData();
        formData.append("file", file);
        const res = await apiPostMultipart<{ url: string }>("/suppliers/upload-media", formData);
        if (res.data?.url) {
          uploadedUrls.push(res.data.url);
        }
      } catch (err) {
        console.warn("Failed to upload media to Supabase storage:", err);
      }
    }

    if (uploadedUrls.length > 0) {
      addMediaUrls(uploadedUrls);
    }
    setUploadingMedia(false);
  };

  const fetchChinaId = useCallback(async (): Promise<string | null> => {
    try {
      const { data } = await apiGet<{ id: string; name: string }[]>(
        "/masters/countries" +
          toQueryString({
            search: "China",
            page: 1,
            page_size: 20,
            sort_order: "asc",
            status: "active",
          })
      );
      const china = (data || []).find((c) => c.name.toLowerCase().includes("china"));
      if (china) return china.id;

      // Fallback: list all countries
      const { data: allData } = await apiGet<{ id: string; name: string }[]>(
        "/masters/countries" + toQueryString({ page: 1, page_size: 250, sort_order: "asc", status: "active" })
      );
      const foundInAll = (allData || []).find((c) => c.name.toLowerCase().includes("china"));
      if (foundInAll) return foundInAll.id;
    } catch (err) {
      console.error("Failed to fetch China ID:", err);
    }
    return null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchChinaId().then((id) => {
      if (!cancelled && id) setDefaultChinaId(id);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchChinaId]);

  /* Tabs & Contacts State */
  const [editTab, setEditTab] = useState<"profile" | "contacts">("profile");
  const [contacts, setContacts] = useState<SupplierContact[]>([]);
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM);
  const [contactCountryId, setContactCountryId] = useState<string | null>(null);
  const [contactPhoneCode, setContactPhoneCode] = useState<string>("");
  const [contactSameCallingWhatsapp, setContactSameCallingWhatsapp] = useState(false);
  const [contactSameCallingWechat, setContactSameCallingWechat] = useState(false);
  const [drawerError, setDrawerError] = useState<unknown>(null);
  const [contactSubmitting, setContactSubmitting] = useState(false);

  useEffect(() => {
    if (!contactCountryId) {
      setContactPhoneCode("");
      return;
    }
    let cancelled = false;
    apiGet<{ phone_code?: string | null }>(`/masters/countries/${contactCountryId}`)
      .then(({ data }) => {
        if (!cancelled) {
          const code = data.phone_code ? (data.phone_code.startsWith("+") ? data.phone_code : `+${data.phone_code}`) : "";
          setContactPhoneCode(code);
        }
      })
      .catch(() => {
        if (!cancelled) setContactPhoneCode("");
      });
    return () => {
      cancelled = true;
    };
  }, [contactCountryId]);

  const setField = (id: keyof typeof EMPTY_SUPPLIER_FORM, value: string) => {
    const formatted = autoTitleCase(value, id as string);
    setForm((prev) => ({ ...prev, [id]: formatted }));
  };

  /* --- Bounded name resolver for the chip columns --- */
  const resolver = useMemo(() => {
    const fetchNamesByIds = async (
      apiBase: string,
      ids: string[],
      labelFn?: (d: Record<string, unknown>) => string
    ): Promise<[string, string][]> => {
      const results = await Promise.all(
        ids.map(async (id): Promise<[string, string | null]> => {
          try {
            const { data } = await apiGet<Record<string, unknown>>(`${apiBase}/${id}`);
            return [id, labelFn ? labelFn(data) : (data.name as string)];
          } catch {
            return [id, null];
          }
        })
      );
      return results.filter((pair): pair is [string, string] => pair[1] !== null);
    };

    return createNameResolver({
      countries: (ids) => fetchNamesByIds("/masters/countries", ids),
      states: (ids) => fetchNamesByIds("/masters/states", ids),
      cities: (ids) => fetchNamesByIds("/masters/cities", ids),
      categories: (ids) => fetchNamesByIds("/masters/product-categories", ids),
      subCategories: (ids) => fetchNamesByIds("/masters/product-sub-categories", ids),
      products: (ids) =>
        fetchNamesByIds("/masters/products", ids, (d) => d.product_name as string),
    });
  }, []);

  /* --- Type-ahead fetchers --- */
  const searchFetcher = useCallback(
    (apiBase: string, extraParams?: () => Record<string, string>) =>
      async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
        const extra = extraParams ? extraParams() : {};
        const { data } = await apiGet<{ id: string; name: string }[]>(
          apiBase +
            toQueryString({
              search: term,
              page: 1,
              page_size: 20,
              sort_order: "asc",
              status: "active",
              ...extra,
            }),
          { signal }
        );
        return data.map((d) => ({ value: d.id, label: d.name }));
      },
    []
  );

  const companyNameFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      const { data } = await apiGet<Supplier[]>(
        "/suppliers" + toQueryString({ search: term, page: 1, page_size: 20 }),
        { signal }
      );
      return data.map((d) => ({ value: d.company_name, label: d.company_name }));
    },
    []
  );

  function validateCallingNumber(val: string) {
    if (!val || !val.trim()) {
      setCallingNumberError(null);
      return true;
    }
    const digitsOnly = val.replace(/\D/g, "");
    if (digitsOnly.length < 7 || digitsOnly.length > 11) {
      setCallingNumberError("Calling number must be between 7 and 11 digits.");
      return false;
    }
    setCallingNumberError(null);
    return true;
  }

  const productFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      const { data } = await apiGet<Product[]>(
        "/masters/products" +
          toQueryString({
            search: term,
            page: 1,
            page_size: 20,
            sort_order: "asc",
            status: "active",
          }),
        { signal }
      );
      return data.map((d) => ({
        value: d.id,
        label: `${d.product_code} — ${d.product_name}`,
      }));
    },
    []
  );

  const fetchNameLabel = useCallback(
    (apiBase: string) => async (id: string) => {
      const { data } = await apiGet<{ name: string }>(`${apiBase}/${id}`);
      return data.name;
    },
    []
  );

  const fetchProductLabel = useCallback(async (id: string) => {
    const { data } = await apiGet<Product>(`/masters/products/${id}`);
    return `${data.product_code} — ${data.product_name}`;
  }, []);

  /* --- Search debounce with Sr. No. jump --- */
  useEffect(() => {
    const timer = setTimeout(() => {
      const raw = searchInput.trim();
      if (raw && isSrNoQuery(raw)) {
        const srNo = parseInt(raw, 10);
        if (srNo >= 1) {
          setCurrentPage(Math.ceil(srNo / pageSize));
          setEffectiveSearch("");
          srNoJump.request(srNo);
          return;
        }
      }
      srNoJump.clear();
      setCurrentPage(1);
      setEffectiveSearch(raw);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput, pageSize]);

  /* --- List load --- */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const params = {
        page: currentPage,
        page_size: pageSize,
        sort_order: "asc",
        search: effectiveSearch,
        country_id: countryFilter || "",
        state_id: stateFilter || "",
        city_id: cityFilter || "",
        supplier_type: supplierTypeFilter,
        supplier_grade: gradeFilter,
        current_status: statusFilter,
        potential: potentialFilter,
        visited_factory_office: visitedFilter,
        category_id: categoryFilter || "",
        sub_category_id: subCategoryFilter || "",
        product_id: productFilter || "",
      };
      try {
        const { data, meta } = await apiGet<Supplier[]>("/suppliers" + toQueryString(params));
        if (cancelled) return;
        const items = data || [];
        if (items.length) {
          // Resolve every related name needed for this page's rows only.
          await Promise.all([
            resolver.resolve("countries", items.map((s) => s.country_id)),
            resolver.resolve("states", items.map((s) => s.state_id)),
            resolver.resolve("cities", items.map((s) => s.city_id)),
            resolver.resolve("categories", items.flatMap((s) => s.category_ids || [])),
            resolver.resolve("subCategories", items.flatMap((s) => s.sub_category_ids || [])),
            resolver.resolve("products", items.flatMap((s) => s.product_ids || [])),
          ]);
          if (cancelled) return;
          setNamesVersion((n) => n + 1);
        }
        setRows(items);
        setPagination(meta?.pagination);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setRows([]);
        setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    currentPage,
    pageSize,
    effectiveSearch,
    countryFilter,
    stateFilter,
    cityFilter,
    supplierTypeFilter,
    gradeFilter,
    statusFilter,
    potentialFilter,
    visitedFilter,
    categoryFilter,
    subCategoryFilter,
    productFilter,
    reloadCounter,
    resolver,
  ]);

  useEffect(() => {
    if (!loading) srNoJump.applyTo(tableBodyRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows]);

  const reload = () => setReloadCounter((n) => n + 1);

  function renderTruncatedText(text: string | null | undefined, maxLen = 22, modalTitle = "Details") {
    if (!text) return <span className="muted">—</span>;
    const str = text.trim();
    if (str.length <= maxLen) return <span style={{ whiteSpace: "nowrap" }}>{str}</span>;

    const shortText = str.slice(0, maxLen) + "…";
    return (
      <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", whiteSpace: "nowrap" }}>
        <span style={{ maxWidth: "150px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "inline-block" }} title={str}>
          {shortText}
        </span>
        <button
          type="button"
          onClick={() => setAlertPopup({ title: modalTitle, message: str })}
          style={{
            border: "1px solid #cbd5e1",
            background: "#f8fafc",
            color: "#0061f2",
            fontSize: "11px",
            padding: "1px 6px",
            borderRadius: "10px",
            cursor: "pointer",
            fontWeight: 600,
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
          title="Click to view full text 👁️"
        >
          👁️
        </button>
      </span>
    );
  }

  function chipList(ids: string[] | undefined, tableKey: string, modalTitle = "Selected Items") {
    if (!ids || !ids.length) return <span className="muted">—</span>;
    const names = ids.map((id) => resolver.get(tableKey, id) || "…");
    const first = names[0];
    const remaining = names.length - 1;
    return (
      <div className="chip-list" style={{ display: "inline-flex", flexWrap: "nowrap", gap: "4px", alignItems: "center", whiteSpace: "nowrap" }}>
        <span
          className="chip"
          title={first}
          style={{
            maxWidth: "120px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "inline-block",
            verticalAlign: "middle",
          }}
        >
          {first}
        </span>
        {remaining > 0 && (
          <button
            type="button"
            className="chip-more"
            title={names.join(", ")}
            onClick={() => setAlertPopup({ title: modalTitle, message: "• " + names.join("\n• ") })}
            style={{
              fontWeight: 600,
              fontSize: "11px",
              color: "#0061f2",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              borderRadius: "12px",
              padding: "1px 7px",
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            +{remaining} 👁️
          </button>
        )}
      </div>
    );
  }

  /* --- Modal --- */
  async function openModal(supplier: Supplier | null, mode: "quick" | "full" = "full") {
    setCurrentSupplierId(supplier ? supplier.id : null);
    setModalMode(mode);
    setModalTab("first");
    setEditTab("profile");
    setError(null);
    setContactFormOpen(false);
    setWhatsappSameAsCalling(false);
    setWechatSameAsCalling(false);
    setCallingNumberError(null);
    setFormStateCustomText("");
    setFormCityCustomText("");

    if (supplier) {
      setForm({
        company_name: supplier.company_name || "",
        supplier_type: supplier.supplier_type || "",
        brand_description: supplier.brand_description || "",
        contact_salutation: supplier.contact_salutation || "",
        contact_full_name: supplier.contact_full_name || "",
        contact_designation: supplier.contact_designation || "",
        contact_calling_number: supplier.contact_calling_number || "",
        contact_whatsapp_number: supplier.contact_whatsapp_number || "",
        contact_wechat_number: supplier.contact_wechat_number || "",
        emails_input: (supplier.emails || []).join(", "),
        tax_id_number: supplier.tax_id_number || "",
        town: supplier.town || "",
        primary_website: supplier.primary_website || "",
        secondary_website: supplier.secondary_website || "",
        supplier_grade: supplier.supplier_grade || "",
        current_status: supplier.current_status || "",
        potential: supplier.potential || "",
        potential_reason: supplier.potential_reason || "",
        secondary_products_description: supplier.secondary_products_description || "",
        visited_factory_office: String(supplier.visited_factory_office),
        visit_remarks: supplier.visit_remarks || "",
        visit_media_input: supplier.visit_media ? supplier.visit_media.join(", ") : "",
        overall_remarks: supplier.overall_remarks || "",
        is_active: String(supplier.is_active),
      });
      setFormCountryId(supplier.country_id || null);
      setFormStateId(supplier.state_id || null);
      setFormCityId(supplier.city_id || null);
      setFormCategoryIds(supplier.category_ids || []);
      setFormSubCategoryIds(supplier.sub_category_ids || []);
      setFormProductIds(supplier.product_ids || []);
      // Once a supplier is Existing it cannot be reverted to New.
      setLockNewStatus(supplier.current_status === "existing");
      setContacts(supplier.contacts || []);
      if (supplier.contact_calling_number && supplier.contact_whatsapp_number === supplier.contact_calling_number) {
        setWhatsappSameAsCalling(true);
      }
      if (supplier.contact_calling_number && supplier.contact_wechat_number === supplier.contact_calling_number) {
        setWechatSameAsCalling(true);
      }
    } else {
      setForm(EMPTY_SUPPLIER_FORM);
      setFormStateId(null);
      setFormCityId(null);
      setFormCategoryIds([]);
      setFormSubCategoryIds([]);
      setFormProductIds([]);
      setLockNewStatus(false);
      setContacts([]);

      let chinaId = defaultChinaId;
      if (!chinaId) {
        chinaId = await fetchChinaId();
        if (chinaId) setDefaultChinaId(chinaId);
      }
      setFormCountryId(chinaId);
    }

    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setCurrentSupplierId(null);
    setError(null);
  }

  function buildPayload() {
    const emails = form.emails_input
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
    const visitMedia = form.visit_media_input
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);

    return {
      company_name: form.company_name.trim(),
      category_ids: formCategoryIds,
      supplier_type: form.supplier_type || null,
      brand_description: form.brand_description.trim() || null,
      country_id: formCountryId,
      state_id: formStateId,
      city_id: formCityId,
      contact_salutation: form.contact_salutation || null,
      contact_full_name: form.contact_full_name.trim() || null,
      contact_designation: form.contact_designation.trim() || null,
      contact_calling_number: form.contact_calling_number.trim() || null,
      contact_whatsapp_number: form.contact_whatsapp_number.trim() || null,
      contact_wechat_number: form.contact_wechat_number.trim() || null,
      emails,
      tax_id_number: form.tax_id_number.trim() || null,
      town: form.town.trim() || null,
      primary_website: form.primary_website.trim() || null,
      secondary_website: form.secondary_website.trim() || null,
      sub_category_ids: formSubCategoryIds,
      product_ids: formProductIds,
      supplier_grade: form.supplier_grade || null,
      current_status: form.current_status || null,
      potential: form.potential || null,
      potential_reason: form.potential_reason.trim() || null,
      secondary_products_description: form.secondary_products_description.trim() || null,
      visited_factory_office: form.visited_factory_office === "true",
      visit_remarks: form.visit_remarks.trim() || null,
      visit_media: visitMedia.length ? visitMedia : null,
      overall_remarks: form.overall_remarks.trim() || null,
      is_active: form.is_active === "true",
    };
  }

  async function resolveCustomGeography(countryId: string | null) {
    let stateId = formStateId;
    let cityId = formCityId;

    if (!stateId && formStateCustomText.trim() && countryId) {
      try {
        const { data: searchStates } = await apiGet<{ id: string; name: string }[]>(
          `/masters/states${toQueryString({ search: formStateCustomText.trim(), country_id: countryId, page: 1, page_size: 5 })}`
        );
        const match = searchStates.find((s) => s.name.toLowerCase() === formStateCustomText.trim().toLowerCase());
        if (match) {
          stateId = match.id;
        } else {
          const { data: newState } = await apiPost<{ id: string }>("/masters/states", {
            name: formStateCustomText.trim(),
            country_id: countryId,
            code: formStateCustomText.trim().slice(0, 3).toUpperCase(),
          });
          stateId = newState.id;
        }
        setFormStateId(stateId);
      } catch (err) {
        console.error("Failed to resolve custom state:", err);
      }
    }

    if (!cityId && formCityCustomText.trim() && stateId) {
      try {
        const { data: searchCities } = await apiGet<{ id: string; name: string }[]>(
          `/masters/cities${toQueryString({ search: formCityCustomText.trim(), state_id: stateId, page: 1, page_size: 5 })}`
        );
        const match = searchCities.find((c) => c.name.toLowerCase() === formCityCustomText.trim().toLowerCase());
        if (match) {
          cityId = match.id;
        } else {
          const { data: newCity } = await apiPost<{ id: string }>("/masters/cities", {
            name: formCityCustomText.trim(),
            state_id: stateId,
            code: formCityCustomText.trim().slice(0, 3).toUpperCase(),
          });
          cityId = newCity.id;
        }
        setFormCityId(cityId);
      } catch (err) {
        console.error("Failed to resolve custom city:", err);
      }
    }

    return { stateId, cityId };
  }

  async function resolveCustomCategories(): Promise<string[]> {
    const isUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    const resolvedIds: string[] = [];

    for (const cat of formCategoryIds) {
      if (isUUID(cat)) {
        resolvedIds.push(cat);
      } else {
        try {
          const { data: searchCats } = await apiGet<{ id: string; name: string }[]>(
            `/masters/product-categories${toQueryString({ search: cat.trim(), page: 1, page_size: 5 })}`
          );
          const match = searchCats.find((c) => c.name.toLowerCase() === cat.trim().toLowerCase());
          if (match) {
            resolvedIds.push(match.id);
          } else {
            const { data: newCat } = await apiPost<{ id: string }>("/masters/product-categories", {
              name: cat.trim(),
              code: cat.trim().slice(0, 3).toUpperCase(),
            });
            resolvedIds.push(newCat.id);
          }
        } catch {
          // If creation fails, skip
        }
      }
    }
    return resolvedIds;
  }

  async function saveSupplierData(nextAction?: ModalTab | "exit") {
    if (!form.company_name.trim()) {
      setError("Company Name is required.");
      return false;
    }
    if (!formCountryId) {
      setError("Country is required.");
      return false;
    }
    if (form.contact_calling_number && validateCallingNumber(form.contact_calling_number) === false) {
      if (callingNumberError) {
        setError(callingNumberError);
        return false;
      }
    }

    const triggerAlert = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      const title = msg.toLowerCase().includes("duplicate") || msg.toLowerCase().includes("already exists")
        ? "Duplicate Supplier Warning"
        : "Validation Error";
      setAlertPopup({ title, message: msg });
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    setError(null);
    setSaving(true);
    try {
      const { stateId, cityId } = await resolveCustomGeography(formCountryId);
      if (!stateId && !formStateCustomText.trim()) {
        triggerAlert("Province is required.");
        return false;
      }
      if (formStateCustomText.trim() && !stateId) {
        triggerAlert("Province could not be resolved — please select from the dropdown or check your entry.");
        return false;
      }
      if (!cityId && !formCityCustomText.trim()) {
        triggerAlert("City is required.");
        return false;
      }
      if (formCityCustomText.trim() && !cityId) {
        triggerAlert("City could not be resolved — please select from the dropdown or check your Province / City match.");
        return false;
      }
      const categoryIds = await resolveCustomCategories();

      const basePayload = buildPayload();
      const existingSupplier = rows.find((s) => s.id === currentSupplierId);
      const payload = {
        ...basePayload,
        version: existingSupplier?.version,
        state_id: stateId || formStateId,
        city_id: cityId || formCityId,
        category_ids: categoryIds,
      };

      const { data: supplier } = currentSupplierId
        ? await apiPatch<Supplier>(`/suppliers/${currentSupplierId}`, payload)
        : await apiPost<Supplier>("/suppliers", payload);
      setCurrentSupplierId(supplier.id);
      setContacts(supplier.contacts || []);
      if (currentSupplierId && supplier) {
        setRows((prev) => prev.map((row) => (row.id === supplier.id ? supplier : row)));
      } else if (supplier) {
        setRows((prev) => [supplier, ...prev]);
        setPagination((prev) => (prev ? { ...prev, total_records: (prev.total_records || 0) + 1 } : prev));
      }

      if (nextAction === "exit") {
        closeModal();
      } else if (nextAction === "continue") {
        setModalMode("full");
        setEditTab("profile");
      } else if (nextAction) {
        setModalTab(nextAction);
      }
      return true;
    } catch (err) {
      triggerAlert(err);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (modalMode === "quick") {
      await saveSupplierData("exit");
    } else {
      if (modalTab === "first") {
        await saveSupplierData("second");
      } else if (modalTab === "second") {
        await saveSupplierData("contacts");
      }
    }
  }

  async function handleSaveAndContinue(e: React.MouseEvent) {
    e.preventDefault();
    await saveSupplierData("continue");
  }

  async function handleSaveAndExit(e: React.MouseEvent) {
    e.preventDefault();
    await saveSupplierData("exit");
  }

  async function refreshContacts() {
    if (!currentSupplierId) return;
    const { data } = await apiGet<SupplierContact[]>(`/suppliers/${currentSupplierId}/contacts`);
    setContacts(data);
  }

  function openContactForm(contact: SupplierContact | null) {
    setDrawerError(null);
    setContactSubmitting(false);
    setContactForm(
      contact
        ? {
            id: contact.id,
            salutation: contact.salutation || "",
            person_name: contact.person_name,
            designation: contact.designation || "",
            handling_territory: contact.handling_territory || "",
            calling_number: contact.calling_number || "",
            whatsapp_number: contact.whatsapp_number || "",
            wechat_number: contact.wechat_number || "",
            email: contact.email || "",
          }
        : EMPTY_CONTACT_FORM
    );
    setContactCountryId(contact?.country_id || defaultChinaId || null);
    setContactSameCallingWhatsapp(false);
    setContactSameCallingWechat(false);
    setContactFormOpen(true);
  }

  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault();
    setDrawerError(null);

    if (!currentSupplierId) return;

    if (!contactForm.person_name.trim()) {
      setDrawerError("Person Name is required. Please enter Full Name.");
      return;
    }

    const payload = {
      salutation: contactForm.salutation || null,
      person_name: contactForm.person_name.trim(),
      designation: contactForm.designation.trim() || null,
      handling_territory: contactForm.handling_territory.trim() || null,
      country_id: contactCountryId || null,
      calling_number: contactForm.calling_number.trim() || null,
      whatsapp_number: contactForm.whatsapp_number.trim() || null,
      wechat_number: contactForm.wechat_number.trim() || null,
      email: contactForm.email.trim() || null,
    };

    setContactSubmitting(true);
    try {
      if (contactForm.id) {
        await apiPatch(`/suppliers/${currentSupplierId}/contacts/${contactForm.id}`, payload);
      } else {
        await apiPost(`/suppliers/${currentSupplierId}/contacts`, payload);
      }
      setContactFormOpen(false);
      await refreshContacts();
    } catch (err) {
      setDrawerError(err);
    } finally {
      setContactSubmitting(false);
    }
  }

  async function handleContactDelete(contactId: string) {
    if (!confirm("Delete this contact?")) return;
    try {
      await apiDelete(`/suppliers/${currentSupplierId}/contacts/${contactId}`);
      await refreshContacts();
    } catch (err) {
      setError(err);
    }
  }

  async function handleRowEdit(id: string) {
    try {
      const { data } = await apiGet<Supplier>(`/suppliers/${id}`);
      await openModal(data);
    } catch (err) {
      setError(err);
    }
  }

  async function handleRowDelete(id: string) {
    if (!confirm("Delete this supplier?")) return;
    try {
      await apiDelete(`/suppliers/${id}`);
      setRows((prev) => prev.filter((r) => r.id !== id));
      setPagination((prev) => (prev ? { ...prev, total_records: Math.max(0, (prev.total_records || 1) - 1) } : prev));
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkDelete() {
    if (!selectedIds.length) return;
    if (!confirm(`Delete ${selectedIds.length} selected supplier(s)? This cannot be undone.`)) return;
    try {
      await Promise.all(selectedIds.map((id) => apiDelete(`/suppliers/${id}`)));
      setRows((prev) => prev.filter((r) => !selectedIds.includes(r.id)));
      setSelectedIds([]);
    } catch (err) {
      setError(err);
    }
  }

  async function handleInlineUpdate(path: string, payload: unknown) {
    try {
      await apiPatch(path, payload);
    } catch (err) {
      setError(err);
      reload();
    }
  }

  async function handleExport(format: "csv" | "xlsx") {
    try {
      await downloadExport("/suppliers", format, "suppliers");
    } catch (err) {
      setError(err);
    }
  }

  const startSrNo = (currentPage - 1) * pageSize + 1;

  return (
    <AppShell activeKey="suppliers" pageClassName="page-suppliers">
      {modalOpen ? (
        <main className="page" style={{ width: "100%", padding: "20px 24px" }}>
          {/* Header Bar with Back Button */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
            <div>
              <h1 style={{ fontSize: "22px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
                {modalMode === "quick" ? "Add Supplier (Quick)" : (currentSupplierId ? "Edit Supplier" : "Add Supplier")}
              </h1>
              <div style={{ fontSize: "13px", color: "#64748b", marginTop: "2px" }}>
                {modalMode === "quick" ? "Fill primary supplier details for quick creation." : "Complete the supplier details below."}
              </div>
            </div>
            <button
              type="button"
              className="btn"
              onClick={closeModal}
              style={{
                background: "#ffffff",
                border: "1px solid #cbd5e1",
                color: "#475569",
                fontWeight: 600,
                fontSize: "13px",
                padding: "8px 18px",
                borderRadius: "6px",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              ← BACK TO SUPPLIERS
            </button>
          </div>
          <div className="card" style={{ background: "#ffffff", padding: "28px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
            {/* TOP NAVIGATION TABS (PROFILE | CONTACTS) */}
            {modalMode === "full" && (
              <div style={{ display: "flex", gap: "24px", borderBottom: "2px solid #e2e8f0", marginBottom: "24px" }}>
                <button
                  type="button"
                  onClick={() => setEditTab("profile")}
                  style={{
                    padding: "10px 18px",
                    background: "none",
                    border: "none",
                    borderBottom: editTab === "profile" ? "3px solid #0061f2" : "3px solid transparent",
                    color: editTab === "profile" ? "#0061f2" : "#64748b",
                    fontWeight: editTab === "profile" ? 700 : 600,
                    fontSize: "14.5px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                    marginBottom: "-2px",
                    transition: "all 0.2s ease",
                  }}
                >
                  <span style={{ fontSize: "16px" }}>👤</span> Profile
                </button>
                {currentSupplierId && (
                  <button
                    type="button"
                    onClick={() => setEditTab("contacts")}
                    style={{
                      padding: "10px 18px",
                      background: "none",
                      border: "none",
                      borderBottom: editTab === "contacts" ? "3px solid #0061f2" : "3px solid transparent",
                      color: editTab === "contacts" ? "#0061f2" : "#64748b",
                      fontWeight: editTab === "contacts" ? 700 : 600,
                      fontSize: "14.5px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      marginBottom: "-2px",
                      transition: "all 0.2s ease",
                    }}
                  >
                    <span style={{ fontSize: "16px" }}>📇</span> Contacts
                    {contacts.length > 0 && (
                      <span style={{
                        background: editTab === "contacts" ? "#e0e7ff" : "#f1f5f9",
                        color: editTab === "contacts" ? "#4338ca" : "#64748b",
                        fontSize: "12px",
                        fontWeight: 700,
                        padding: "2px 8px",
                        borderRadius: "12px",
                      }}>
                        {contacts.length}
                      </span>
                    )}
                  </button>
                )}
              </div>
            )}
            {/* TAB 1: PROFILE FORM (SAME ORIGINAL DATA & FIELDS) */}
            {(editTab === "profile" || modalMode === "quick") && (
              <form onSubmit={handleSubmit}>
                {/* SECTION 1: General & Primary Contact Info (First Data Form) */}
                <div style={{ marginBottom: "24px" }}>
                  <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 16px 0", color: "#0f172a" }}>
                    1. General Information
                  </h3>
                  {/* Row 1: Company Name + Product Category (2 columns) */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px", marginBottom: "18px" }}>
                    <div className="field" style={{ position: "relative" }}>
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Name of Company *</label>
                      <SearchableDropdown
                        value={form.company_name}
                        onChange={(_, label) => setField("company_name", label)}
                        allowCustomText={true}
                        onTextChange={(v) => setField("company_name", v)}
                        placeholder="Search existing or type company name..."
                        fetchOptions={companyNameFetcher}
                        fetchLabelForValue={async (v) => v}
                      />
                      {(() => {
                        const typed = (form.company_name || "").trim();
                        if (!typed) return null;
                        const cleanTyped = typed.toLowerCase().replace(/[\s-]/g, "");

                        const matches = existingSuppliers.items.filter((s) => {
                          if (currentSupplierId && s.id === currentSupplierId) return false;
                          const sName = (s.company_name || "").toLowerCase().replace(/[\s-]/g, "");
                          return sName.includes(cleanTyped);
                        }).slice(0, 5);

                        const exact = existingSuppliers.items.find((s) => {
                          if (currentSupplierId && s.id === currentSupplierId) return false;
                          const sName = (s.company_name || "").toLowerCase().replace(/[\s-]/g, "");
                          return sName === cleanTyped;
                        });

                        return (
                          <>
                            {exact && (
                              <div style={{ marginTop: "6px", fontSize: "12.5px", color: "#dc2626", fontWeight: 600, display: "flex", alignItems: "center", gap: "5px" }}>
                                <span>⚠️</span> Supplier "{exact.company_name}" already exists!
                              </div>
                            )}
                            {matches.length > 0 && !exact && (
                              <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 100, background: "#ffffff", border: "1px solid #cbd5e0", borderRadius: "6px", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", maxHeight: "160px", overflowY: "auto", marginTop: "2px" }}>
                                <div style={{ padding: "6px 12px", fontSize: "11px", fontWeight: 700, color: "#64748b", background: "#f8fafc", borderBottom: "1px solid #f1f5f9" }}>
                                  Existing Similar Suppliers:
                                </div>
                                {matches.map((s) => (
                                  <div
                                    key={s.id}
                                    style={{ padding: "8px 12px", fontSize: "12.5px", cursor: "pointer", borderBottom: "1px solid #f8fafc", display: "flex", justifyContent: "space-between", background: "#fff" }}
                                    onClick={() => setField("company_name", s.company_name)}
                                  >
                                    <span style={{ fontWeight: 600, color: "#1e293b" }}>{s.company_name}</span>
                                    <span style={{ color: "#64748b", fontSize: "11.5px" }}>{s.supplier_type || "Supplier"}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </div>
                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Product Category (multiple)</label>
                      <SearchableDropdownMultiPanel
                        values={formCategoryIds}
                        onChange={setFormCategoryIds}
                        placeholder="-- Select Categories --"
                        fetchOptions={searchFetcher("/masters/product-categories")}
                        fetchLabelForValue={fetchNameLabel("/masters/product-categories")}
                      />
                    </div>
                  </div>

                  {/* Row 2: Supplier Type + Brand of Supplier's Products (2 columns) */}
                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Supplier Type</label>
                      <SearchableDropdown
                        value={form.supplier_type ? form.supplier_type : null}
                        onChange={(_v, label) => setField("supplier_type", label || _v || "")}
                        allowCustomText={true}
                        onTextChange={(text) => setField("supplier_type", text)}
                        placeholder="Search or select supplier type..."
                        fetchOptions={searchFetcher("/masters/supplier-types")}
                        fetchLabelForValue={async (val) => val}
                      />
                    </div>
                    <TextField id="brand_description" label="Brand of Supplier's Products" placeholder="Description..." value={form.brand_description} onChange={(v) => setField("brand_description", v)} />


                  {/* Row 3: Country + Province + City (3 columns) */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "18px", marginBottom: "24px" }}>
                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Country *</label>
                      <SearchableDropdown
                        value={formCountryId}
                        onChange={(v) => {
                          setFormCountryId(v);
                          setFormStateId(null);
                          setFormCityId(null);
                          setFormStateCustomText("");
                          setFormCityCustomText("");
                        }}
                        placeholder="Search country..."
                        fetchOptions={searchFetcher("/masters/countries")}
                        fetchLabelForValue={fetchNameLabel("/masters/countries")}
                      />
                    </div>
                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Province *</label>
                      <SearchableDropdown
                        value={formStateId}
                        onChange={(v, label) => {
                          setFormStateId(v);
                          setFormStateCustomText(v ? label : "");
                          setFormCityId(null);
                          setFormCityCustomText("");
                        }}
                        allowCustomText={true}
                        onTextChange={(text) => {
                          setFormStateCustomText(text);
                          setFormStateId(null);
                          setFormCityId(null);
                          setFormCityCustomText("");
                        }}
                        placeholder="Search or type province..."
                        fetchOptions={searchFetcher("/masters/states", (): Record<string, string> =>
                          formCountryId ? { country_id: formCountryId } : {}
                        )}
                        fetchLabelForValue={fetchNameLabel("/masters/states")}
                      />
                    </div>
                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>City *</label>
                      <SearchableDropdown
                        value={formCityId}
                        onChange={(v, label) => {
                          setFormCityId(v);
                          setFormCityCustomText(v ? label : "");
                        }}
                        allowCustomText={true}
                        onTextChange={(text) => {
                          setFormCityCustomText(text);
                          setFormCityId(null);
                        }}
                        placeholder="Search or type city..."
                        fetchOptions={searchFetcher("/masters/cities", (): Record<string, string> => {
                          if (formStateId) return { state_id: formStateId };
                          if (formCountryId) return { country_id: formCountryId };
                          return {};
                        })}
                        fetchLabelForValue={fetchNameLabel("/masters/cities")}
                      />
                    </div>
                  </div>

                  <h4 style={{ fontSize: "14.5px", fontWeight: 700, margin: "0 0 14px 0", color: "#0f172a" }}>
                    Primary Contact Information
                  </h4>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "18px" }}>
                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Mr. / Mrs / Ms - Full Name</label>
                      <div style={{ display: "flex", gap: "8px" }}>
                        <select
                          value={form.contact_salutation}
                          onChange={(e) => setField("contact_salutation", e.target.value)}
                          style={{
                            padding: "8px",
                            fontSize: "13.5px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            background: "#ffffff",
                            color: "#334155",
                          }}
                        >
                          <option value="">—</option>
                          <option value="Mr.">Mr.</option>
                          <option value="Mrs.">Mrs.</option>
                          <option value="Ms.">Ms.</option>
                        </select>
                        <input
                          type="text"
                          maxLength={150}
                          placeholder="Full Name"
                          value={form.contact_full_name}
                          onChange={(e) => setField("contact_full_name", e.target.value)}
                          style={{
                            flex: 1,
                            padding: "8px 11px",
                            fontSize: "13.5px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e1",
                            outline: "none",
                          }}
                        />
                      </div>
                    </div>

                    <TextField id="contact_designation" label="Designation" placeholder="e.g. Sales Manager" maxLength={150} value={form.contact_designation} onChange={(v) => setField("contact_designation", v)} />

                    <div className="field">
                      <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Calling Number</label>
                      <input
                        type="text"
                        maxLength={30}
                        placeholder="With country code, 7-11 digits"
                        value={form.contact_calling_number}
                        onChange={(e) => {
                          const val = e.target.value;
                          setField("contact_calling_number", val);
                          if (whatsappSameAsCalling) setField("contact_whatsapp_number", val);
                          if (wechatSameAsCalling) setField("contact_wechat_number", val);
                          setCallingNumberError(validatePhoneNumber(val));
                        }}
                        style={{
                          width: "100%",
                          padding: "8px 11px",
                          fontSize: "13.5px",
                          borderRadius: "6px",
                          border: callingNumberError ? "1px solid #ef4444" : "1px solid #cbd5e1",
                          outline: "none",
                        }}
                      />
                      {callingNumberError && <span style={{ color: "#ef4444", fontSize: "11px", marginTop: "4px", display: "block" }}>{callingNumberError}</span>}
                    </div>

                    <div className="field">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                        <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>WhatsApp Number</label>
                        <label style={{ fontSize: "11px", color: "#64748b", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <input
                            type="checkbox"
                            checked={whatsappSameAsCalling}
                            onChange={(e) => {
                              setWhatsappSameAsCalling(e.target.checked);
                              if (e.target.checked) setField("contact_whatsapp_number", form.contact_calling_number);
                            }}
                          />
                          Same as calling
                        </label>
                      </div>
                      <input
                        type="text"
                        maxLength={30}
                        value={form.contact_whatsapp_number}
                        onChange={(e) => setField("contact_whatsapp_number", e.target.value)}
                        style={{ width: "100%", padding: "8px 11px", fontSize: "13.5px", borderRadius: "6px", border: "1px solid #cbd5e1", outline: "none" }}
                      />
                    </div>

                    <div className="field">
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                        <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569" }}>WeChat Number</label>
                        <label style={{ fontSize: "11px", color: "#64748b", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px" }}>
                          <input
                            type="checkbox"
                            checked={wechatSameAsCalling}
                            onChange={(e) => {
                              setWechatSameAsCalling(e.target.checked);
                              if (e.target.checked) setField("contact_wechat_number", form.contact_calling_number);
                            }}
                          />
                          Same as calling
                        </label>
                      </div>
                      <input
                        type="text"
                        maxLength={50}
                        value={form.contact_wechat_number}
                        onChange={(e) => setField("contact_wechat_number", e.target.value)}
                        style={{ width: "100%", padding: "8px 11px", fontSize: "13.5px", borderRadius: "6px", border: "1px solid #cbd5e1", outline: "none" }}
                      />
                    </div>

                    <TextField id="emails_input" label="Email ID (multiple emails)" placeholder="test6861@supplier.com" value={form.emails_input} onChange={(v) => setField("emails_input", v)} />
                  </div>
                </div>

                {/* SECTION 2: Supplier Profile & Verification Details */}
                {modalMode === "full" && (
                  <div style={{ marginBottom: "24px", borderTop: "1px solid #e2e8f0", paddingTop: "24px" }}>
                    <h3 style={{ fontSize: "16px", fontWeight: 700, margin: "0 0 16px 0", color: "#0f172a" }}>
                      2. Supplier Profile &amp; Verification Details
                    </h3>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "18px", marginBottom: "18px" }}>
                      <TextField id="tax_id_number" label="Tax ID Number" maxLength={100} value={form.tax_id_number} onChange={(v) => setField("tax_id_number", v)} />
                      <TextField id="town" label="Town" maxLength={150} value={form.town} onChange={(v) => setField("town", v)} />
                      <TextField id="primary_website" label="Primary Website" placeholder="https://..." value={form.primary_website} onChange={(v) => setField("primary_website", v)} />
                      <TextField id="secondary_website" label="Secondary Website" placeholder="https://..." value={form.secondary_website} onChange={(v) => setField("secondary_website", v)} />
                      <SelectField id="supplier_grade" label="Supplier Grade" value={form.supplier_grade} onChange={(v) => setField("supplier_grade", v)}>
                        <option value="">Select Grade</option>
                        <option value="A">Grade A</option>
                        <option value="B">Grade B</option>
                        <option value="C">Grade C</option>
                        <option value="D">Grade D</option>
                      </SelectField>
                      <SelectField id="current_status" label="Current Status" value={form.current_status} onChange={(v) => setField("current_status", v)}>
                        <option value="">Select</option>
                        <option value="new" disabled={lockNewStatus}>New</option>
                        <option value="existing">Existing</option>
                      </SelectField>
                      <SelectField id="potential" label="Potential (Yes / No)" value={form.potential} onChange={(v) => setField("potential", v)}>
                        <option value="">Select Potential</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </SelectField>
                      <div style={{ gridColumn: "span 2" }}>
                        <TextField id="potential_reason" label="Reason for Potential Status" placeholder="Explain why..." value={form.potential_reason} onChange={(v) => setField("potential_reason", v)} />
                      </div>
                    </div>

                    <div style={{ marginBottom: "18px" }}>
                      <TextAreaField id="secondary_products_description" label="Secondary Products Description" rows={2} value={form.secondary_products_description} onChange={(v) => setField("secondary_products_description", v)} />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "18px", marginBottom: "18px" }}>
                      <SelectField id="visited_factory_office" label="Visited Factory / Office?" value={form.visited_factory_office} onChange={(v) => setField("visited_factory_office", v)}>
                        <option value="false">No</option>
                        <option value="true">Yes</option>
                      </SelectField>
                      <TextField id="visit_remarks" label="Visit Remarks / Summary" placeholder="Key observations..." value={form.visit_remarks} onChange={(v) => setField("visit_remarks", v)} />
                    </div>

                    <div style={{ marginBottom: "18px" }}>
                      <div className="card-header" style={{ marginBottom: "8px" }}>
                        <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", margin: 0 }}>
                          Visit Photos &amp; Videos (Supabase Storage)
                        </label>
                        <label className="btn btn-small" style={{ background: "#f1f5f9", border: "1px solid #cbd5e1", color: "#334155", cursor: uploadingMedia ? "not-allowed" : "pointer" }}>
                          {uploadingMedia ? "Uploading..." : "📁 Select Photos / Videos"}
                          <input type="file" multiple accept="image/*,video/*" onChange={(e) => void handleMediaFileUpload(e.target.files)} disabled={uploadingMedia} style={{ display: "none" }} />
                        </label>
                      </div>

                      {mediaList.length > 0 && (
                        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap", marginBottom: "12px" }}>
                          {mediaList.map((url, idx) => {
                            const isVideo = url.match(/\.(mp4|webm|ogg|mov)$/i);
                            return (
                              <div key={idx} style={{ position: "relative", width: "100px", height: "80px", borderRadius: "6px", overflow: "hidden", border: "1px solid #cbd5e1" }}>
                                {isVideo ? (
                                  <div style={{ width: "100%", height: "100%", background: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", color: "#ffffff" }}>
                                    🎬
                                  </div>
                                ) : (
                                  <img src={url} alt={`Media ${idx + 1}`} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                )}
                                <button
                                  type="button"
                                  onClick={() => removeMediaUrl(url)}
                                  style={{
                                    position: "absolute",
                                    top: "4px",
                                    right: "4px",
                                    width: "22px",
                                    height: "22px",
                                    borderRadius: "50%",
                                    background: "rgba(239, 68, 68, 0.9)",
                                    color: "#ffffff",
                                    border: "none",
                                    cursor: "pointer",
                                    fontSize: "12px",
                                    fontWeight: 700,
                                  }}
                                >
                                  ✕
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <TextField id="visit_media_input" label="Media URLs (comma-separated URLs)" placeholder="https://... (Auto-filled on upload or paste manually)" value={form.visit_media_input} onChange={(v) => setField("visit_media_input", v)} />
                    </div>

                    <div style={{ marginBottom: "16px" }}>
                      <TextAreaField id="overall_remarks" label="Overall Remarks / Key Strengths" rows={2} value={form.overall_remarks} onChange={(v) => setField("overall_remarks", v)} />
                    </div>
                  </div>
                )}

                {Boolean(error) && (
                  <div style={{ marginTop: "20px" }}>
                    <Banner error={error} />
                  </div>
                )}

                {/* FULL PAGE FORM FOOTER ACTION BUTTONS */}
                <div style={{ paddingTop: "24px", marginTop: "28px", borderTop: "1px solid #e2e8f0", display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                  <button type="button" className="btn" onClick={closeModal} style={{ background: "#ffffff", border: "1px solid #cbd5e1", color: "#475569", padding: "10px 20px", borderRadius: "6px", fontWeight: 600, fontSize: "14px" }}>
                    Cancel
                  </button>
                  {!currentSupplierId && (
                    <button
                      type="button"
                      className="btn"
                      disabled={saving}
                      style={{
                        background: "#0061f2",
                        color: "#ffffff",
                        padding: "10px 24px",
                        borderRadius: "6px",
                        fontWeight: 600,
                        fontSize: "14px",
                        border: "none",
                        cursor: saving ? "not-allowed" : "pointer",
                        opacity: saving ? 0.7 : 1,
                        boxShadow: "0 2px 6px rgba(0, 97, 242, 0.25)",
                      }}
                      onClick={handleSaveAndContinue}
                    >
                      {saving ? "Saving..." : "Save & Continue"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={saving}
                    style={{
                      background: !currentSupplierId ? "#ffffff" : "#0061f2",
                      border: !currentSupplierId ? "1px solid #cbd5e1" : "none",
                      color: !currentSupplierId ? "#334155" : "#ffffff",
                      padding: "10px 24px",
                      borderRadius: "6px",
                      fontWeight: 600,
                      fontSize: "14px",
                      cursor: saving ? "not-allowed" : "pointer",
                      opacity: saving ? 0.7 : 1,
                    }}
                    onClick={handleSaveAndExit}
                  >
                    {saving ? "Saving..." : "Save & Exit"}
                  </button>
                </div>
              </form>
            )}

            {/* TAB 2: CONTACTS TAB VIEW */}
            {modalMode === "full" && currentSupplierId && editTab === "contacts" && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "20px" }}>
                  <div>
                    <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
                      Supplier Contacts
                    </h3>
                    <div style={{ fontSize: "13px", color: "#64748b", marginTop: "3px" }}>
                      Manage contact persons, territory assignments, numbers, WeChat, and email addresses.
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-add-new"
                    onClick={() => openContactForm(null)}
                    style={{
                      background: "#0061f2",
                      color: "#ffffff",
                      padding: "9px 18px",
                      borderRadius: "6px",
                      fontWeight: 600,
                      fontSize: "13.5px",
                      border: "none",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    + Add New
                  </button>
                </div>

                {/* RIGHT SIDE DRAWER MODAL FOR ADD/EDIT CONTACT */}
                {contactFormOpen && (
                  <div style={{ position: "fixed", inset: 0, zIndex: 9999, display: "flex", justifyContent: "flex-end" }}>
                    {/* Dark Backdrop Overlay */}
                    <div
                      onClick={() => setContactFormOpen(false)}
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "rgba(15, 23, 42, 0.45)",
                        backdropFilter: "blur(2px)",
                        transition: "opacity 0.2s ease",
                      }}
                    />

                    {/* Side Drawer Panel */}
                    <div
                      style={{
                        position: "relative",
                        width: "460px",
                        maxWidth: "92vw",
                        height: "100%",
                        background: "#ffffff",
                        boxShadow: "-8px 0 30px rgba(0, 0, 0, 0.18)",
                        display: "flex",
                        flexDirection: "column",
                        zIndex: 10000,
                      }}
                    >
                      {/* Drawer Header */}
                      <div
                        style={{
                          padding: "18px 24px",
                          borderBottom: "1px solid #e2e8f0",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          background: "#ffffff",
                        }}
                      >
                        <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
                          {contactForm.id ? "Edit Contact Person" : "Add New Contact"}
                        </h3>
                        <button
                          type="button"
                          onClick={() => setContactFormOpen(false)}
                          style={{
                            background: "none",
                            border: "none",
                            fontSize: "20px",
                            color: "#64748b",
                            cursor: "pointer",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            lineHeight: 1,
                          }}
                        >
                          ✕
                        </button>
                      </div>

                      {/* Drawer Form Content (Scrollable) */}
                      <form
                        autoComplete="none"
                        onSubmit={(e) => { void handleContactSubmit(e); }}
                        style={{ flex: 1, overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: "18px" }}
                      >
                        {Boolean(drawerError) && (
                          <div style={{ marginBottom: "6px" }}>
                            <Banner error={drawerError} />
                          </div>
                        )}

                        {/* Full Name Field (Compact inline Salutation dropdown + Name input) */}
                        <div className="field">
                          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "block" }}>
                            Full Name <span style={{ color: "#ef4444" }}>*</span>
                          </label>
                          <div style={{ display: "flex", gap: "8px" }}>
                            <select
                              value={contactForm.salutation}
                              onChange={(e) => setContactForm((f) => ({ ...f, salutation: e.target.value }))}
                              style={{
                                width: "75px",
                                padding: "9px 8px",
                                fontSize: "13.5px",
                                borderRadius: "6px",
                                border: "1px solid #cbd5e1",
                                background: "#ffffff",
                                color: "#334155",
                                fontWeight: 500,
                                outline: "none",
                              }}
                            >
                              <option value="">Mr</option>
                              <option value="Mr.">Mr.</option>
                              <option value="Mrs.">Mrs.</option>
                              <option value="Ms.">Ms.</option>
                            </select>
                            <input
                              type="text"
                              required
                              autoComplete="new-password"
                              readOnly
                              onFocus={(e) => e.target.removeAttribute("readonly")}
                              maxLength={150}
                              placeholder="Full name of contact..."
                              value={contactForm.person_name}
                              onChange={(e) => setContactForm((f) => ({ ...f, person_name: e.target.value }))}
                              style={{
                                flex: 1,
                                padding: "9px 12px",
                                fontSize: "13.5px",
                                borderRadius: "6px",
                                border: "1px solid #cbd5e1",
                                outline: "none",
                                color: "#0f172a",
                              }}
                            />
                          </div>
                        </div>

                        {/* Designation */}
                        <div className="field">
                          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "block" }}>
                            Designation
                          </label>
                          <input
                            type="text"
                            autoComplete="new-password"
                            readOnly
                            onFocus={(e) => e.target.removeAttribute("readonly")}
                            maxLength={150}
                            placeholder="e.g. Sales Manager, Sourcing Lead"
                            value={contactForm.designation}
                            onChange={(e) => setContactForm((f) => ({ ...f, designation: e.target.value }))}
                            style={{
                              width: "100%",
                              padding: "9px 12px",
                              fontSize: "13.5px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              color: "#0f172a",
                            }}
                          />
                        </div>

                        {/* Calling Number */}
                        <div className="field">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", margin: 0 }}>Calling Number</label>
                            {contactPhoneCode && (
                              <span style={{ fontSize: "11px", fontWeight: 700, color: "#0061f2", background: "#eff6ff", padding: "1px 7px", borderRadius: "4px" }}>
                                Code: {contactPhoneCode}
                              </span>
                            )}
                          </div>
                          <input
                            type="text"
                            autoComplete="new-password"
                            readOnly
                            onFocus={(e) => e.target.removeAttribute("readonly")}
                            maxLength={30}
                            placeholder={contactPhoneCode ? `${contactPhoneCode} 13800...` : "With country code..."}
                            value={contactForm.calling_number}
                            onChange={(e) => {
                              const v = e.target.value;
                              setContactForm((f) => {
                                const updated = { ...f, calling_number: v };
                                if (contactSameCallingWhatsapp) updated.whatsapp_number = v;
                                if (contactSameCallingWechat) updated.wechat_number = v;
                                return updated;
                              });
                            }}
                            style={{
                              width: "100%",
                              padding: "9px 12px",
                              fontSize: "13.5px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              color: "#0f172a",
                            }}
                          />
                        </div>

                        {/* WhatsApp Number */}
                        <div className="field">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", margin: 0 }}>Whatsapp Number</label>
                            <label style={{ fontSize: "11.5px", color: "#0061f2", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 600 }}>
                              <input
                                type="checkbox"
                                checked={contactSameCallingWhatsapp}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setContactSameCallingWhatsapp(checked);
                                  if (checked) {
                                    setContactForm((f) => ({ ...f, whatsapp_number: f.calling_number }));
                                  }
                                }}
                              />
                              Same As Calling
                            </label>
                          </div>
                          <input
                            type="text"
                            autoComplete="new-password"
                            readOnly
                            onFocus={(e) => e.target.removeAttribute("readonly")}
                            maxLength={30}
                            placeholder={contactPhoneCode ? `${contactPhoneCode} 13800...` : "With country code..."}
                            value={contactForm.whatsapp_number}
                            onChange={(e) => setContactForm((f) => ({ ...f, whatsapp_number: e.target.value }))}
                            style={{
                              width: "100%",
                              padding: "9px 12px",
                              fontSize: "13.5px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              color: "#0f172a",
                            }}
                          />
                        </div>

                        {/* WeChat Number */}
                        <div className="field">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                            <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", margin: 0 }}>WeChat Number</label>
                            <label style={{ fontSize: "11.5px", color: "#0061f2", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: "4px", fontWeight: 600 }}>
                              <input
                                type="checkbox"
                                checked={contactSameCallingWechat}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setContactSameCallingWechat(checked);
                                  if (checked) {
                                    setContactForm((f) => ({ ...f, wechat_number: f.calling_number }));
                                  }
                                }}
                              />
                              Same As Calling
                            </label>
                          </div>
                          <input
                            type="text"
                            autoComplete="new-password"
                            readOnly
                            onFocus={(e) => e.target.removeAttribute("readonly")}
                            maxLength={50}
                            placeholder={contactPhoneCode ? `${contactPhoneCode} / ID` : "WeChat ID or Phone..."}
                            value={contactForm.wechat_number}
                            onChange={(e) => setContactForm((f) => ({ ...f, wechat_number: e.target.value }))}
                            style={{
                              width: "100%",
                              padding: "9px 12px",
                              fontSize: "13.5px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              color: "#0f172a",
                            }}
                          />
                        </div>

                        {/* Email ID */}
                        <div className="field">
                          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "block" }}>
                            Email ID
                          </label>
                          <input
                            type="text"
                            inputMode="email"
                            autoComplete="new-password"
                            readOnly
                            onFocus={(e) => e.target.removeAttribute("readonly")}
                            maxLength={255}
                            placeholder="contact@supplier.com"
                            value={contactForm.email}
                            onChange={(e) => setContactForm((f) => ({ ...f, email: e.target.value }))}
                            style={{
                              width: "100%",
                              padding: "9px 12px",
                              fontSize: "13.5px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              color: "#0f172a",
                            }}
                          />
                        </div>

                        {/* Handling Territory */}
                        <div className="field">
                          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "block" }}>
                            Handling Territory
                          </label>
                          <input
                            type="text"
                            autoComplete="new-password"
                            readOnly
                            onFocus={(e) => e.target.removeAttribute("readonly")}
                            maxLength={150}
                            placeholder="e.g. local, Export India, Export Africa..."
                            value={contactForm.handling_territory}
                            onChange={(e) => setContactForm((f) => ({ ...f, handling_territory: e.target.value }))}
                            style={{
                              width: "100%",
                              padding: "9px 12px",
                              fontSize: "13.5px",
                              borderRadius: "6px",
                              border: "1px solid #cbd5e1",
                              outline: "none",
                              color: "#0f172a",
                            }}
                          />
                          <div style={{ display: "flex", gap: "6px", marginTop: "6px", flexWrap: "wrap" }}>
                            {["local", "Export India", "Export Africa", "Export Global"].map((t) => (
                              <button
                                key={t}
                                type="button"
                                onClick={() => setContactForm((f) => ({ ...f, handling_territory: t }))}
                                style={{
                                  padding: "3px 10px",
                                  fontSize: "11.5px",
                                  fontWeight: 600,
                                  background: contactForm.handling_territory === t ? "#e0e7ff" : "#f8fafc",
                                  color: contactForm.handling_territory === t ? "#4338ca" : "#475569",
                                  border: "1px solid",
                                  borderColor: contactForm.handling_territory === t ? "#c7d2fe" : "#cbd5e1",
                                  borderRadius: "4px",
                                  cursor: "pointer",
                                }}
                              >
                                {t}
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Country (Default China) */}
                        <div className="field">
                          <label style={{ fontSize: "12.5px", fontWeight: 600, color: "#475569", marginBottom: "6px", display: "block" }}>
                            Country <span style={{ color: "#ef4444" }}>*</span>
                          </label>
                          <SearchableDropdown
                            value={contactCountryId}
                            onChange={setContactCountryId}
                            placeholder="Search country..."
                            fetchOptions={searchFetcher("/masters/countries")}
                            fetchLabelForValue={fetchNameLabel("/masters/countries")}
                          />
                        </div>
                      </form>

                      {/* Footer Bar with Prominent Full-Width Blue Submit Button */}
                      <div
                        style={{
                          padding: "16px 24px",
                          borderTop: "1px solid #e2e8f0",
                          background: "#ffffff",
                          display: "flex",
                          gap: "12px",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setContactFormOpen(false)}
                          style={{
                            flex: "0 0 90px",
                            padding: "11px",
                            background: "#ffffff",
                            border: "1px solid #cbd5e1",
                            color: "#475569",
                            borderRadius: "6px",
                            fontSize: "14px",
                            fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          disabled={contactSubmitting}
                          onClick={(e) => { void handleContactSubmit(e); }}
                          style={{
                            flex: 1,
                            padding: "11px",
                            background: "#0061f2",
                            color: "#ffffff",
                            border: "none",
                            borderRadius: "6px",
                            fontSize: "14px",
                            fontWeight: 700,
                            cursor: contactSubmitting ? "not-allowed" : "pointer",
                            opacity: contactSubmitting ? 0.7 : 1,
                            boxShadow: "0 2px 6px rgba(0, 97, 242, 0.3)",
                          }}
                        >
                          {contactSubmitting ? "Submitting..." : "Submit"}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* CONTACTS LIST TABLE */}
                <div className="table-scroll" style={{ border: "1px solid #e2e8f0", borderRadius: "8px", overflow: "hidden" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                        <th style={{ padding: "12px 14px", textAlign: "left", fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase" }}>NAME / DESIGNATION</th>
                        <th style={{ padding: "12px 14px", textAlign: "left", fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase" }}>CALLING / WHATSAPP</th>
                        <th style={{ padding: "12px 14px", textAlign: "left", fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase" }}>WECHAT / EMAIL</th>
                        <th style={{ padding: "12px 14px", textAlign: "left", fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase" }}>HANDLING TERRITORY</th>
                        <th style={{ padding: "12px 14px", textAlign: "center", fontSize: "12px", fontWeight: 700, color: "#475569", textTransform: "uppercase", width: "140px" }}>ACTION</th>
                      </tr>
                    </thead>
                    <tbody>
                      {contacts.length === 0 ? (
                        <tr>
                          <td colSpan={5} style={{ padding: "24px", textAlign: "center", color: "#94a3b8", fontSize: "13.5px" }}>
                            No contact persons added yet. Click "+ Add New" above to add contacts.
                          </td>
                        </tr>
                      ) : (
                        contacts.map((c) => (
                          <tr key={c.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            {/* NAME / DESIGNATION */}
                            <td style={{ padding: "12px 14px", verticalAlign: "top" }}>
                              <div style={{ fontWeight: 700, color: "#0f172a", fontSize: "13.5px" }}>
                                {c.salutation ? `${c.salutation} ` : ""}{c.person_name}
                                {c.is_primary && (
                                  <span style={{ marginLeft: "6px", background: "#e2e8f0", color: "#334155", fontSize: "11px", fontWeight: 600, padding: "1px 6px", borderRadius: "4px" }}>
                                    Primary
                                  </span>
                                )}
                              </div>
                              {c.designation ? (
                                <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "2px" }}>{c.designation}</div>
                              ) : (
                                <div style={{ fontSize: "12px", color: "#cbd5e1" }}>—</div>
                              )}
                            </td>

                            {/* CALLING / WHATSAPP */}
                            <td style={{ padding: "12px 14px", verticalAlign: "top" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                                {c.calling_number ? (
                                  <a href={`tel:${c.calling_number}`} style={{ color: "#0061f2", textDecoration: "none", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                    📞 {c.calling_number}
                                  </a>
                                ) : <span style={{ color: "#cbd5e1" }}>—</span>}
                                {c.whatsapp_number ? (
                                  <a href={`https://wa.me/${c.whatsapp_number.replace(/[^0-9]/g, "")}`} target="_blank" rel="noopener noreferrer" style={{ color: "#16a34a", textDecoration: "none", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                    💬 {c.whatsapp_number}
                                  </a>
                                ) : null}
                              </div>
                            </td>

                            {/* WECHAT / EMAIL */}
                            <td style={{ padding: "12px 14px", verticalAlign: "top" }}>
                              <div style={{ display: "flex", flexDirection: "column", gap: "4px", fontSize: "13px" }}>
                                {c.wechat_number ? (
                                  <span style={{ color: "#334155", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                    💬 {c.wechat_number}
                                  </span>
                                ) : <span style={{ color: "#cbd5e1" }}>—</span>}
                                {c.email ? (
                                  <a href={`mailto:${c.email}`} style={{ color: "#0061f2", textDecoration: "none", fontWeight: 500, display: "inline-flex", alignItems: "center", gap: "5px" }}>
                                    ✉️ {c.email}
                                  </a>
                                ) : null}
                              </div>
                            </td>

                            {/* HANDLING TERRITORY */}
                            <td style={{ padding: "12px 14px", verticalAlign: "top" }}>
                              <span style={{ fontSize: "13px", color: "#334155", fontWeight: 500 }}>
                                {c.handling_territory || "—"}
                              </span>
                            </td>

                            {/* ACTION */}
                            <td style={{ padding: "12px 14px", verticalAlign: "top", textAlign: "center" }}>
                              <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
                                <button
                                  type="button"
                                  onClick={() => openContactForm(c)}
                                  style={{
                                    background: "#0061f2",
                                    color: "#ffffff",
                                    border: "none",
                                    borderRadius: "5px",
                                    padding: "5px 12px",
                                    fontSize: "12px",
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "4px",
                                  }}
                                >
                                  ✏️ Edit
                                </button>
                                {!c.is_primary && (
                                  <button
                                    type="button"
                                    onClick={() => handleContactDelete(c.id)}
                                    style={{
                                      background: "#ef4444",
                                      color: "#ffffff",
                                      border: "none",
                                      borderRadius: "5px",
                                      padding: "5px 12px",
                                      fontSize: "12px",
                                      fontWeight: 600,
                                      cursor: "pointer",
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: "4px",
                                    }}
                                  >
                                    🗑️ Delete
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </main>
      ) : (
        <main className="page">
          <Breadcrumb trail={["Supplier Profiles"]} />
          <div className="page-header">
            <div>
              <h1>Supplier Profiles</h1>
              <div className="page-subtitle">
                Supplier directory, contacts, product categories, and sourcing status.
              </div>
            </div>
            <div className="page-header-actions" style={{ display: "flex", gap: "10px", alignItems: "center" }}>
              <button
                type="button"
                className="btn"
                style={{
                  background: filterOpen ? "#0061f2" : "#475569",
                  color: "#ffffff",
                  padding: "8px 14px",
                  borderRadius: "6px",
                  border: "none",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  cursor: "pointer",
                  boxShadow: "0 2px 4px rgba(0,0,0,0.1)",
                }}
                onClick={() => setFilterOpen((v) => !v)}
                title="Toggle Filter Options"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                </svg>
              </button>
              {canCreate && (
                <button className="btn btn-quick-add" onClick={() => openModal(null, "quick")}>
                  + QUICK ADD
                </button>
              )}
              {canCreate && (
                <button className="btn btn-add-new" onClick={() => openModal(null, "full")}>
                  + ADD NEW
                </button>
              )}
              <Can permission="supplier.import">
                <ImpExpDropdown
                  apiBase="/suppliers"
                  entityName="supplier"
                  importHeaders={SUPPLIER_IMPORT_HEADERS}
                  onSummary={setImportSummary}
                  onError={setImportError}
                  onComplete={() => reload()}
                  onExportCsv={() => handleExport("csv")}
                />
              </Can>
              <BulkActionsDropdown
                selectedCount={selectedIds.length}
                onBulkDelete={canDelete ? handleBulkDelete : undefined}
              />
            </div>
          </div>
          <Banner error={error} />
          <ImportSummaryPanel summary={importSummary} error={importError} />

          {/* TOGGLABLE TOP FILTER PANEL */}
          {filterOpen && (
            <div
              className="card"
              style={{
                background: "#ffffff",
                padding: "20px",
                borderRadius: "10px",
                border: "1px solid #cbd5e1",
                marginBottom: "16px",
                boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.05)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", color: "#0f172a", display: "flex", alignItems: "center", gap: "6px" }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
                  </svg>
                  Filter Options
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  style={{ background: "#f1f5f9", color: "#475569", border: "1px solid #cbd5e1", borderRadius: "6px", cursor: "pointer", fontWeight: 600 }}
                  onClick={handleResetFilters}
                >
                  Reset Filters
                </button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "14px" }}>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Product Category</label>
                  <SearchableDropdown
                    value={categoryFilter}
                    onChange={(v) => {
                      setCurrentPage(1);
                      setCategoryFilter(v);
                    }}
                    placeholder="Filter: Product Category"
                    fetchOptions={searchFetcher("/masters/product-categories")}
                    fetchLabelForValue={fetchNameLabel("/masters/product-categories")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Key Strength Sub Category</label>
                  <SearchableDropdown
                    value={subCategoryFilter}
                    onChange={(v) => {
                      setCurrentPage(1);
                      setSubCategoryFilter(v);
                    }}
                    placeholder="Filter: Sub Category"
                    fetchOptions={searchFetcher("/masters/product-sub-categories")}
                    fetchLabelForValue={fetchNameLabel("/masters/product-sub-categories")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Product Supplied</label>
                  <SearchableDropdown
                    value={productFilter}
                    onChange={(v) => {
                      setCurrentPage(1);
                      setProductFilter(v);
                    }}
                    placeholder="Filter: Product"
                    fetchOptions={productFetcher}
                    fetchLabelForValue={fetchProductLabel}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Country</label>
                  <SearchableDropdown
                    value={countryFilter}
                    onChange={(v) => {
                      setCountryFilter(v);
                      setStateFilter(null);
                      setCityFilter(null);
                      setCurrentPage(1);
                    }}
                    placeholder="Filter: Country"
                    fetchOptions={searchFetcher("/masters/countries")}
                    fetchLabelForValue={fetchNameLabel("/masters/countries")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Province / State</label>
                  <SearchableDropdown
                    value={stateFilter}
                    onChange={(v) => {
                      setStateFilter(v);
                      setCityFilter(null);
                      setCurrentPage(1);
                    }}
                    placeholder="Filter: Province"
                    fetchOptions={searchFetcher("/masters/states", (): Record<string, string> =>
                      countryFilter ? { country_id: countryFilter } : {}
                    )}
                    fetchLabelForValue={fetchNameLabel("/masters/states")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>City</label>
                  <SearchableDropdown
                    value={cityFilter}
                    onChange={(v) => {
                      setCityFilter(v);
                      setCurrentPage(1);
                    }}
                    placeholder="Filter: City"
                    fetchOptions={searchFetcher("/masters/cities", (): Record<string, string> => {
                      if (stateFilter) return { state_id: stateFilter };
                      if (countryFilter) return { country_id: countryFilter };
                      return {};
                    })}
                    fetchLabelForValue={fetchNameLabel("/masters/cities")}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Supplier Type</label>
                  <SearchableDropdown
                    value={supplierTypeFilter || null}
                    onChange={(_v, label) => {
                      setCurrentPage(1);
                      setSupplierTypeFilter(label || _v || "");
                    }}
                    allowCustomText={true}
                    onTextChange={(text) => {
                      setCurrentPage(1);
                      setSupplierTypeFilter(text);
                    }}
                    placeholder="Filter: Supplier Type"
                    fetchOptions={searchFetcher("/masters/supplier-types")}
                    fetchLabelForValue={async (val) => val}
                  />
                </div>

                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Supplier's Grade</label>
                  <select
                    value={gradeFilter}
                    onChange={(e) => {
                      setCurrentPage(1);
                      setGradeFilter(e.target.value);
                    }}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">Grade: All</option>
                    <option value="A">Grade A</option>
                    <option value="B">Grade B</option>
                    <option value="C">Grade C</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Current Status</label>
                  <select
                    value={statusFilter}
                    onChange={(e) => {
                      setCurrentPage(1);
                      setStatusFilter(e.target.value);
                    }}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">Current Status: All</option>
                    <option value="new">New</option>
                    <option value="existing">Existing</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Potential</label>
                  <select
                    value={potentialFilter}
                    onChange={(e) => {
                      setCurrentPage(1);
                      setPotentialFilter(e.target.value);
                    }}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">Potential: All</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", marginBottom: "4px", display: "block" }}>Visited Factory/Office?</label>
                  <select
                    value={visitedFilter}
                    onChange={(e) => {
                      setCurrentPage(1);
                      setVisitedFilter(e.target.value);
                    }}
                    style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                  >
                    <option value="">Visited Factory/Office: All</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          <div className="card">
            <div className="toolbar" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 20px", gap: "12px", flexWrap: "wrap" }}>
              <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <select
                    value={pageSize}
                    onChange={(e) => {
                      setPageSize(Number(e.target.value));
                      setCurrentPage(1);
                    }}
                    style={{ padding: "6px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                  >
                    <option value={10}>10</option>
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                  <span style={{ fontSize: "13px", color: "#64748b", fontWeight: 500 }}>Items/Page</span>
                </div>

                <div ref={pinMenuRef} style={{ position: "relative" }}>


                  <button
                    type="button"
                    onClick={() => setPinMenuOpen((v) => !v)}
                    style={{
                      padding: "6px 12px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      background: pinMenuOpen ? "#e2e8f0" : "#ffffff",
                      cursor: "pointer",
                      color: "#0f172a",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                    }}
                  >
                    📌 Freeze Columns ({Object.keys(pinnedCols).length})
                  </button>
                  {pinMenuOpen && (
                    <div
                      style={{
                        position: "absolute",
                        right: 0,
                        top: "38px",
                        zIndex: 100,
                        background: "#ffffff",
                        border: "1px solid #cbd5e1",
                        borderRadius: "8px",
                        boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                        padding: "12px",
                        minWidth: "220px",
                        maxHeight: "300px",
                        overflowY: "auto",
                      }}
                    >
                      <div style={{ fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "8px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                        Toggle Frozen Columns
                      </div>
                      {[
                        "Checkbox", "Sr. No.", "Company Name", "Product Category",
                        "Key Strength Sub-Category", "Products Supplied", "Secondary Products",
                        "Country", "City, Province", "Brand", "Supplier Type",
                        "Current Status", "Grade", "Potential", "Action"
                      ].map((label, idx) => {
                        const isPinned = Boolean(pinnedCols[idx]);
                        return (
                          <label key={label} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", padding: "4px 0" }}>
                            <input type="checkbox" checked={isPinned} onChange={() => togglePin(idx)} /> {label}
                          </label>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => setPinnedCols({})}
                        style={{
                          marginTop: "8px",
                          width: "100%",
                          padding: "6px 8px",
                          fontSize: "12px",
                          borderRadius: "4px",
                          border: "1px solid #e2e8f0",
                          background: "#f8fafc",
                          cursor: "pointer",
                          color: "#dc2626",
                          fontWeight: 600,
                        }}
                      >
                        Clear All Freezes
                      </button>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
                <input
                  type="text"
                  placeholder="Search company name or Sr. No..."
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  style={{ width: "320px", padding: "8px 36px 8px 14px", borderRadius: "6px", border: "1px solid #cbd5e1" }}
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => setSearchInput("")}
                    title="Clear search"
                    style={{
                      position: "absolute",
                      right: "8px",
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: "#94a3b8",
                      fontSize: "16px",
                      lineHeight: 1,
                      padding: "0 2px",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    ×
                  </button>
                )}
              </div>
            </div>

            <div className="table-scroll">
              <table ref={tableRef}>

                <thead>
                  <tr>
                    {displayOrder.map((idx) => {
                      if (idx === 0) {
                        return (
                          <th key="col-0" style={getFreezeStyle(0, true)}>
                            <input
                              type="checkbox"
                              checked={rows.length > 0 && rows.every((r) => selectedIds.includes(r.id))}
                              onChange={(e) => {
                                if (e.target.checked) setSelectedIds(rows.map((r) => r.id));
                                else setSelectedIds([]);
                              }}
                              style={{ cursor: "pointer", width: "16px", height: "16px" }}
                            />
                          </th>
                        );
                      }
                      const label = [
                        "Checkbox", "Sr. No.", "Company Name", "Product Category",
                        "Key Strength Sub-Category", "Products Supplied", "Secondary Products",
                        "Country", "City, Province", "Brand", "Supplier Type",
                        "Current Status", "Grade", "Potential", "Action"
                      ][idx];
                      const isPinned = Boolean(pinnedCols[idx]);
                      return (
                        <th key={`col-${idx}-${label}`} style={{ ...(idx === 14 ? { textAlign: "center" } : {}), ...getFreezeStyle(idx, true) }}>
                          <div style={{ display: "flex", alignItems: "center", justifyContent: idx === 14 ? "center" : "space-between", gap: "4px" }}>
                            <span>{label}</span>
                            <button type="button" onClick={() => togglePin(idx)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: "11px", opacity: isPinned ? 1 : 0.3 }} title={isPinned ? "Unfreeze column" : "Freeze column"}>
                              📌
                            </button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody ref={tableBodyRef} data-names-version={namesVersion}>
                  {loading ? (
                    <TableMessageRow colSpan={15}>Loading...</TableMessageRow>
                  ) : rows.length === 0 ? (
                    <TableMessageRow colSpan={15}>No suppliers found.</TableMessageRow>
                  ) : (
                    rows.map((s, index) => (
                      <tr key={s.id}>
                        {displayOrder.map((idx) => {
                          switch (idx) {
                            case 0:
                              return (
                                <td key="cell-0" style={getFreezeStyle(0, false)}>
                                  <input
                                    type="checkbox"
                                    className="row-select"
                                    checked={selectedIds.includes(s.id)}
                                    onChange={(e) => {
                                      if (e.target.checked) setSelectedIds((prev) => [...prev, s.id]);
                                      else setSelectedIds((prev) => prev.filter((i) => i !== s.id));
                                    }}
                                    style={{ cursor: "pointer", width: "16px", height: "16px" }}
                                  />
                                </td>
                              );
                            case 1:
                              return (
                                <td key="cell-1" className="cell-srno" style={getFreezeStyle(1, false)}>
                                  {startSrNo + index}
                                </td>
                              );
                            case 2:
                              return (
                                <td key="cell-2" style={getFreezeStyle(2, false)}>
                                  <a
                                    href="#"
                                    onClick={(e) => {
                                      e.preventDefault();
                                      setDrawerSupplier(s);
                                    }}
                                  >
                                    {s.company_name}
                                  </a>
                                </td>
                              );
                            case 3:
                              return <td key="cell-3" style={getFreezeStyle(3, false)}>{chipList(s.category_ids, "categories", "Product Categories")}</td>;
                            case 4:
                              return <td key="cell-4" style={getFreezeStyle(4, false)}>{chipList(s.sub_category_ids, "subCategories", "Sub-Categories")}</td>;
                            case 5:
                              return <td key="cell-5" style={getFreezeStyle(5, false)}>{chipList(s.product_ids, "products", "Products Supplied")}</td>;
                            case 6:
                              return <td key="cell-6" style={getFreezeStyle(6, false)}>{renderTruncatedText(s.secondary_products_description, 20, "Secondary Products")}</td>;
                            case 7:
                              return <td key="cell-7" style={getFreezeStyle(7, false)}>{resolver.get("countries", s.country_id) || "…"}</td>;
                            case 8:
                              return (
                                <td key="cell-8" style={getFreezeStyle(8, false)}>
                                  {resolver.get("cities", s.city_id) || "…"},{" "}
                                  {resolver.get("states", s.state_id) || "…"}
                                </td>
                              );
                            case 9:
                              return <td key="cell-9" style={getFreezeStyle(9, false)}>{renderTruncatedText(s.brand_description, 20, "Brand Description")}</td>;
                            case 10:
                              return (
                                <td key="cell-10" style={getFreezeStyle(10, false)}>
                                  {s.supplier_type ? s.supplier_type : <span className="muted">—</span>}
                                </td>
                              );
                            case 11:
                              return (
                                <td key="cell-11" style={getFreezeStyle(11, false)}>
                                  <StatusPill value={s.current_status} />
                                </td>
                              );
                            case 12:
                              return (
                                <td key="cell-12" style={getFreezeStyle(12, false)}>
                                  {canUpdate ? (
                                    <select
                                      className="inline-select"
                                      defaultValue={s.supplier_grade || ""}
                                      onChange={(e) =>
                                        handleInlineUpdate(`/suppliers/${s.id}/grade`, {
                                          supplier_grade: e.target.value || null,
                                        })
                                      }
                                    >
                                      <option value="">Select</option>
                                      <option value="A">A</option>
                                      <option value="B">B</option>
                                      <option value="C">C</option>
                                    </select>
                                  ) : (
                                    <span>{s.supplier_grade || "—"}</span>
                                  )}
                                </td>
                              );
                            case 13:
                              return (
                                <td key="cell-13" style={getFreezeStyle(13, false)}>
                                  {canUpdate ? (
                                    <select
                                      className="inline-select"
                                      defaultValue={s.potential || ""}
                                      onChange={(e) =>
                                        handleInlineUpdate(`/suppliers/${s.id}/potential`, {
                                          potential: e.target.value || null,
                                        })
                                      }
                                    >
                                      <option value="">Select</option>
                                      <option value="yes">Yes</option>
                                      <option value="no">No</option>
                                    </select>
                                  ) : (
                                    <span>{s.potential ? s.potential.toUpperCase() : "—"}</span>
                                  )}
                                </td>
                              );
                            case 14:
                              return (
                                <td key="cell-14" className="actions" style={{ textAlign: "center", ...getFreezeStyle(14, false) }}>
                                  <div style={{ display: "flex", gap: "6px", justifyContent: "center", alignItems: "center" }}>
                                    {canUpdate && (
                                      <button
                                        type="button"
                                        className="btn"
                                        style={{
                                          background: "#0061f2",
                                          color: "#ffffff",
                                          padding: "6px 9px",
                                          borderRadius: "4px",
                                          border: "none",
                                          cursor: "pointer",
                                          display: "inline-flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                        }}
                                        onClick={() => handleRowEdit(s.id)}
                                        title="Edit Supplier"
                                      >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 2 2h14a2 2 0 0 2 2v-7" />
                                          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                        </svg>
                                      </button>
                                    )}
                                    {canDelete && (
                                      <button
                                        type="button"
                                        className="btn"
                                        style={{
                                          background: "#ef4444",
                                          color: "#ffffff",
                                          padding: "6px 9px",
                                          borderRadius: "4px",
                                          border: "none",
                                          cursor: "pointer",
                                          display: "inline-flex",
                                          alignItems: "center",
                                          justifyContent: "center",
                                        }}
                                        onClick={() => handleRowDelete(s.id)}
                                        title="Delete Supplier"
                                      >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                          <polyline points="3 6 5 6 21 6" />
                                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                          <line x1="10" y1="11" x2="10" y2="17" />
                                          <line x1="14" y1="11" x2="14" y2="17" />
                                        </svg>
                                      </button>
                                    )}
                                  </div>
                                </td>
                              );
                            default:
                              return null;
                          }
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="pagination">
              <Pagination
                pagination={pagination}
                pageSize={pageSize}
                onPageChange={setCurrentPage}
                onPageSizeChange={(size) => {
                  setPageSize(size);
                  setCurrentPage(1);
                }}
              />
            </div>
          </div>
        </main>
      )}

      <ModalAlert
        isOpen={Boolean(alertPopup)}
        title={alertPopup?.title}
        message={alertPopup?.message || ""}
        onClose={() => setAlertPopup(null)}
      />

      {drawerSupplier && (
        <SideDrawer
          open={Boolean(drawerSupplier)}
          title={`Supplier Detail #${drawerSupplier.company_name}`}
          subtitle={`Supplier Type: ${drawerSupplier.supplier_type || "—"} | Status: ${drawerSupplier.is_active ? "Active" : "Inactive"}`}
          onClose={() => setDrawerSupplier(null)}
          onEdit={
            canUpdate
              ? () => {
                  const id = drawerSupplier.id;
                  setDrawerSupplier(null);
                  void handleRowEdit(id);
                }
              : undefined
          }
          editLabel="✏️ Edit Supplier"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <DetailFieldGrid
              fields={[
                { label: "Company Name", value: drawerSupplier.company_name, fullWidth: true },
                { label: "Supplier Type", value: drawerSupplier.supplier_type || "—" },
                { label: "Brand Description", value: drawerSupplier.brand_description || "—" },
                { label: "Country", value: resolver.get("countries", drawerSupplier.country_id) || "—" },
                { label: "Province / State", value: resolver.get("states", drawerSupplier.state_id) || "—" },
                { label: "City", value: resolver.get("cities", drawerSupplier.city_id) || "—" },
                { label: "Product Categories", value: chipList(drawerSupplier.category_ids, "categories"), fullWidth: true },
                { label: "Sub-Categories", value: chipList(drawerSupplier.sub_category_ids, "subCategories"), fullWidth: true },
                { label: "Products Supplied", value: chipList(drawerSupplier.product_ids, "products"), fullWidth: true },
                { label: "Secondary Products", value: drawerSupplier.secondary_products_description || "—", fullWidth: true },
              ]}
            />

            <div style={{ background: "#f8fafc", padding: "16px", borderRadius: "10px", border: "1px solid #e2e8f0" }}>
              <h4 style={{ fontSize: "14px", fontWeight: 700, margin: "0 0 12px 0", color: "#0f172a" }}>
                Primary Contact Information
              </h4>
              <DetailFieldGrid
                fields={[
                  {
                    label: "Full Name",
                    value: `${drawerSupplier.contact_salutation || ""} ${drawerSupplier.contact_full_name || ""}`.trim() || "—",
                  },
                  { label: "Designation", value: drawerSupplier.contact_designation || "—" },
                  { label: "Calling Number", value: drawerSupplier.contact_calling_number || "—" },
                  { label: "WhatsApp Number", value: drawerSupplier.contact_whatsapp_number || "—" },
                  { label: "WeChat Number", value: drawerSupplier.contact_wechat_number || "—" },
                  { label: "Email Addresses", value: drawerSupplier.emails && drawerSupplier.emails.length ? drawerSupplier.emails.join(", ") : "—", fullWidth: true },
                  { label: "Primary Website", value: drawerSupplier.primary_website || "—" },
                  { label: "Secondary Website", value: drawerSupplier.secondary_website || "—" },
                ]}
              />
            </div>

            <DetailFieldGrid
              fields={[
                { label: "Supplier Grade", value: drawerSupplier.supplier_grade || "—" },
                { label: "Current Status", value: <StatusPill value={drawerSupplier.current_status} /> },
                { label: "Potential", value: drawerSupplier.potential || "—" },
                { label: "Visited Factory/Office", value: drawerSupplier.visited_factory_office ? "Yes" : "No" },
                { label: "Overall Remarks", value: drawerSupplier.overall_remarks || "—", fullWidth: true },
              ]}
            />
          </div>
        </SideDrawer>
      )}
    </AppShell>
  );
}
