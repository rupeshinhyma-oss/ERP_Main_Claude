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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { ImpExpDropdown, BulkActionsDropdown, ImportSummaryPanel } from "@/components/ImportWizard";
import {
  SearchableDropdown,
  SearchableDropdownMulti,
  type DropdownOption,
} from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
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

const MAX_CHIPS = 5;

type ModalTab = "first" | "second" | "contacts";

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
  const [pageSize, setPageSize] = useState(20);
  const [reloadCounter, setReloadCounter] = useState(0);
  const [namesVersion, setNamesVersion] = useState(0);

  const [searchInput, setSearchInput] = useState("");
  const [effectiveSearch, setEffectiveSearch] = useState("");
  const srNoJump = useSrNoJump();
  const tableBodyRef = useRef<HTMLTableSectionElement>(null);

  /* Filters */
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

  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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

  /* Contacts */
  const [contacts, setContacts] = useState<SupplierContact[]>([]);
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM);
  const [contactCountryId, setContactCountryId] = useState<string | null>(null);

  const setField = (id: keyof typeof EMPTY_SUPPLIER_FORM, value: string) =>
    setForm((prev) => ({ ...prev, [id]: value }));

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

  function chipList(ids: string[] | undefined, tableKey: string) {
    if (!ids || !ids.length) return <span className="muted">—</span>;
    const names = ids.map((id) => resolver.get(tableKey, id) || "…");
    const shown = names.slice(0, MAX_CHIPS);
    const remaining = names.length - shown.length;
    return (
      <div className="chip-list">
        {shown.map((n, i) => (
          <span className="chip" key={`${n}-${i}`}>
            {n}
          </span>
        ))}
        {remaining > 0 && (
          <button
            type="button"
            className="chip-more"
            title={names.join(", ")}
            onClick={() => alert(names.join(", "))}
          >
            +{remaining} more
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

    setError(null);
    try {
      const { stateId, cityId } = await resolveCustomGeography(formCountryId);
      if (!stateId && !formStateCustomText.trim()) {
        setError("Province is required.");
        return false;
      }
      if (!cityId && !formCityCustomText.trim()) {
        setError("City is required.");
        return false;
      }
      const categoryIds = await resolveCustomCategories();

      const basePayload = buildPayload();
      const payload = {
        ...basePayload,
        state_id: stateId || formStateId,
        city_id: cityId || formCityId,
        category_ids: categoryIds,
      };

      const { data: supplier } = currentSupplierId
        ? await apiPatch<Supplier>(`/suppliers/${currentSupplierId}`, payload)
        : await apiPost<Supplier>("/suppliers", payload);
      setCurrentSupplierId(supplier.id);
      setContacts(supplier.contacts || []);
      reload();

      if (nextAction === "exit") {
        closeModal();
      } else if (nextAction) {
        setModalTab(nextAction);
      }
      return true;
    } catch (err) {
      setError(err);
      return false;
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

  async function handleSaveAndContinue(e: React.MouseEvent, nextTab: ModalTab) {
    e.preventDefault();
    await saveSupplierData(nextTab);
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
    setContactCountryId(contact?.country_id || null);
    setContactFormOpen(true);
  }

  async function handleContactSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentSupplierId) return;
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
    try {
      if (contactForm.id) {
        await apiPatch(`/suppliers/${currentSupplierId}/contacts/${contactForm.id}`, payload);
      } else {
        await apiPost(`/suppliers/${currentSupplierId}/contacts`, payload);
      }
      setContactFormOpen(false);
      await refreshContacts();
    } catch (err) {
      setError(err);
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
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleBulkDelete() {
    if (!selectedIds.length) return;
    if (!confirm(`Delete ${selectedIds.length} selected supplier(s)? This cannot be undone.`)) return;
    try {
      await Promise.all(selectedIds.map((id) => apiDelete(`/suppliers/${id}`)));
      setSelectedIds([]);
      reload();
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
  const visited = form.visited_factory_office === "true";

  return (
    <AppShell activeKey="suppliers" pageClassName="page-suppliers">
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
          </div>
        </div>
        <Banner error={error} />
        <ImportSummaryPanel summary={importSummary} error={importError} />

        <div className="card">
          <div className="toolbar">
            <input
              type="text"
              placeholder="Search company name or Sr. No..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
            <div style={{ minWidth: "200px" }}>
              <SearchableDropdown
                value={categoryFilter}
                onChange={(v) => {
                  setCurrentPage(1);
                  setCategoryFilter(v);
                }}
                placeholder="Filter: Product Category"
                fetchOptions={searchFetcher("/masters/product-categories")}
              />
            </div>
            <div style={{ minWidth: "200px" }}>
              <SearchableDropdown
                value={subCategoryFilter}
                onChange={(v) => {
                  setCurrentPage(1);
                  setSubCategoryFilter(v);
                }}
                placeholder="Filter: Key Strength Sub-Category"
                fetchOptions={searchFetcher("/masters/product-sub-categories")}
              />
            </div>
            <div style={{ minWidth: "200px" }}>
              <SearchableDropdown
                value={productFilter}
                onChange={(v) => {
                  setCurrentPage(1);
                  setProductFilter(v);
                }}
                placeholder="Filter: Product Supplied"
                fetchOptions={productFetcher}
              />
            </div>
            <div style={{ minWidth: "180px" }}>
              <SearchableDropdown
                value={countryFilter}
                onChange={(v) => {
                  setCountryFilter(v);
                  // Narrowing the country invalidates province and city.
                  setStateFilter(null);
                  setCityFilter(null);
                  setCurrentPage(1);
                }}
                placeholder="Filter: Country"
                fetchOptions={searchFetcher("/masters/countries")}
              />
            </div>
            <div style={{ minWidth: "180px" }}>
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
              />
            </div>
            <div style={{ minWidth: "180px" }}>
              <SearchableDropdown
                value={cityFilter}
                onChange={(v) => {
                  setCityFilter(v);
                  setCurrentPage(1);
                }}
                placeholder="Filter: City"
                fetchOptions={searchFetcher("/masters/cities", (): Record<string, string> =>
                  stateFilter ? { state_id: stateFilter } : {}
                )}
              />
            </div>
            <select
              value={supplierTypeFilter}
              onChange={(e) => {
                setCurrentPage(1);
                setSupplierTypeFilter(e.target.value);
              }}
            >
              <option value="">Supplier Type: All</option>
              <option value="manufacturer">Manufacturer</option>
              <option value="trader">Trader</option>
            </select>
            <select
              value={gradeFilter}
              onChange={(e) => {
                setCurrentPage(1);
                setGradeFilter(e.target.value);
              }}
            >
              <option value="">Grade: All</option>
              <option value="A">A</option>
              <option value="B">B</option>
              <option value="C">C</option>
            </select>
            <select
              value={statusFilter}
              onChange={(e) => {
                setCurrentPage(1);
                setStatusFilter(e.target.value);
              }}
            >
              <option value="">Current Status: All</option>
              <option value="new">New</option>
              <option value="existing">Existing</option>
            </select>
            <select
              value={potentialFilter}
              onChange={(e) => {
                setCurrentPage(1);
                setPotentialFilter(e.target.value);
              }}
            >
              <option value="">Potential: All</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
            <select
              value={visitedFilter}
              onChange={(e) => {
                setCurrentPage(1);
                setVisitedFilter(e.target.value);
              }}
            >
              <option value="">Visited Factory/Office: All</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
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
                  <th>Sr. No.</th>
                  <th>Company Name</th>
                  <th>Product Category</th>
                  <th>Key Strength Sub-Category</th>
                  <th>Products Supplied</th>
                  <th>Secondary Products</th>
                  <th>Country</th>
                  <th>City, Province</th>
                  <th>Brand</th>
                  <th>Supplier Type</th>
                  <th>Current Status</th>
                  <th>Grade</th>
                  <th>Potential</th>
                  <th />
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
                      <td>
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
                      <td className="cell-srno">{startSrNo + index}</td>
                      <td>
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            void handleRowEdit(s.id);
                          }}
                        >
                          {s.company_name}
                        </a>
                      </td>
                      <td>{chipList(s.category_ids, "categories")}</td>
                      <td>{chipList(s.sub_category_ids, "subCategories")}</td>
                      <td>{chipList(s.product_ids, "products")}</td>
                      <td>
                        {s.secondary_products_description ? (
                          s.secondary_products_description.slice(0, 60)
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>{resolver.get("countries", s.country_id) || "…"}</td>
                      <td>
                        {resolver.get("cities", s.city_id) || "…"},{" "}
                        {resolver.get("states", s.state_id) || "…"}
                      </td>
                      <td>
                        {s.brand_description ? (
                          s.brand_description
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {s.supplier_type ? s.supplier_type : <span className="muted">—</span>}
                      </td>
                      <td>
                        <StatusPill value={s.current_status} />
                      </td>
                      <td>
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
                      <td>
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
                      <td className="actions">
                        {canUpdate && (
                          <button className="btn btn-small" onClick={() => handleRowEdit(s.id)}>
                            Edit
                          </button>
                        )}
                        {canDelete && (
                          <button
                            className="btn btn-small btn-danger"
                            onClick={() => handleRowDelete(s.id)}
                          >
                            Delete
                          </button>
                        )}
                      </td>
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

      {/* ============ CREATE / EDIT SUPPLIER MODAL ============ */}
      {modalOpen && (
        <div
          className="modal-backdrop"
          style={{ display: "flex" }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div className="modal-card" style={{ maxWidth: "820px" }}>
            <div className="modal-header">
              <h2>
                {modalMode === "quick"
                  ? "Quick Add Supplier"
                  : currentSupplierId && form.company_name
                    ? `Edit ${form.company_name}`
                    : "New Supplier"}
              </h2>
              <button className="modal-close" onClick={closeModal}>
                &times;
              </button>
            </div>

            {modalMode === "full" && (
              <div className="toolbar" style={{ marginBottom: "var(--space-3)" }}>
                <button
                  type="button"
                  className={`btn btn-small ${modalTab === "first" ? "btn-primary" : ""}`}
                  onClick={() => setModalTab("first")}
                >
                  1. First Data Form
                </button>
                <button
                  type="button"
                  className={`btn btn-small ${modalTab === "second" ? "btn-primary" : ""}`}
                  onClick={() => setModalTab("second")}
                >
                  2. Main Profile
                </button>
                {currentSupplierId && (
                  <button
                    type="button"
                    className={`btn btn-small ${modalTab === "contacts" ? "btn-primary" : ""}`}
                    style={{ display: "inline-flex" }}
                    onClick={() => setModalTab("contacts")}
                  >
                    3. Contacts
                  </button>
                )}
              </div>
            )}

            <form onSubmit={handleSubmit}>
              {/* TAB 1 */}
              <div style={{ display: modalTab === "first" ? "block" : "none" }}>
                <div className="form-grid">
                  <div className="field">
                    <label>Name of Company *</label>
                    <SearchableDropdown
                      value={form.company_name}
                      onChange={(_, label) => setField("company_name", label)}
                      allowCustomText={true}
                      onTextChange={(v) => setField("company_name", v)}
                      placeholder="Search existing or type company name..."
                      fetchOptions={companyNameFetcher}
                      fetchLabelForValue={async (v) => v}
                    />
                  </div>
                  <div className="field">
                    <label>Product Category (multiple)</label>
                    <SearchableDropdownMulti
                      values={formCategoryIds}
                      onChange={setFormCategoryIds}
                      allowCustomText={false}
                      placeholder="Click to select product categories..."
                      fetchOptions={searchFetcher("/masters/product-categories")}
                      fetchLabelForValue={fetchNameLabel("/masters/product-categories")}
                    />
                  </div>
                  <SelectField id="supplier_type" label="Supplier Type" value={form.supplier_type} onChange={(v) => setField("supplier_type", v)}>
                    <option value="">Select</option>
                    <option value="manufacturer">Manufacturer</option>
                    <option value="trader">Trader</option>
                    <option value="agent">Agent</option>
                    <option value="exporter">Exporter</option>
                    <option value="wholesaler">Wholesaler</option>
                    <option value="distributor">Distributor</option>
                  </SelectField>
                  <TextAreaField id="brand_description" label="Brand of Supplier's Products" placeholder="Description..." value={form.brand_description} onChange={(v) => setField("brand_description", v)} />
                  <div className="field">
                    <label>Country *</label>
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
                    <label>Province *</label>
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
                        if (!formStateId) setFormStateId(null);
                      }}
                      placeholder="Search or type province..."
                      fetchOptions={searchFetcher("/masters/states", (): Record<string, string> =>
                        formCountryId ? { country_id: formCountryId } : {}
                      )}
                      fetchLabelForValue={fetchNameLabel("/masters/states")}
                    />
                  </div>
                  <div className="field">
                    <label>City *</label>
                    <SearchableDropdown
                      value={formCityId}
                      onChange={(v, label) => {
                        setFormCityId(v);
                        setFormCityCustomText(v ? label : "");
                      }}
                      allowCustomText={true}
                      onTextChange={(text) => {
                        setFormCityCustomText(text);
                        if (!formCityId) setFormCityId(null);
                      }}
                      placeholder="Search or type city..."
                      fetchOptions={searchFetcher("/masters/cities", (): Record<string, string> =>
                        formStateId ? { state_id: formStateId } : {}
                      )}
                      fetchLabelForValue={fetchNameLabel("/masters/cities")}
                    />
                  </div>
                </div>

                <div className="section-title">Primary Contact</div>
                <div className="form-grid">
                  <SelectField id="contact_salutation" label="Salutation" value={form.contact_salutation} onChange={(v) => setField("contact_salutation", v)}>
                    <option value="">—</option>
                    <option value="Mr.">Mr.</option>
                    <option value="Mrs.">Mrs.</option>
                    <option value="Ms.">Ms.</option>
                  </SelectField>
                  <TextField id="contact_full_name" label="Full Name" maxLength={150} value={form.contact_full_name} onChange={(v) => setField("contact_full_name", v)} />
                  <TextField id="contact_designation" label="Designation" maxLength={150} value={form.contact_designation} onChange={(v) => setField("contact_designation", v)} />

                  <div className="field">
                    <label htmlFor="contact_calling_number">Calling Number</label>
                    <input
                      type="text"
                      id="contact_calling_number"
                      className="input"
                      maxLength={11}
                      placeholder="With country code, 7-11 digits"
                      value={form.contact_calling_number}
                      onChange={(e) => {
                        const v = e.target.value;
                        setField("contact_calling_number", v);
                        if (whatsappSameAsCalling) setField("contact_whatsapp_number", v);
                        if (wechatSameAsCalling) setField("contact_wechat_number", v);
                        if (callingNumberError) validateCallingNumber(v);
                      }}
                      onBlur={(e) => validateCallingNumber(e.target.value)}
                    />
                    {callingNumberError && (
                      <span className="hint" style={{ color: "var(--color-danger, #ef4444)", display: "block", marginTop: "4px" }}>
                        {callingNumberError}
                      </span>
                    )}
                  </div>

                  <div className="field">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      <label htmlFor="contact_whatsapp_number" style={{ margin: 0 }}>WhatsApp Number</label>
                      <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontWeight: "normal", color: "var(--color-text-secondary, #64748b)" }}>
                        <input
                          type="checkbox"
                          checked={whatsappSameAsCalling}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setWhatsappSameAsCalling(checked);
                            if (checked) {
                              setField("contact_whatsapp_number", form.contact_calling_number);
                            }
                          }}
                        />
                        Same as calling
                      </label>
                    </div>
                    <input
                      type="text"
                      id="contact_whatsapp_number"
                      className="input"
                      maxLength={11}
                      value={form.contact_whatsapp_number}
                      disabled={whatsappSameAsCalling}
                      onChange={(e) => setField("contact_whatsapp_number", e.target.value)}
                    />
                  </div>

                  <div className="field">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                      <label htmlFor="contact_wechat_number" style={{ margin: 0 }}>WeChat Number</label>
                      <label style={{ fontSize: "11px", display: "flex", alignItems: "center", gap: "4px", cursor: "pointer", fontWeight: "normal", color: "var(--color-text-secondary, #64748b)" }}>
                        <input
                          type="checkbox"
                          checked={wechatSameAsCalling}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setWechatSameAsCalling(checked);
                            if (checked) {
                              setField("contact_wechat_number", form.contact_calling_number);
                            }
                          }}
                        />
                        Same as calling
                      </label>
                    </div>
                    <input
                      type="text"
                      id="contact_wechat_number"
                      className="input"
                      maxLength={20}
                      value={form.contact_wechat_number}
                      disabled={wechatSameAsCalling}
                      onChange={(e) => setField("contact_wechat_number", e.target.value)}
                    />
                  </div>

                  <TextField id="emails_input" label="Email ID(s)" placeholder="comma-separated for multiple" hint="Separate multiple emails with commas." value={form.emails_input} onChange={(v) => setField("emails_input", v)} />
                  {modalMode === "quick" && (
                    <div className="field" style={{ gridColumn: "span 2", display: "flex", alignItems: "flex-start", paddingTop: "24px" }}>
                      <button
                        type="submit"
                        className="btn btn-primary"
                        style={{ minWidth: "180px", padding: "10px 24px", justifyContent: "center" }}
                      >
                        Save
                      </button>
                    </div>
                  )}
                </div>

                {modalMode === "full" && (
                  <div className="form-actions" style={{ borderTop: "none", display: "flex", gap: "12px", width: "100%" }}>
                    <button
                      type="button"
                      className="btn btn-add-new"
                      style={{ flex: 1, justifyContent: "center" }}
                      onClick={(e) => handleSaveAndContinue(e, "second")}
                    >
                      Save &amp; Continue
                    </button>
                    <button
                      type="button"
                      className="btn btn-quick-add"
                      style={{ flex: 1, justifyContent: "center" }}
                      onClick={handleSaveAndExit}
                    >
                      Save &amp; Exit
                    </button>
                  </div>
                )}
              </div>

              {/* TAB 2 */}
              <div style={{ display: modalTab === "second" ? "block" : "none" }}>
                <div className="form-grid">
                  <TextField id="tax_id_number" label="Tax ID Number" maxLength={100} value={form.tax_id_number} onChange={(v) => setField("tax_id_number", v)} />
                  <TextField id="town" label="Town" maxLength={150} value={form.town} onChange={(v) => setField("town", v)} />
                  <TextField id="primary_website" label="Primary Website" maxLength={500} placeholder="https://..." value={form.primary_website} onChange={(v) => setField("primary_website", v)} />
                  <TextField id="secondary_website" label="Secondary Website" maxLength={500} placeholder="https://..." value={form.secondary_website} onChange={(v) => setField("secondary_website", v)} />
                  <div className="field">
                    <label>Key Strength Product Sub-Category (multiple)</label>
                    <SearchableDropdownMulti
                      values={formSubCategoryIds}
                      onChange={setFormSubCategoryIds}
                      placeholder="Search and add a sub-category..."
                      fetchOptions={searchFetcher("/masters/product-sub-categories")}
                      fetchLabelForValue={fetchNameLabel("/masters/product-sub-categories")}
                    />
                  </div>
                  <div className="field">
                    <label>
                      Products Supplied (multiple) &mdash; specific SKUs from the Product Master
                    </label>
                    <SearchableDropdownMulti
                      values={formProductIds}
                      onChange={setFormProductIds}
                      placeholder="Search and add a product..."
                      fetchOptions={productFetcher}
                      fetchLabelForValue={fetchProductLabel}
                    />
                  </div>
                  <SelectField id="supplier_grade" label="Supplier's Grade" value={form.supplier_grade} onChange={(v) => setField("supplier_grade", v)}>
                    <option value="">Select</option>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                  </SelectField>
                  <div className="field">
                    <label htmlFor="current_status">Current Status</label>
                    <select
                      id="current_status"
                      value={form.current_status}
                      onChange={(e) => setField("current_status", e.target.value)}
                    >
                      <option value="">Select</option>
                      <option value="new" disabled={lockNewStatus}>
                        New
                      </option>
                      <option value="existing">Existing</option>
                    </select>
                    {lockNewStatus && (
                      <span className="hint">Cannot revert from Existing to New.</span>
                    )}
                  </div>
                  <SelectField id="potential" label="Potential" value={form.potential} onChange={(v) => setField("potential", v)}>
                    <option value="">Select</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </SelectField>
                </div>
                <TextAreaField id="potential_reason" label="Key Reason for Potential / Not Potential" value={form.potential_reason} onChange={(v) => setField("potential_reason", v)} />
                <TextAreaField id="secondary_products_description" label="Secondary Products They Can Supply" value={form.secondary_products_description} onChange={(v) => setField("secondary_products_description", v)} />

                <div className="form-grid">
                  <SelectField
                    id="visited_factory_office"
                    label="Visited Their Factory/Office?"
                    value={form.visited_factory_office}
                    onChange={(v) => {
                      setField("visited_factory_office", v);
                      // Remarks only make sense for a visit that happened.
                      if (v !== "true") setField("visit_remarks", "");
                    }}
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </SelectField>
                </div>
                {visited && (
                  <TextAreaField id="visit_remarks" label="Visit Remarks" value={form.visit_remarks} onChange={(v) => setField("visit_remarks", v)} />
                )}
                <TextField id="visit_media_input" label="Visit Photos / Videos (URLs)" placeholder="comma-separated URLs" value={form.visit_media_input} onChange={(v) => setField("visit_media_input", v)} />
                <TextAreaField id="overall_remarks" label="Overall Remarks / Key Strengths" value={form.overall_remarks} onChange={(v) => setField("overall_remarks", v)} />
                <SelectField id="is_active" label="Status" value={form.is_active} onChange={(v) => setField("is_active", v)}>
                  <option value="true">Active</option>
                  <option value="false">Inactive</option>
                </SelectField>

                <div className="form-actions" style={{ display: "flex", gap: "12px", width: "100%" }}>
                  <button
                    type="button"
                    className="btn btn-add-new"
                    style={{ flex: 1, justifyContent: "center" }}
                    onClick={(e) => handleSaveAndContinue(e, "contacts")}
                  >
                    Save &amp; Continue
                  </button>
                  <button
                    type="button"
                    className="btn btn-quick-add"
                    style={{ flex: 1, justifyContent: "center" }}
                    onClick={handleSaveAndExit}
                  >
                    Save &amp; Exit
                  </button>
                </div>
              </div>
            </form>

            {/* TAB 3: Contacts (only once the supplier exists) */}
            <div style={{ display: modalTab === "contacts" ? "block" : "none" }}>
              <div className="card-header">
                <div className="section-title" style={{ margin: 0 }}>
                  Contact Persons
                </div>
                <button
                  type="button"
                  className="btn btn-small btn-primary"
                  onClick={() => openContactForm(null)}
                >
                  + Add Contact
                </button>
              </div>
              {contactFormOpen && (
                <div
                  style={{
                    border: "1px solid var(--color-border)",
                    borderRadius: "var(--radius-sm)",
                    padding: "var(--space-3)",
                    marginBottom: "var(--space-3)",
                  }}
                >
                  <form onSubmit={handleContactSubmit}>
                    <div className="form-grid">
                      <SelectField id="c_salutation" label="Salutation" value={contactForm.salutation} onChange={(v) => setContactForm((f) => ({ ...f, salutation: v }))}>
                        <option value="">—</option>
                        <option value="Mr.">Mr.</option>
                        <option value="Mrs.">Mrs.</option>
                        <option value="Ms.">Ms.</option>
                      </SelectField>
                      <TextField id="c_person_name" label="Person Name *" required maxLength={150} value={contactForm.person_name} onChange={(v) => setContactForm((f) => ({ ...f, person_name: v }))} />
                      <TextField id="c_designation" label="Designation" maxLength={150} value={contactForm.designation} onChange={(v) => setContactForm((f) => ({ ...f, designation: v }))} />
                      <TextField id="c_handling_territory" label="Handling Territory" maxLength={150} placeholder="local, Export India, Export Africa..." value={contactForm.handling_territory} onChange={(v) => setContactForm((f) => ({ ...f, handling_territory: v }))} />
                      <div className="field">
                        <label>Country</label>
                        <SearchableDropdown
                          value={contactCountryId}
                          onChange={setContactCountryId}
                          placeholder="Search country..."
                          fetchOptions={searchFetcher("/masters/countries")}
                          fetchLabelForValue={fetchNameLabel("/masters/countries")}
                        />
                      </div>
                      <TextField id="c_calling_number" label="Calling Number" maxLength={20} value={contactForm.calling_number} onChange={(v) => setContactForm((f) => ({ ...f, calling_number: v }))} />
                      <TextField id="c_whatsapp_number" label="WhatsApp Number" maxLength={20} value={contactForm.whatsapp_number} onChange={(v) => setContactForm((f) => ({ ...f, whatsapp_number: v }))} />
                      <TextField id="c_wechat_number" label="WeChat Number" maxLength={20} value={contactForm.wechat_number} onChange={(v) => setContactForm((f) => ({ ...f, wechat_number: v }))} />
                      <TextField id="c_email" label="Email" type="email" maxLength={255} value={contactForm.email} onChange={(v) => setContactForm((f) => ({ ...f, email: v }))} />
                    </div>
                    <div className="form-actions">
                      <button type="submit" className="btn btn-primary btn-small">
                        Save Contact
                      </button>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => setContactFormOpen(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              )}
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Name / Designation</th>
                      <th>Calling / WhatsApp</th>
                      <th>WeChat / Email</th>
                      <th>Handling Territory</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.length === 0 ? (
                      <TableMessageRow colSpan={5}>No contacts yet.</TableMessageRow>
                    ) : (
                      contacts.map((c) => (
                        <tr key={c.id}>
                          <td>
                            {c.salutation || ""} {c.person_name}
                            {c.designation && (
                              <>
                                <br />
                                <span className="cell-secondary">{c.designation}</span>
                              </>
                            )}
                            {c.is_primary && (
                              <span className="badge badge-neutral"> Primary</span>
                            )}
                          </td>
                          <td>
                            {[c.calling_number, c.whatsapp_number].filter(Boolean).join(" / ") ||
                              "—"}
                          </td>
                          <td>
                            {[c.wechat_number, c.email].filter(Boolean).join(" / ") || "—"}
                          </td>
                          <td>{c.handling_territory || "—"}</td>
                          <td className="actions">
                            <button
                              className="btn btn-small"
                              onClick={() => openContactForm(c)}
                            >
                              Edit
                            </button>
                            {!c.is_primary && (
                              <button
                                className="btn btn-small btn-danger"
                                onClick={() => handleContactDelete(c.id)}
                              >
                                Delete
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={closeModal}>
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}
