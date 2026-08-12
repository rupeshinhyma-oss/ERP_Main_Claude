/**
 * Buyer (Client) Profiles.
 * Implements the "Add Buyer (Client) Data Form" specification document:
 *  - Top Filter Bar matching Suppliers & Product Master design.
 *  - Single-row toolbar: Items/Page, 📌 Freeze Columns popover (fixed header, scrollable middle list, fixed footer "Clear All Freezes"), Search Input ✕.
 *  - Contiguous sticky column snapping on left edge.
 *  - Squeezed compact form drawer to fit 1 screen without unnecessary scrolling.
 *  - Auto-synced Primary Contact -> Contacts sub-panel.
 *  - 1-Way Status Lock ("Existing" status cannot be changed back to "New").
 *  - Delete protection: records with "Existing" status OR "Yes" potential cannot be deleted.
 *  - 3-Way Duplicate Alert (Company Name + Calling Number + WhatsApp Number).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { SearchableDropdown, SearchableDropdownMulti } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { SideDrawer } from "@/components/SideDrawer";
import { apiDelete, apiGet, apiPatch, apiPost, toQueryString } from "@/lib/api";
import { useLookup } from "@/lib/lookups";
import type { Country, ProductCategory, ProductSubCategory } from "@/types";
import type { Buyer, BuyerContact, BuyerGrade, BuyerPotential } from "@/types/buyers";

const MAX_CHIPS = 5;

const EMPTY_BUYER_FORM = {
  company_name: "",
  buyer_type: "",
  country_id: "",
  city: "",
  address: "",
  contact_salutation: "",
  contact_full_name: "",
  contact_designation: "",
  contact_calling_number: "",
  contact_whatsapp_number: "",
  emails: [] as string[],
  tax_id_number: "",
  website: "",
  current_status: "",
  product_range: "",
  potential: "",
  potential_reason: "",
  buyer_grade: "",
  currently_buying_from: "",
  overall_remarks: "",
};

const EMPTY_CONTACT_FORM = {
  salutation: "",
  person_name: "",
  designation: "",
  country_id: "",
  calling_number: "",
  whatsapp_number: "",
  email: "",
};

type ModalMode = "create" | "edit" | null;

const selectStyle: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  fontSize: 13,
  background: "#ffffff",
  color: "#0f172a",
};

export function BuyersPage() {
  const [rows, setRows] = useState<Buyer[]>([]);
  const [totalRecords, setTotalRecords] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  /* Lookups for filter labels & options */
  const countries = useLookup<Country>("/masters/countries", 250);
  const categories = useLookup<ProductCategory>("/masters/product-categories", 250);
  const subCategories = useLookup<ProductSubCategory>("/masters/product-sub-categories", 500);

  /* Top Filters */
  const [searchInput, setSearchInput] = useState("");
  const [effectiveSearch, setEffectiveSearch] = useState("");
  const [buyerTypeFilter, setBuyerTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [potentialFilter, setPotentialFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [subCategoryFilter, setSubCategoryFilter] = useState("");
  const [dateFromFilter, setDateFromFilter] = useState("");
  const [dateToFilter, setDateToFilter] = useState("");
  const [isFilterPanelOpen, setIsFilterPanelOpen] = useState(false);

  /* Selection & Detail View */
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [detailBuyer, setDetailBuyer] = useState<Buyer | null>(null);

  /* Form & Contacts Modal State */
  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_BUYER_FORM);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [subCategoryIds, setSubCategoryIds] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  const [contacts, setContacts] = useState<BuyerContact[]>([]);
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM);

  /* Freeze Columns State */
  const [pinnedCols, setPinnedCols] = useState<Record<number, "left" | "right">>(() => {
    const saved = localStorage.getItem("buyers_pinned_cols");
    if (saved !== null) {
      try {
        return JSON.parse(saved);
      } catch {
        // fallback
      }
    }
    return { 0: "left", 1: "left", 2: "left" };
  });

  useEffect(() => {
    localStorage.setItem("buyers_pinned_cols", JSON.stringify(pinnedCols));
  }, [pinnedCols]);

  const [colLeftOffsets, setColLeftOffsets] = useState<Record<number, number>>({});
  const [colRightOffsets, setColRightOffsets] = useState<Record<number, number>>({});
  const [pinMenuOpen, setPinMenuOpen] = useState(false);
  const pinMenuRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  const reload = () => setReloadCounter((n) => n + 1);

  /* Close Freeze menu on click outside */
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
        next[colIdx] = colIdx >= 10 ? "right" : "left";
      }
      return next;
    });
  }, []);

  const displayOrder = useMemo(() => {
    const allIndices = Array.from({ length: 12 }, (_, i) => i);
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
  }, [displayOrder, pinnedCols, rows]);

  /* Debounce Search Input */
  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(1);
      setEffectiveSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /* Fetch Data */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const params: Record<string, unknown> = {
          search: effectiveSearch,
          page: currentPage,
          page_size: pageSize,
          buyer_type: buyerTypeFilter || undefined,
          current_status: statusFilter || undefined,
          potential: potentialFilter || undefined,
          buyer_grade: gradeFilter || undefined,
          country_id: countryFilter || undefined,
          category_id: categoryFilter || undefined,
          sub_category_id: subCategoryFilter || undefined,
        };
        if (dateFromFilter) params["created_from"] = dateFromFilter;
        if (dateToFilter) params["created_to"] = dateToFilter;

        const { data, meta } = await apiGet<Buyer[]>("/buyers" + toQueryString(params));
        if (!cancelled) {
          setRows(data || []);
          setTotalRecords(meta?.pagination?.total_records ?? data?.length ?? 0);
        }
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    effectiveSearch,
    currentPage,
    pageSize,
    buyerTypeFilter,
    statusFilter,
    potentialFilter,
    gradeFilter,
    countryFilter,
    categoryFilter,
    subCategoryFilter,
    dateFromFilter,
    dateToFilter,
    reloadCounter,
  ]);

  const handleResetFilters = () => {
    setSearchInput("");
    setEffectiveSearch("");
    setBuyerTypeFilter("");
    setStatusFilter("");
    setPotentialFilter("");
    setGradeFilter("");
    setCountryFilter("");
    setCategoryFilter("");
    setSubCategoryFilter("");
    setDateFromFilter("");
    setDateToFilter("");
    setCurrentPage(1);
  };

  /* Default Country Uganda Lookup */
  const defaultUgandaId = useMemo(() => {
    const found = countries.items.find((c) => c.name.toLowerCase() === "uganda");
    return found ? found.id : "";
  }, [countries.items]);

  /* Chip Render Helper */
  function renderChips(ids: string[] | undefined, itemsList: Array<{ id: string; name: string }>) {
    if (!ids || !ids.length) return <span style={{ color: "#94a3b8" }}>—</span>;
    const names = ids.map((id) => itemsList.find((x) => x.id === id)?.name || id);
    const shown = names.slice(0, MAX_CHIPS);
    const remaining = names.length - shown.length;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
        {shown.map((n, i) => (
          <span
            key={`${n}-${i}`}
            style={{
              padding: "2px 8px",
              borderRadius: "4px",
              background: "#e2e8f0",
              fontSize: "11.5px",
              fontWeight: 500,
              color: "#334155",
            }}
          >
            {n}
          </span>
        ))}
        {remaining > 0 && (
          <button
            type="button"
            title={names.join(", ")}
            onClick={() => alert(`All selected items:\n\n${names.join("\n")}`)}
            style={{
              padding: "2px 6px",
              borderRadius: "4px",
              background: "#cbd5e1",
              fontSize: "11px",
              fontWeight: 700,
              color: "#0f172a",
              border: "none",
              cursor: "pointer",
            }}
          >
            +{remaining} more
          </button>
        )}
      </div>
    );
  }

  function openCreate() {
    setModalMode("create");
    setEditingId(null);
    setForm({
      ...EMPTY_BUYER_FORM,
      country_id: defaultUgandaId || (countries.items[0]?.id ?? ""),
    });
    setCategoryIds([]);
    setSubCategoryIds([]);
    setContacts([]);
  }

  async function openEdit(buyer: Buyer) {
    setModalMode("edit");
    setEditingId(buyer.id);
    setForm({
      company_name: buyer.company_name,
      buyer_type: buyer.buyer_type || "",
      country_id: buyer.country_id,
      city: buyer.city || "",
      address: buyer.address || "",
      contact_salutation: buyer.contact_salutation || "",
      contact_full_name: buyer.contact_full_name || "",
      contact_designation: buyer.contact_designation || "",
      contact_calling_number: buyer.contact_calling_number || "",
      contact_whatsapp_number: buyer.contact_whatsapp_number || "",
      emails: buyer.emails || [],
      tax_id_number: buyer.tax_id_number || "",
      website: buyer.website || "",
      current_status: buyer.current_status || "",
      product_range: buyer.product_range || "",
      potential: buyer.potential || "",
      potential_reason: buyer.potential_reason || "",
      buyer_grade: buyer.buyer_grade || "",
      currently_buying_from: buyer.currently_buying_from || "",
      overall_remarks: buyer.overall_remarks || "",
    });
    setCategoryIds(buyer.category_ids || []);
    setSubCategoryIds(buyer.sub_category_ids || []);
    try {
      const { data } = await apiGet<BuyerContact[]>(`/buyers/${buyer.id}/contacts`);
      setContacts(data || []);
    } catch {
      setContacts([]);
    }
  }

  function setField(id: keyof typeof EMPTY_BUYER_FORM, value: string) {
    setForm((prev) => {
      const next = { ...prev, [id]: value };
      if (id === "potential" && value !== "no") next.potential_reason = "";
      return next;
    });
  }

  function addEmail() {
    const trimmed = emailInput.trim();
    if (!trimmed) return;
    if (!form.emails.includes(trimmed)) setForm((f) => ({ ...f, emails: [...f.emails, trimmed] }));
    setEmailInput("");
  }

  function removeEmail(email: string) {
    setForm((f) => ({ ...f, emails: f.emails.filter((e) => e !== email) }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!form.company_name.trim()) {
      setError(new Error("Company Name is required."));
      return;
    }
    if (!form.country_id) {
      setError(new Error("Country is required."));
      return;
    }

    const existingBuyer = rows.find((b) => b.id === editingId);
    const payload = {
      ...form,
      version: existingBuyer?.version,
      buyer_type: form.buyer_type || null,
      city: form.city || null,
      current_status: form.current_status || null,
      potential: form.potential || null,
      buyer_grade: form.buyer_grade || null,
      category_ids: categoryIds,
      sub_category_ids: subCategoryIds,
    };

    try {
      if (modalMode === "create") {
        const { data: newBuyer } = await apiPost<Buyer>("/buyers", payload);
        if (newBuyer) {
          setRows((prev) => [newBuyer, ...prev]);
          setTotalRecords((prev) => prev + 1);
        } else {
          reload();
        }
      } else if (editingId) {
        const { data: updatedBuyer } = await apiPatch<Buyer>(`/buyers/${editingId}`, payload);
        if (updatedBuyer) {
          setRows((prev) => prev.map((b) => (b.id === editingId ? updatedBuyer : b)));
        } else {
          reload();
        }
      }
      setModalMode(null);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(buyer: Buyer) {
    const isExisting = buyer.current_status === "existing";
    const isPotentialYes = buyer.potential === "yes";

    if (isExisting || isPotentialYes) {
      alert(
        `Cannot DELETE buyer "${buyer.company_name}"!\n\n` +
          `Document Rule: Buyers with Current Status 'Existing' or Potential 'Yes' cannot be deleted. You can make it 'Inactive' instead.`
      );
      return;
    }

    if (!window.confirm(`Delete buyer "${buyer.company_name}"? This action cannot be undone.`)) return;
    try {
      await apiDelete(`/buyers/${buyer.id}`);
      setRows((prev) => prev.filter((b) => b.id !== buyer.id));
      setTotalRecords((prev) => Math.max(0, prev - 1));
    } catch (err) {
      setError(err);
    }
  }

  async function handleAddContact(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    if (!contactForm.person_name.trim()) {
      alert("Contact Full Name is required.");
      return;
    }
    try {
      const { data } = await apiPost<BuyerContact>(`/buyers/${editingId}/contacts`, {
        ...contactForm,
        country_id: contactForm.country_id || form.country_id,
      });
      setContacts((prev) => [...prev, data]);
      setContactForm(EMPTY_CONTACT_FORM);
      setContactFormOpen(false);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeleteContact(contactId: string) {
    if (!editingId) return;
    if (!window.confirm("Remove this contact person?")) return;
    try {
      await apiDelete(`/buyers/${editingId}/contacts/${contactId}`);
      setContacts((prev) => prev.filter((c) => c.id !== contactId));
    } catch (err) {
      setError(err);
    }
  }

  /* Sticky cell style generator */
  const getFreezeStyle = (colIdx: number): React.CSSProperties => {
    const isLeft = pinnedCols[colIdx] === "left";
    const isRight = pinnedCols[colIdx] === "right";
    if (!isLeft && !isRight) return {};

    const lefts = displayOrder.filter((idx) => pinnedCols[idx] === "left");
    const isLastLeft = isLeft && lefts[lefts.length - 1] === colIdx;
    const rights = displayOrder.filter((idx) => pinnedCols[idx] === "right");
    const isFirstRight = isRight && rights[0] === colIdx;

    return {
      position: "sticky",
      left: isLeft ? `${colLeftOffsets[colIdx] ?? 0}px` : undefined,
      right: isRight ? `${colRightOffsets[colIdx] ?? 0}px` : undefined,
      zIndex: isLeft || isRight ? 10 : 1,
      background: "#ffffff",
      borderRight: isLastLeft ? "2px solid #cbd5e1" : undefined,
      borderLeft: isFirstRight ? "2px solid #cbd5e1" : undefined,
      boxShadow: isLastLeft
        ? "4px 0 8px -2px rgba(0,0,0,0.1)"
        : isFirstRight
        ? "-4px 0 8px -2px rgba(0,0,0,0.1)"
        : undefined,
    };
  };

  /* Duplicate warning logic */
  const duplicateWarning = useMemo(() => {
    const cleanCompany = form.company_name.trim().toLowerCase().replace(/[\s-]/g, "");
    const cleanCalling = form.contact_calling_number.trim().replace(/\D/g, "");
    const cleanWhatsapp = form.contact_whatsapp_number.trim().replace(/\D/g, "");

    if (!cleanCompany && !cleanCalling && !cleanWhatsapp) return null;

    const match = rows.find((r) => {
      if (modalMode === "edit" && r.id === editingId) return false;
      const rComp = r.company_name.toLowerCase().replace(/[\s-]/g, "");
      const rCall = (r.contact_calling_number || "").replace(/\D/g, "");
      const rWhats = (r.contact_whatsapp_number || "").replace(/\D/g, "");

      const compMatch = cleanCompany && rComp === cleanCompany;
      const callMatch = cleanCalling && rCall && rCall === cleanCalling;
      const whatsMatch = cleanWhatsapp && rWhats && rWhats === cleanWhatsapp;

      return (compMatch && (callMatch || whatsMatch)) || (compMatch && !cleanCalling && !cleanWhatsapp);
    });

    if (match) {
      return `⚠️ Duplicate Buyer Detected! Buyer "${match.company_name}" already exists in Master.`;
    }
    return null;
  }, [form.company_name, form.contact_calling_number, form.contact_whatsapp_number, rows, modalMode, editingId]);

  return (
    <AppShell activeKey="buyers">
      <main className="page" style={{ padding: "20px", maxWidth: "1600px", margin: "0 auto" }}>
        <Breadcrumb trail={["Buyer Profiles"]} />

        {/* Page Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#0F172A", margin: 0 }}>Buyer (Client) Master</h1>
            <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
              Manage client accounts, contact persons, potential ratings, and sales pipeline statuses.
            </div>
          </div>
          <div style={{ display: "flex", gap: "10px" }}>
            <button
              type="button"
              onClick={() => setIsFilterPanelOpen((v) => !v)}
              style={{
                padding: "8px 14px",
                borderRadius: "6px",
                border: "1px solid #cbd5e1",
                background: isFilterPanelOpen ? "#e2e8f0" : "#ffffff",
                color: "#1e293b",
                fontWeight: 600,
                fontSize: "13.5px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: "6px",
              }}
            >
              🔍 {isFilterPanelOpen ? "Hide Filters" : "Filter Records"}
            </button>
            <Can permission="buyer.create">
              <button
                type="button"
                className="btn btn-primary"
                onClick={openCreate}
                style={{
                  padding: "8px 16px",
                  borderRadius: "6px",
                  background: "#2563eb",
                  color: "#ffffff",
                  fontWeight: 600,
                  fontSize: "13.5px",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                + ADD NEW BUYER
              </button>
            </Can>
          </div>
        </div>

        <Banner error={error} />

        {/* Top Filters Panel */}
        {isFilterPanelOpen && (
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              borderRadius: "8px",
              padding: "16px 20px",
              marginBottom: "16px",
              boxShadow: "0 2px 8px rgba(0,0,0,0.04)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <div style={{ fontWeight: 700, fontSize: "14px", color: "#1e293b" }}>Advanced Filters</div>
              <button
                type="button"
                onClick={handleResetFilters}
                style={{ background: "none", border: "none", color: "#ef4444", fontSize: "12.5px", fontWeight: 600, cursor: "pointer" }}
              >
                Clear All Filters ✕
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "12px" }}>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Buyer Type</label>
                <select value={buyerTypeFilter} onChange={(e) => { setCurrentPage(1); setBuyerTypeFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">All Buyer Types</option>
                  <option value="manufacturer">Manufacturer</option>
                  <option value="trader">Trader</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Current Status</label>
                <select value={statusFilter} onChange={(e) => { setCurrentPage(1); setStatusFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">All Statuses</option>
                  <option value="new">New</option>
                  <option value="existing">Existing</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Potential</label>
                <select value={potentialFilter} onChange={(e) => { setCurrentPage(1); setPotentialFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">Any Potential</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Client Grade</label>
                <select value={gradeFilter} onChange={(e) => { setCurrentPage(1); setGradeFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">Any Grade</option>
                  <option value="A">Grade A</option>
                  <option value="B">Grade B</option>
                  <option value="C">Grade C</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Country</label>
                <select value={countryFilter} onChange={(e) => { setCurrentPage(1); setCountryFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">Any Country</option>
                  {countries.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Product Category</label>
                <select value={categoryFilter} onChange={(e) => { setCurrentPage(1); setCategoryFilter(e.target.value); setSubCategoryFilter(""); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">All Categories</option>
                  {categories.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Sub Category</label>
                <select value={subCategoryFilter} onChange={(e) => { setCurrentPage(1); setSubCategoryFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }}>
                  <option value="">All Sub-Categories</option>
                  {subCategories.items
                    .filter((sc) => !categoryFilter || sc.category_id === categoryFilter)
                    .map((sc) => (
                      <option key={sc.id} value={sc.id}>
                        {sc.name}
                      </option>
                    ))}
                </select>
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Date From</label>
                <input type="date" value={dateFromFilter} onChange={(e) => { setCurrentPage(1); setDateFromFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }} />
              </div>
              <div>
                <label style={{ fontSize: "12px", fontWeight: 600, color: "#475569", display: "block", marginBottom: "4px" }}>Date To</label>
                <input type="date" value={dateToFilter} onChange={(e) => { setCurrentPage(1); setDateToFilter(e.target.value); }} style={{ ...selectStyle, width: "100%" }} />
              </div>
            </div>
          </div>
        )}

        {/* Main Table Card & Single-Row Toolbar */}
        <div style={{ background: "#ffffff", borderRadius: "8px", border: "1px solid #cbd5e1", overflow: "hidden", boxShadow: "0 1px 3px rgba(0,0,0,0.05)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 20px", borderBottom: "1px solid #e2e8f0", flexWrap: "wrap", gap: "12px" }}>
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

              {/* Freeze Columns Popover */}
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
                      left: 0,
                      top: "38px",
                      zIndex: 100,
                      background: "#ffffff",
                      border: "1px solid #cbd5e1",
                      borderRadius: "8px",
                      boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                      padding: "12px",
                      minWidth: "220px",
                      display: "flex",
                      flexDirection: "column",
                    }}
                  >
                    <div style={{ fontSize: "12px", fontWeight: 700, color: "#475569", marginBottom: "8px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
                      Toggle Frozen Columns
                    </div>
                    <div style={{ maxHeight: "200px", overflowY: "auto", paddingRight: "4px" }}>
                      {[
                        "Checkbox",
                        "Sr. No.",
                        "Name of Company",
                        "Buyer Type",
                        "Product Category",
                        "Product Sub Category",
                        "Country",
                        "Current Status",
                        "Potential",
                        "Client Grade",
                        "Added On",
                        "Action",
                      ].map((label, idx) => {
                        const isPinned = Boolean(pinnedCols[idx]);
                        return (
                          <label key={label} style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", cursor: "pointer", padding: "4px 0" }}>
                            <input type="checkbox" checked={isPinned} onChange={() => togglePin(idx)} /> {label}
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ borderTop: "1px solid #f1f5f9", marginTop: "8px", paddingTop: "8px" }}>
                      <button
                        type="button"
                        onClick={() => setPinnedCols({})}
                        style={{
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
                  </div>
                )}
              </div>
            </div>

            {/* Right Search Input */}
            <div style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
              <input
                placeholder="Search company or code…"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                style={{ padding: "7px 32px 7px 12px", border: "1px solid #cbd5e1", borderRadius: "6px", fontSize: "13px", width: "240px" }}
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput("")}
                  style={{ position: "absolute", right: "8px", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: "14px" }}
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Table */}
          <div style={{ overflowX: "auto" }}>
            <table ref={tableRef} style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {displayOrder.map((colIdx) => {
                    const headers = [
                      <input
                        type="checkbox"
                        checked={selectedIds.length > 0 && selectedIds.length === rows.length}
                        onChange={(e) => setSelectedIds(e.target.checked ? rows.map((r) => r.id) : [])}
                      />,
                      "Sr. No.",
                      "Name of Company",
                      "Buyer Type",
                      "Product Category",
                      "Product Sub Category",
                      "Country",
                      "Current Status",
                      "Potential",
                      "Client Grade",
                      "Added On",
                      "Action",
                    ];
                    return (
                      <th
                        key={colIdx}
                        style={{
                          padding: "10px 14px",
                          textAlign: colIdx === 0 || colIdx === 1 ? "center" : "left",
                          fontWeight: 700,
                          color: "#475569",
                          whiteSpace: "nowrap",
                          ...getFreezeStyle(colIdx),
                        }}
                      >
                        {headers[colIdx]}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={12} style={{ textAlign: "center", padding: "30px", color: "#64748b" }}>
                      Loading buyer profiles…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={12} style={{ textAlign: "center", padding: "30px", color: "#64748b" }}>
                      No buyer profiles found.
                    </td>
                  </tr>
                ) : (
                  rows.map((r, rowIndex) => {
                    const countryName = countries.items.find((c) => c.id === r.country_id)?.name || "—";
                    const isExisting = r.current_status === "existing";
                    const isPotentialYes = r.potential === "yes";
                    const cannotDelete = isExisting || isPotentialYes;

                    const rowCells: Record<number, React.ReactNode> = {
                      0: (
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(r.id)}
                          onChange={(e) => setSelectedIds((prev) => (e.target.checked ? [...prev, r.id] : prev.filter((id) => id !== r.id)))}
                        />
                      ),
                      1: (currentPage - 1) * pageSize + rowIndex + 1,
                      2: (
                        <a
                          href="#"
                          onClick={(e) => {
                            e.preventDefault();
                            setDetailBuyer(r);
                          }}
                          style={{ color: "#2563eb", fontWeight: 600, textDecoration: "none" }}
                        >
                          {r.company_name}
                        </a>
                      ),
                      3: r.buyer_type ? r.buyer_type.toUpperCase() : "—",
                      4: renderChips(r.category_ids, categories.items),
                      5: renderChips(r.sub_category_ids, subCategories.items),
                      6: countryName,
                      7: (
                        <span
                          style={{
                            padding: "3px 8px",
                            borderRadius: "12px",
                            fontSize: "11.5px",
                            fontWeight: 600,
                            background: r.current_status === "existing" ? "#dcfce7" : "#f1f5f9",
                            color: r.current_status === "existing" ? "#15803d" : "#475569",
                          }}
                        >
                          {r.current_status ? r.current_status.toUpperCase() : "SELECT"}
                        </span>
                      ),
                      8: (
                        <span
                          style={{
                            padding: "3px 8px",
                            borderRadius: "12px",
                            fontSize: "11.5px",
                            fontWeight: 600,
                            background: r.potential === "yes" ? "#dbeafe" : r.potential === "no" ? "#fee2e2" : "#f1f5f9",
                            color: r.potential === "yes" ? "#1d4ed8" : r.potential === "no" ? "#b91c1c" : "#475569",
                          }}
                        >
                          {r.potential ? r.potential.toUpperCase() : "SELECT"}
                        </span>
                      ),
                      9: r.buyer_grade ? `Grade ${r.buyer_grade}` : "—",
                      10: r.created_at ? new Date(r.created_at).toLocaleDateString() : "—",
                      11: (
                        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                          <button
                            type="button"
                            onClick={() => openEdit(r)}
                            style={{ padding: "4px 8px", fontSize: "12px", borderRadius: "4px", border: "1px solid #cbd5e1", background: "#f8fafc", cursor: "pointer", color: "#0f172a" }}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(r)}
                            title={cannotDelete ? "Cannot delete buyer with Existing status or Yes potential (document rule)" : "Delete buyer"}
                            style={{
                              padding: "4px 8px",
                              fontSize: "12px",
                              borderRadius: "4px",
                              border: "1px solid #fee2e2",
                              background: cannotDelete ? "#f1f5f9" : "#fff1f2",
                              cursor: cannotDelete ? "not-allowed" : "pointer",
                              color: cannotDelete ? "#94a3b8" : "#e11d48",
                              fontWeight: 600,
                              opacity: cannotDelete ? 0.6 : 1,
                            }}
                          >
                            Delete
                          </button>
                        </div>
                      ),
                    };

                    return (
                      <tr key={r.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                        {displayOrder.map((colIdx) => (
                          <td
                            key={colIdx}
                            style={{
                              padding: "10px 14px",
                              textAlign: colIdx === 0 || colIdx === 1 ? "center" : "left",
                              whiteSpace: colIdx === 2 ? "normal" : "nowrap",
                              ...getFreezeStyle(colIdx),
                            }}
                          >
                            {rowCells[colIdx]}
                          </td>
                        ))}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div style={{ padding: "12px 20px", borderTop: "1px solid #e2e8f0" }}>
            <Pagination
              currentPage={currentPage}
              totalPages={Math.ceil(totalRecords / pageSize) || 1}
              pageSize={pageSize}
              totalRecords={totalRecords}
              onPageChange={setCurrentPage}
            />
          </div>
        </div>

        {/* View Details Drawer */}
        {detailBuyer && (
          <SideDrawer title={`Buyer Profile: ${detailBuyer.company_name}`} isOpen={Boolean(detailBuyer)} onClose={() => setDetailBuyer(null)} width="650px">
            <div style={{ display: "flex", flexDirection: "column", gap: "16px", padding: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", background: "#f8fafc", padding: "16px", borderRadius: "8px" }}>
                <div><strong>Company Name:</strong> {detailBuyer.company_name}</div>
                <div><strong>Buyer Type:</strong> {detailBuyer.buyer_type || "—"}</div>
                <div><strong>Country:</strong> {countries.items.find((c) => c.id === detailBuyer.country_id)?.name || "—"}</div>
                <div><strong>City:</strong> {detailBuyer.city || "—"}</div>
                <div><strong>Current Status:</strong> {detailBuyer.current_status || "—"}</div>
                <div><strong>Potential:</strong> {detailBuyer.potential || "—"}</div>
                <div><strong>Client Grade:</strong> {detailBuyer.buyer_grade || "—"}</div>
                <div><strong>Tax ID (TIN/GST):</strong> {detailBuyer.tax_id_number || "—"}</div>
              </div>

              <div>
                <strong>Primary Contact Person:</strong>
                <div style={{ marginTop: "4px", fontSize: "13px", color: "#334155" }}>
                  {detailBuyer.contact_salutation} {detailBuyer.contact_full_name || "—"} ({detailBuyer.contact_designation || "No designation"})
                  <br />
                  📞 Calling: {detailBuyer.contact_calling_number || "—"} | 💬 WhatsApp: {detailBuyer.contact_whatsapp_number || "—"}
                </div>
              </div>

              <div>
                <strong>Emails:</strong>
                <div style={{ marginTop: "4px" }}>
                  {detailBuyer.emails && detailBuyer.emails.length > 0 ? (
                    detailBuyer.emails.map((em) => (
                      <a key={em} href={`mailto:${em}`} style={{ display: "block", color: "#2563eb", fontSize: "13px" }}>
                        {em}
                      </a>
                    ))
                  ) : (
                    <span style={{ color: "#94a3b8" }}>No emails listed</span>
                  )}
                </div>
              </div>

              {detailBuyer.website && (
                <div>
                  <strong>Website:</strong>{" "}
                  <a href={detailBuyer.website.startsWith("http") ? detailBuyer.website : `https://${detailBuyer.website}`} target="_blank" rel="noreferrer" style={{ color: "#2563eb" }}>
                    {detailBuyer.website}
                  </a>
                </div>
              )}

              {detailBuyer.address && (
                <div>
                  <strong>Address:</strong>
                  <div style={{ whiteSpace: "pre-wrap", fontSize: "13px", color: "#475569", marginTop: "4px" }}>{detailBuyer.address}</div>
                </div>
              )}
            </div>
          </SideDrawer>
        )}

        {/* Compact Form Drawer */}
        {modalMode && (
          <SideDrawer
            title={modalMode === "create" ? "Add Buyer (Client) Data Form" : `Edit Buyer Profile: ${form.company_name}`}
            isOpen={Boolean(modalMode)}
            onClose={() => setModalMode(null)}
            width="750px"
          >
            <form onSubmit={handleSubmit} style={{ padding: "12px", display: "flex", flexDirection: "column", gap: "16px" }}>
              {duplicateWarning && (
                <div style={{ padding: "10px 14px", borderRadius: "6px", background: "#fef2f2", border: "1px solid #fca5a5", color: "#991b1b", fontSize: "13px", fontWeight: 600 }}>
                  {duplicateWarning}
                </div>
              )}

              {/* Company & Type */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px" }}>
                <TextField id="company_name" label="Name of Company *" required placeholder="Company Name" value={form.company_name} onChange={(v) => setField("company_name", v)} />
                <SelectField id="buyer_type" label="Buyer Type" value={form.buyer_type} onChange={(v) => setField("buyer_type", v)}>
                  <option value="">-- Select --</option>
                  <option value="manufacturer">Manufacturer</option>
                  <option value="trader">Trader</option>
                </SelectField>
              </div>

              {/* Categories & Sub-Categories */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "4px" }}>Product Category (multiple)</label>
                  <SearchableDropdownMulti
                    values={categoryIds}
                    onChange={setCategoryIds}
                    placeholder="Select categories…"
                    options={categories.items.map((c) => ({ value: c.id, label: c.name }))}
                  />
                </div>
                <div>
                  <label style={{ fontSize: "13px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "4px" }}>Product Sub Category (multiple)</label>
                  <SearchableDropdownMulti
                    values={subCategoryIds}
                    onChange={setSubCategoryIds}
                    placeholder="Select sub-categories…"
                    options={subCategories.items
                      .filter((sc) => categoryIds.length === 0 || categoryIds.includes(sc.category_id))
                      .map((sc) => ({ value: sc.id, label: sc.name }))}
                  />
                </div>
              </div>

              {/* Country & City */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <SelectField id="country_id" label="Country *" required value={form.country_id} onChange={(v) => setField("country_id", v)}>
                  <option value="">-- Select Country --</option>
                  {countries.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </SelectField>
                <TextField id="city" label="City" placeholder="Enter City" value={form.city} onChange={(v) => setField("city", v)} />
              </div>

              <TextAreaField id="address" label="Address" rows={2} placeholder="Full address details…" value={form.address} onChange={(v) => setField("address", v)} />

              {/* Primary Contact Section */}
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
                <div style={{ fontWeight: 700, fontSize: "14px", color: "#1e293b", marginBottom: "10px" }}>Primary Contact Person</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 2fr", gap: "10px" }}>
                  <SelectField id="contact_salutation" label="Title" value={form.contact_salutation} onChange={(v) => setField("contact_salutation", v)}>
                    <option value="">Select</option>
                    <option value="Mr.">Mr.</option>
                    <option value="Mrs.">Mrs.</option>
                    <option value="Ms.">Ms.</option>
                  </SelectField>
                  <TextField id="contact_full_name" label="Full Name" placeholder="Contact Person Name" value={form.contact_full_name} onChange={(v) => setField("contact_full_name", v)} />
                  <TextField id="contact_designation" label="Designation" placeholder="e.g. Purchase Manager" value={form.contact_designation} onChange={(v) => setField("contact_designation", v)} />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginTop: "8px" }}>
                  <TextField id="contact_calling_number" label="Calling Number (max 10 digits)" placeholder="+256 700000000" value={form.contact_calling_number} onChange={(v) => setField("contact_calling_number", v)} />
                  <TextField id="contact_whatsapp_number" label="WhatsApp Number (max 10 digits)" placeholder="+256 700000000" value={form.contact_whatsapp_number} onChange={(v) => setField("contact_whatsapp_number", v)} />
                </div>
              </div>

              {/* Email IDs & Website */}
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "10px" }}>
                  <div>
                    <label style={{ fontSize: "13px", fontWeight: 600, color: "#334155", display: "block", marginBottom: "4px" }}>Email IDs (Multiple)</label>
                    <div style={{ display: "flex", gap: "8px" }}>
                      <input
                        type="email"
                        placeholder="add email and click +"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        style={{ flex: 1, padding: "7px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
                      />
                      <button type="button" onClick={addEmail} style={{ padding: "7px 12px", borderRadius: "6px", background: "#e2e8f0", border: "1px solid #cbd5e1", fontWeight: 700, cursor: "pointer" }}>
                        + Add
                      </button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginTop: "6px" }}>
                      {form.emails.map((em) => (
                        <span key={em} style={{ padding: "2px 8px", borderRadius: "12px", background: "#f1f5f9", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
                          <a href={`mailto:${em}`} style={{ color: "#2563eb" }}>{em}</a>
                          <button type="button" onClick={() => removeEmail(em)} style={{ border: "none", background: "none", cursor: "pointer", color: "#ef4444" }}>✕</button>
                        </span>
                      ))}
                    </div>
                  </div>
                  <TextField id="website" label="Website" placeholder="https://company.com" value={form.website} onChange={(v) => setField("website", v)} />
                </div>
              </div>

              {/* Status, Potential & Grade */}
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px", display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: "10px" }}>
                <SelectField
                  id="current_status"
                  label="Current Status"
                  value={form.current_status}
                  onChange={(v) => setField("current_status", v)}
                >
                  <option value="">-- Select --</option>
                  {/* Document 1-Way Lock Rule: Cannot set 'new' if already 'existing' */}
                  {rows.find((b) => b.id === editingId)?.current_status !== "existing" && <option value="new">New</option>}
                  <option value="existing">Existing</option>
                </SelectField>

                <SelectField id="potential" label="Potential" value={form.potential} onChange={(v) => setField("potential", v)}>
                  <option value="">-- Select --</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </SelectField>

                <SelectField id="buyer_grade" label="Client Grade" value={form.buyer_grade} onChange={(v) => setField("buyer_grade", v)}>
                  <option value="">-- Select --</option>
                  <option value="A">Grade A</option>
                  <option value="B">Grade B</option>
                  <option value="C">Grade C</option>
                </SelectField>

                <TextField id="tax_id_number" label="Tax ID (TIN/GST)" placeholder="Tax ID" value={form.tax_id_number} onChange={(v) => setField("tax_id_number", v)} />
              </div>

              {/* Conditional Potential Reason */}
              {form.potential === "no" && (
                <TextAreaField id="potential_reason" label="If Potential is No, Reason *" required rows={2} placeholder="Specify reason why potential is No…" value={form.potential_reason} onChange={(v) => setField("potential_reason", v)} />
              )}

              <TextAreaField id="product_range" label="Product Range (Manufactured or Supplied)" rows={2} placeholder="Products they supply…" value={form.product_range} onChange={(v) => setField("product_range", v)} />

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <TextAreaField id="currently_buying_from" label="Currently Buying From" rows={2} placeholder="Competitor details…" value={form.currently_buying_from} onChange={(v) => setField("currently_buying_from", v)} />
                <TextAreaField id="overall_remarks" label="Overall Observation / Remarks" rows={2} placeholder="General remarks…" value={form.overall_remarks} onChange={(v) => setField("overall_remarks", v)} />
              </div>

              {/* Additional Contacts Sub-Panel (Only in Edit Mode) */}
              {modalMode === "edit" && editingId && (
                <div style={{ borderTop: "2px solid #e2e8f0", paddingTop: "14px", marginTop: "8px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "10px" }}>
                    <div style={{ fontWeight: 700, fontSize: "14px", color: "#0f172a" }}>Additional Contact Persons ({contacts.length})</div>
                    <button
                      type="button"
                      onClick={() => setContactFormOpen((v) => !v)}
                      style={{ padding: "4px 10px", fontSize: "12px", borderRadius: "4px", background: "#f1f5f9", border: "1px solid #cbd5e1", cursor: "pointer", fontWeight: 600 }}
                    >
                      {contactFormOpen ? "Cancel Contact" : "+ Add Contact Person"}
                    </button>
                  </div>

                  {contactFormOpen && (
                    <div style={{ background: "#f8fafc", padding: "12px", borderRadius: "6px", marginBottom: "12px", border: "1px solid #cbd5e1" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr 2fr", gap: "8px", marginBottom: "8px" }}>
                        <SelectField id="contact_salutation_sub" label="Title" value={contactForm.salutation} onChange={(v) => setContactForm((prev) => ({ ...prev, salutation: v }))}>
                          <option value="">Select</option>
                          <option value="Mr.">Mr.</option>
                          <option value="Mrs.">Mrs.</option>
                          <option value="Ms.">Ms.</option>
                        </SelectField>
                        <TextField id="contact_name_sub" label="Full Name *" required placeholder="Contact Name" value={contactForm.person_name} onChange={(v) => setContactForm((prev) => ({ ...prev, person_name: v }))} />
                        <TextField id="contact_designation_sub" label="Designation" placeholder="Designation" value={contactForm.designation} onChange={(v) => setContactForm((prev) => ({ ...prev, designation: v }))} />
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "8px", marginBottom: "8px" }}>
                        <TextField id="contact_calling_sub" label="Calling Number" placeholder="Calling #" value={contactForm.calling_number} onChange={(v) => setContactForm((prev) => ({ ...prev, calling_number: v }))} />
                        <TextField id="contact_whatsapp_sub" label="WhatsApp Number" placeholder="WhatsApp #" value={contactForm.whatsapp_number} onChange={(v) => setContactForm((prev) => ({ ...prev, whatsapp_number: v }))} />
                        <TextField id="contact_email_sub" label="Email" placeholder="email@domain.com" value={contactForm.email} onChange={(v) => setContactForm((prev) => ({ ...prev, email: v }))} />
                      </div>
                      <button type="button" onClick={handleAddContact} style={{ padding: "6px 14px", borderRadius: "4px", background: "#2563eb", color: "#fff", border: "none", fontWeight: 600, fontSize: "12.5px", cursor: "pointer" }}>
                        Save Contact
                      </button>
                    </div>
                  )}

                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {contacts.length === 0 ? (
                      <div style={{ fontSize: "12.5px", color: "#94a3b8" }}>No additional contacts added yet.</div>
                    ) : (
                      contacts.map((c) => (
                        <div key={c.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "12.5px" }}>
                          <div>
                            <strong>{c.salutation} {c.person_name}</strong> {c.designation ? `(${c.designation})` : ""} {c.is_primary && <span style={{ color: "#2563eb", fontWeight: 700 }}>[Primary]</span>}
                            <br />
                            <span style={{ color: "#64748b" }}>📞 {c.calling_number || "—"} | 💬 {c.whatsapp_number || "—"} | ✉️ {c.email || "—"}</span>
                          </div>
                          {!c.is_primary && (
                            <button type="button" onClick={() => handleDeleteContact(c.id)} style={{ border: "none", background: "none", color: "#ef4444", fontWeight: 700, cursor: "pointer" }}>
                              Delete ✕
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Submit Buttons */}
              <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "12px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                <button type="button" onClick={() => setModalMode(null)} style={{ padding: "8px 16px", borderRadius: "6px", border: "1px solid #cbd5e1", background: "#ffffff", fontWeight: 600, cursor: "pointer" }}>
                  Cancel
                </button>
                <button type="submit" style={{ padding: "8px 20px", borderRadius: "6px", background: "#2563eb", color: "#ffffff", border: "none", fontWeight: 600, cursor: "pointer" }}>
                  {modalMode === "create" ? "Save Buyer Profile" : "Update Buyer Profile"}
                </button>
              </div>
            </form>
          </SideDrawer>
        )}
      </main>
    </AppShell>
  );
}
