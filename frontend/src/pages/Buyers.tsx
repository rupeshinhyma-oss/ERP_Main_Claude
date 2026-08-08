/**
 * Buyer (Client) Profiles. Implements the "Add Buyer (Client) Data Form" document:
 * list view with top filters, a compact single-screen create/edit form, and
 * a Contacts sub-panel. Structurally mirrors Suppliers.tsx (the sibling
 * document describes the same shape of record) but kept intentionally
 * smaller per the document's own "squeeze to fit 1 screen" instruction --
 * no multi-step tabs, no State/City (Buyer only needs Country + free-text City).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { Pagination } from "@/components/Pagination";
import { SearchableDropdown, SearchableDropdownMulti, type DropdownOption } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, toQueryString } from "@/lib/api";
import { createNameResolver } from "@/lib/nameResolver";
import type { PaginationMeta } from "@/types";
import type { Buyer, BuyerContact } from "@/types/buyers";

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

export function BuyersPage() {
  const [rows, setRows] = useState<Buyer[]>([]);
  const [pagination, setPagination] = useState<PaginationMeta | undefined>();
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  const [searchInput, setSearchInput] = useState("");
  const [effectiveSearch, setEffectiveSearch] = useState("");
  const [buyerTypeFilter, setBuyerTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [potentialFilter, setPotentialFilter] = useState("");
  const [gradeFilter, setGradeFilter] = useState("");
  const [countryFilter, setCountryFilter] = useState("");

  const [modalMode, setModalMode] = useState<ModalMode>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_BUYER_FORM);
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [subCategoryIds, setSubCategoryIds] = useState<string[]>([]);
  const [emailInput, setEmailInput] = useState("");

  const [contacts, setContacts] = useState<BuyerContact[]>([]);
  const [contactFormOpen, setContactFormOpen] = useState(false);
  const [contactForm, setContactForm] = useState(EMPTY_CONTACT_FORM);

  const reload = () => setReloadCounter((n) => n + 1);

  useEffect(() => {
    const timer = setTimeout(() => {
      setCurrentPage(1);
      setEffectiveSearch(searchInput.trim());
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, meta } = await apiGet<Buyer[]>(
          "/buyers" +
            toQueryString({
              search: effectiveSearch,
              page: currentPage,
              page_size: pageSize,
              buyer_type: buyerTypeFilter,
              current_status: statusFilter,
              potential: potentialFilter,
              buyer_grade: gradeFilter,
              country_id: countryFilter,
            })
        );
        if (!cancelled) {
          setRows(data);
          setPagination(meta?.pagination);
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
  }, [effectiveSearch, currentPage, pageSize, buyerTypeFilter, statusFilter, potentialFilter, gradeFilter, countryFilter, reloadCounter]);

  /* --- Bounded name resolver for category/sub-category/country chips --- */
  const resolver = useMemo(() => {
    const fetchNamesByIds = async (apiBase: string, ids: string[]): Promise<[string, string][]> => {
      const results = await Promise.all(
        ids.map(async (id): Promise<[string, string | null]> => {
          try {
            const { data } = await apiGet<Record<string, unknown>>(`${apiBase}/${id}`);
            return [id, (data.name as string) ?? null];
          } catch {
            return [id, null];
          }
        })
      );
      return results.filter((pair): pair is [string, string] => pair[1] !== null);
    };
    return createNameResolver({
      countries: (ids) => fetchNamesByIds("/masters/countries", ids),
      categories: (ids) => fetchNamesByIds("/masters/product-categories", ids),
      subCategories: (ids) => fetchNamesByIds("/masters/product-sub-categories", ids),
    });
  }, []);

  useEffect(() => {
    if (loading) return;
    const countryIds = rows.map((r) => r.country_id).filter(Boolean);
    const catIds = rows.flatMap((r) => r.category_ids || []);
    const subCatIds = rows.flatMap((r) => r.sub_category_ids || []);
    void resolver.resolve("countries", countryIds);
    void resolver.resolve("categories", catIds);
    void resolver.resolve("subCategories", subCatIds);
  }, [loading, rows, resolver]);

  const searchFetcher = useCallback(
    (apiBase: string) =>
      async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
        const { data } = await apiGet<{ id: string; name: string }[]>(
          apiBase + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" }),
          { signal }
        );
        return data.map((d) => ({ value: d.id, label: d.name }));
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
          <button type="button" className="chip-more" title={names.join(", ")} onClick={() => alert(names.join(", "))}>
            +{remaining} more
          </button>
        )}
      </div>
    );
  }

  function openCreate() {
    setModalMode("create");
    setEditingId(null);
    setForm(EMPTY_BUYER_FORM);
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
      setContacts(data);
    } catch {
      setContacts([]);
    }
  }

  function setField(id: keyof typeof EMPTY_BUYER_FORM, value: string) {
    setForm((prev) => {
      const next = { ...prev, [id]: value };
      // Document: "If Potential is No, then reason" -- clear the reason if Potential stops being No.
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
    const payload = {
      ...form,
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
        await apiPost("/buyers", payload);
      } else if (editingId) {
        await apiPatch(`/buyers/${editingId}`, payload);
      }
      setModalMode(null);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeactivate(buyer: Buyer) {
    if (!window.confirm(`Set ${buyer.company_name} to Inactive?`)) return;
    try {
      await apiPost(`/buyers/${buyer.id}/deactivate`, {});
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleActivate(buyer: Buyer) {
    try {
      await apiPost(`/buyers/${buyer.id}/activate`, {});
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleDelete(buyer: Buyer) {
    if (!window.confirm(`Delete ${buyer.company_name}? This cannot be undone.`)) return;
    try {
      await apiDelete(`/buyers/${buyer.id}`);
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleGradeChange(buyer: Buyer, grade: string) {
    try {
      await apiPatch(`/buyers/${buyer.id}/grade`, { buyer_grade: grade || null });
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handlePotentialChange(buyer: Buyer, potential: string) {
    try {
      await apiPatch(`/buyers/${buyer.id}/potential`, { potential: potential || null });
      reload();
    } catch (err) {
      setError(err);
    }
  }

  async function handleAddContact(e: React.FormEvent) {
    e.preventDefault();
    if (!editingId) return;
    try {
      const { data } = await apiPost<BuyerContact>(`/buyers/${editingId}/contacts`, contactForm);
      setContacts((prev) => [...prev, data]);
      setContactForm(EMPTY_CONTACT_FORM);
      setContactFormOpen(false);
    } catch (err) {
      setError(err);
    }
  }

  async function handleDeleteContact(contactId: string) {
    if (!editingId) return;
    if (!window.confirm("Remove this contact?")) return;
    try {
      await apiDelete(`/buyers/${editingId}/contacts/${contactId}`);
      setContacts((prev) => prev.filter((c) => c.id !== contactId));
    } catch (err) {
      setError(err);
    }
  }

  return (
    <AppShell activeKey="buyers">
      <main className="page">
        <Breadcrumb trail={["Buyer Profiles"]} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0 }}>Buyer (Client) Profiles</h1>
          <Can permission="buyer.create">
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              + Add Buyer
            </button>
          </Can>
        </div>

        <Banner error={error} />

        {/* Top filters */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
          <input
            placeholder="Search company name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            style={{ padding: 8, border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 13, minWidth: 220 }}
          />
          <select value={buyerTypeFilter} onChange={(e) => { setCurrentPage(1); setBuyerTypeFilter(e.target.value); }} style={selectStyle}>
            <option value="">All Buyer Types</option>
            <option value="manufacturer">Manufacturer</option>
            <option value="trader">Trader</option>
          </select>
          <select value={statusFilter} onChange={(e) => { setCurrentPage(1); setStatusFilter(e.target.value); }} style={selectStyle}>
            <option value="">All Statuses</option>
            <option value="new">New</option>
            <option value="existing">Existing</option>
          </select>
          <select value={potentialFilter} onChange={(e) => { setCurrentPage(1); setPotentialFilter(e.target.value); }} style={selectStyle}>
            <option value="">Any Potential</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
          <select value={gradeFilter} onChange={(e) => { setCurrentPage(1); setGradeFilter(e.target.value); }} style={selectStyle}>
            <option value="">Any Grade</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
          <div style={{ minWidth: 200 }}>
            <SearchableDropdown
              value={countryFilter}
              onChange={(v) => { setCurrentPage(1); setCountryFilter(v || ""); }}
              placeholder="Any Country"
              fetchOptions={searchFetcher("/masters/countries")}
              fetchLabelForValue={fetchNameLabel("/masters/countries")}
            />
          </div>
        </div>

        <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
            <thead>
              <tr style={{ background: "#F8FAFC" }}>
                <th style={thStyle}>Company Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Category</th>
                <th style={thStyle}>Sub Category</th>
                <th style={thStyle}>Country</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Potential</th>
                <th style={thStyle}>Grade</th>
                <th style={thStyle}>Added On</th>
                <th style={thStyle}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <TableMessageRow colSpan={10}>Loading…</TableMessageRow>
              ) : rows.length === 0 ? (
                <TableMessageRow colSpan={10}>No buyers found.</TableMessageRow>
              ) : (
                rows.map((b) => (
                  <tr key={b.id} style={{ opacity: b.is_active ? 1 : 0.55 }}>
                    <td style={tdStyle}>
                      <button type="button" onClick={() => openEdit(b)} style={{ border: "none", background: "transparent", color: "#2563EB", cursor: "pointer", fontWeight: 500, padding: 0 }}>
                        {b.company_name}
                      </button>
                    </td>
                    <td style={tdStyle}>{b.buyer_type || <span className="muted">—</span>}</td>
                    <td style={tdStyle}>{chipList(b.category_ids, "categories")}</td>
                    <td style={tdStyle}>{chipList(b.sub_category_ids, "subCategories")}</td>
                    <td style={tdStyle}>{resolver.get("countries", b.country_id) || "…"}</td>
                    <td style={tdStyle}>
                      <span className={`badge ${b.current_status === "existing" ? "badge-green" : "badge-gray"}`}>
                        {b.current_status || "Select"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <Can permission="buyer.update">
                        <select value={b.potential || ""} onChange={(e) => handlePotentialChange(b, e.target.value)} style={inlineSelectStyle}>
                          <option value="">Select</option>
                          <option value="yes">Yes</option>
                          <option value="no">No</option>
                        </select>
                      </Can>
                    </td>
                    <td style={tdStyle}>
                      <Can permission="buyer.update">
                        <select value={b.buyer_grade || ""} onChange={(e) => handleGradeChange(b, e.target.value)} style={inlineSelectStyle}>
                          <option value="">—</option>
                          <option value="A">A</option>
                          <option value="B">B</option>
                          <option value="C">C</option>
                        </select>
                      </Can>
                    </td>
                    <td style={tdStyle}>{new Date(b.created_at).toLocaleDateString()}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <Can permission="buyer.update">
                          <button type="button" onClick={() => openEdit(b)} className="btn-link">Edit</button>
                          {b.is_active ? (
                            <button type="button" onClick={() => handleDeactivate(b)} className="btn-link">Deactivate</button>
                          ) : (
                            <button type="button" onClick={() => handleActivate(b)} className="btn-link">Activate</button>
                          )}
                        </Can>
                        <Can permission="buyer.delete">
                          <button type="button" onClick={() => handleDelete(b)} className="btn-link btn-link-danger">Delete</button>
                        </Can>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination pagination={pagination} pageSize={pageSize} onPageChange={setCurrentPage} />

        {modalMode && (
          <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.35)" }} onClick={() => setModalMode(null)} />
            <div style={{ position: "relative", width: 640, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto", background: "#fff", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: 24 }}>
              <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 16 }}>
                {modalMode === "create" ? "Add Buyer" : `Edit Buyer — ${form.company_name}`}
              </div>
              <form onSubmit={handleSubmit}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <TextField id="company_name" label="Name of Company *" required maxLength={255} value={form.company_name} onChange={(v) => setField("company_name", v)} />
                  <SelectField id="buyer_type" label="Buyer Type" value={form.buyer_type} onChange={(v) => setField("buyer_type", v)}>
                    <option value="">Select</option>
                    <option value="manufacturer">Manufacturer</option>
                    <option value="trader">Trader</option>
                  </SelectField>

                  <div>
                    <label style={labelStyle}>Country *</label>
                    <SearchableDropdown
                      value={form.country_id}
                      onChange={(v) => setField("country_id", v || "")}
                      placeholder="Uganda"
                      fetchOptions={searchFetcher("/masters/countries")}
                      fetchLabelForValue={fetchNameLabel("/masters/countries")}
                    />
                  </div>
                  <TextField id="city" label="City" maxLength={150} value={form.city} onChange={(v) => setField("city", v)} />

                  <div style={{ gridColumn: "span 2" }}>
                    <label style={labelStyle}>Product Category (multiple)</label>
                    <SearchableDropdownMulti
                      values={categoryIds}
                      onChange={setCategoryIds}
                      placeholder="Select categories…"
                      fetchOptions={searchFetcher("/masters/product-categories")}
                      fetchLabelForValue={fetchNameLabel("/masters/product-categories")}
                    />
                  </div>
                  <div style={{ gridColumn: "span 2" }}>
                    <label style={labelStyle}>Product Sub Category (multiple)</label>
                    <SearchableDropdownMulti
                      values={subCategoryIds}
                      onChange={setSubCategoryIds}
                      placeholder="Potential products for buying from us…"
                      fetchOptions={searchFetcher("/masters/product-sub-categories")}
                      fetchLabelForValue={fetchNameLabel("/masters/product-sub-categories")}
                    />
                  </div>

                  <TextAreaField id="address" label="Address" rows={2} value={form.address} onChange={(v) => setField("address", v)} style={{ gridColumn: "span 2" }} />

                  <SelectField id="contact_salutation" label="Salutation" value={form.contact_salutation} onChange={(v) => setField("contact_salutation", v)}>
                    <option value="">—</option>
                    <option value="Mr.">Mr.</option>
                    <option value="Mrs.">Mrs.</option>
                    <option value="Ms.">Ms.</option>
                  </SelectField>
                  <TextField id="contact_full_name" label="Primary Contact Full Name" maxLength={150} value={form.contact_full_name} onChange={(v) => setField("contact_full_name", v)} />
                  <TextField id="contact_designation" label="Designation" maxLength={150} value={form.contact_designation} onChange={(v) => setField("contact_designation", v)} />
                  <TextField id="contact_calling_number" label="Calling Number (with country code)" maxLength={20} value={form.contact_calling_number} onChange={(v) => setField("contact_calling_number", v)} />
                  <TextField id="contact_whatsapp_number" label="WhatsApp Number (with country code)" maxLength={20} value={form.contact_whatsapp_number} onChange={(v) => setField("contact_whatsapp_number", v)} />

                  <div style={{ gridColumn: "span 2" }}>
                    <label style={labelStyle}>Email ID (multiple)</label>
                    <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                      <input
                        type="email"
                        value={emailInput}
                        onChange={(e) => setEmailInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEmail(); } }}
                        placeholder="name@example.com"
                        style={{ flex: 1, padding: 8, border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 13 }}
                      />
                      <button type="button" className="btn btn-secondary" onClick={addEmail}>Add</button>
                    </div>
                    <div className="chip-list">
                      {form.emails.map((email) => (
                        <span className="chip" key={email}>
                          {email}
                          <button type="button" onClick={() => removeEmail(email)} style={{ marginLeft: 6, border: "none", background: "transparent", cursor: "pointer" }}>×</button>
                        </span>
                      ))}
                    </div>
                  </div>

                  <TextField id="tax_id_number" label="Tax ID Number (TIN / GST)" maxLength={100} value={form.tax_id_number} onChange={(v) => setField("tax_id_number", v)} />
                  <TextField id="website" label="Website" maxLength={500} value={form.website} onChange={(v) => setField("website", v)} />

                  <SelectField id="current_status" label="Current Status" value={form.current_status} onChange={(v) => setField("current_status", v)} hint={form.current_status === "existing" ? "Cannot be changed back to New once Existing." : undefined}>
                    <option value="">Select</option>
                    <option value="new">New</option>
                    <option value="existing">Existing</option>
                  </SelectField>
                  <TextAreaField id="product_range" label="Product Range they manufacture or supply" rows={2} value={form.product_range} onChange={(v) => setField("product_range", v)} />

                  <SelectField id="potential" label="Potential" value={form.potential} onChange={(v) => setField("potential", v)}>
                    <option value="">Select</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </SelectField>
                  {form.potential === "no" && (
                    <TextField id="potential_reason" label="Reason (Potential is No)" value={form.potential_reason} onChange={(v) => setField("potential_reason", v)} />
                  )}

                  <SelectField id="buyer_grade" label="Client Grade" value={form.buyer_grade} onChange={(v) => setField("buyer_grade", v)}>
                    <option value="">—</option>
                    <option value="A">A</option>
                    <option value="B">B</option>
                    <option value="C">C</option>
                  </SelectField>
                  <TextField id="currently_buying_from" label="Currently Buying From" value={form.currently_buying_from} onChange={(v) => setField("currently_buying_from", v)} />

                  <TextAreaField id="overall_remarks" label="Overall Observation / Remarks" rows={2} value={form.overall_remarks} onChange={(v) => setField("overall_remarks", v)} style={{ gridColumn: "span 2" }} />
                </div>

                {modalMode === "edit" && editingId && (
                  <div style={{ marginTop: 20, borderTop: "1px solid #E2E8F0", paddingTop: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>Contacts</div>
                      <button type="button" className="btn btn-secondary" onClick={() => setContactFormOpen((v) => !v)}>
                        + Add Contact
                      </button>
                    </div>
                    {contactFormOpen && (
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12, padding: 12, background: "#F8FAFC", borderRadius: 8 }}>
                        <TextField id="c_person_name" label="Full Name *" required value={contactForm.person_name} onChange={(v) => setContactForm((f) => ({ ...f, person_name: v }))} />
                        <TextField id="c_designation" label="Designation" value={contactForm.designation} onChange={(v) => setContactForm((f) => ({ ...f, designation: v }))} />
                        <TextField id="c_calling" label="Calling Number" value={contactForm.calling_number} onChange={(v) => setContactForm((f) => ({ ...f, calling_number: v }))} />
                        <TextField id="c_whatsapp" label="WhatsApp Number" value={contactForm.whatsapp_number} onChange={(v) => setContactForm((f) => ({ ...f, whatsapp_number: v }))} />
                        <TextField id="c_email" label="Email" type="email" value={contactForm.email} onChange={(v) => setContactForm((f) => ({ ...f, email: v }))} />
                        <div style={{ display: "flex", alignItems: "flex-end" }}>
                          <button type="button" className="btn btn-primary" onClick={handleAddContact}>Save Contact</button>
                        </div>
                      </div>
                    )}
                    <table style={{ width: "100%", fontSize: 13 }}>
                      <tbody>
                        {contacts.map((c) => (
                          <tr key={c.id}>
                            <td style={{ padding: "6px 4px" }}>{c.person_name}{c.is_primary && <span className="badge badge-gray" style={{ marginLeft: 6 }}>Primary</span>}</td>
                            <td style={{ padding: "6px 4px" }}>{c.designation || "—"}</td>
                            <td style={{ padding: "6px 4px" }}>{c.calling_number || "—"}</td>
                            <td style={{ padding: "6px 4px" }}>{c.email || "—"}</td>
                            <td style={{ padding: "6px 4px", textAlign: "right" }}>
                              {!c.is_primary && (
                                <button type="button" onClick={() => handleDeleteContact(c.id)} className="btn-link btn-link-danger">Delete</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setModalMode(null)}>Cancel</button>
                  <button type="submit" className="btn btn-primary">{modalMode === "create" ? "Create Buyer" : "Save Changes"}</button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </AppShell>
  );
}

const thStyle: React.CSSProperties = { padding: "8px 10px", textAlign: "left", borderBottom: "1px solid #E2E8F0" };
const tdStyle: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid #F1F5F9" };
const selectStyle: React.CSSProperties = { padding: 8, border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 13 };
const inlineSelectStyle: React.CSSProperties = { padding: "3px 4px", border: "1px solid #E2E8F0", borderRadius: 4, fontSize: 12 };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 };
