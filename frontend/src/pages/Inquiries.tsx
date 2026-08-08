/**
 * Inquiry (Requirement) workflow. Implements the document's two-layer
 * structure as three drill-down views within one page:
 *
 *   Layer 1 (company-wise)      -> Layer 1 inside a company (FB1, FB2...) -> Layer 2 (items in a consignment)
 *   CompaniesView                  ConsignmentsView                          ItemsView
 *
 * Navigation is local view-state, not separate routes, matching the
 * document's "Process Flow -- First we choose Buyer company ... Once we
 * click company, then it opens ... with all columns" description of one
 * continuous drill-down rather than distinct pages.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { SearchableDropdown, type DropdownOption } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, toQueryString } from "@/lib/api";
import { useAuth } from "@/lib/hooks";
import type { Buyer } from "@/types/buyers";
import type { CompanySummary, ConsignmentCode, Inquiry, InquiryItem, InquiryListItem } from "@/types/inquiries";

type View =
  | { layer: "companies" }
  | { layer: "consignments"; buyerId: string }
  | { layer: "items"; inquiryId: string; buyerId: string };

const EMPTY_ITEM_FORM = {
  buyer_id: "",
  consignment_code_id: "",
  product_id: "",
  quantity: "",
  brand_preference: "",
  product_specs_remarks: "",
};

function statusBadgeClass(status: string): string {
  if (status === "fully_approved" || status === "approved") return "badge-green";
  if (status === "partial_approved") return "badge-yellow";
  return "badge-gray";
}

function statusLabel(status: string): string {
  return status
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function InquiriesPage() {
  const { hasPermission } = useAuth();
  const [view, setView] = useState<View>({ layer: "companies" });
  const [error, setError] = useState<unknown>(null);

  // Name caches, resolved lazily as ids appear (bounded to what's on screen).
  const [buyerNames, setBuyerNames] = useState<Record<string, string>>({});
  const [codeNames, setCodeNames] = useState<Record<string, string>>({});
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [uomNames, setUomNames] = useState<Record<string, string>>({});

  const resolveBuyerName = useCallback(async (buyerId: string) => {
    if (buyerNames[buyerId]) return;
    try {
      const { data } = await apiGet<Buyer>(`/buyers/${buyerId}`);
      setBuyerNames((prev) => ({ ...prev, [buyerId]: data.company_name }));
    } catch {
      setBuyerNames((prev) => ({ ...prev, [buyerId]: "Unknown Company" }));
    }
  }, [buyerNames]);

  const resolveCodeName = useCallback(async (codeId: string) => {
    if (codeNames[codeId]) return;
    try {
      const { data } = await apiGet<ConsignmentCode[]>("/inquiries/consignment-codes");
      const map: Record<string, string> = {};
      data.forEach((c) => { map[c.id] = c.code; });
      setCodeNames((prev) => ({ ...prev, ...map }));
    } catch {
      /* best-effort */
    }
  }, [codeNames]);

  const resolveProductAndUom = useCallback(async (productId: string, uomId: string) => {
    if (!productNames[productId]) {
      try {
        const { data } = await apiGet<{ product_code: string; product_name?: string | null; product_name_tally?: string | null }>(`/masters/products/${productId}`);
        setProductNames((prev) => ({ ...prev, [productId]: `${data.product_code} — ${data.product_name || data.product_name_tally}` }));
      } catch {
        setProductNames((prev) => ({ ...prev, [productId]: "Unknown Product" }));
      }
    }
    if (!uomNames[uomId]) {
      try {
        const { data } = await apiGet<{ name: string }>(`/masters/uom/${uomId}`);
        setUomNames((prev) => ({ ...prev, [uomId]: data.name }));
      } catch {
        setUomNames((prev) => ({ ...prev, [uomId]: uomId }));
      }
    }
  }, [productNames, uomNames]);

  return (
    <AppShell activeKey="inquiries">
      <main className="page">
        <Breadcrumb
          trail={
            view.layer === "companies"
              ? ["Inquiries & Consignments"]
              : view.layer === "consignments"
              ? ["Inquiries & Consignments", buyerNames[view.buyerId] || "…"]
              : ["Inquiries & Consignments", buyerNames[view.buyerId] || "…", "Consignment"]
          }
        />
        <Banner error={error} />

        {view.layer === "companies" && (
          <CompaniesView
            onOpenCompany={(buyerId) => { setView({ layer: "consignments", buyerId }); void resolveBuyerName(buyerId); }}
            resolveBuyerName={resolveBuyerName}
            buyerNames={buyerNames}
            onError={setError}
          />
        )}
        {view.layer === "consignments" && (
          <ConsignmentsView
            buyerId={view.buyerId}
            buyerName={buyerNames[view.buyerId]}
            onBack={() => setView({ layer: "companies" })}
            onOpenConsignment={(inquiryId) => setView({ layer: "items", inquiryId, buyerId: view.buyerId })}
            resolveCodeName={resolveCodeName}
            codeNames={codeNames}
            onError={setError}
          />
        )}
        {view.layer === "items" && (
          <ItemsView
            inquiryId={view.inquiryId}
            buyerId={view.buyerId}
            buyerName={buyerNames[view.buyerId]}
            onBack={() => setView({ layer: "consignments", buyerId: view.buyerId })}
            resolveProductAndUom={resolveProductAndUom}
            productNames={productNames}
            uomNames={uomNames}
            codeNames={codeNames}
            resolveCodeName={resolveCodeName}
            canApprove={hasPermission("inquiry.approve")}
            canUpdate={hasPermission("inquiry.update")}
            canDelete={hasPermission("inquiry.delete")}
            onError={setError}
          />
        )}
      </main>
    </AppShell>
  );
}

/* ------------------------------------------------------------------ */
/* Layer 1: company-wise summary                                       */
/* ------------------------------------------------------------------ */

function CompaniesView({
  onOpenCompany,
  resolveBuyerName,
  buyerNames,
  onError,
}: {
  onOpenCompany: (buyerId: string) => void;
  resolveBuyerName: (buyerId: string) => Promise<void>;
  buyerNames: Record<string, string>;
  onError: (err: unknown) => void;
}) {
  const [summaries, setSummaries] = useState<CompanySummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data } = await apiGet<CompanySummary[]>("/inquiries/companies");
        if (!cancelled) {
          setSummaries(data);
          await Promise.all(data.map((s) => resolveBuyerName(s.buyer_id)));
        }
      } catch (err) {
        if (!cancelled) onError(err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", marginBottom: 4 }}>Inquiries — Company Wise</h1>
      <p className="muted" style={{ marginBottom: 16 }}>
        Select a buyer company to see its consignments (e.g. FB1, FB2, ING1…).
      </p>
      <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              <th style={thStyle}>Buyer Company</th>
              <th style={thStyle}>Consignments</th>
              <th style={thStyle}>Total CBM</th>
              <th style={thStyle}>Total Weight</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableMessageRow colSpan={4}>Loading…</TableMessageRow>
            ) : summaries.length === 0 ? (
              <TableMessageRow colSpan={4}>No inquiries yet. Add an item from a consignment to get started.</TableMessageRow>
            ) : (
              summaries.map((s) => (
                <tr key={s.buyer_id}>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => onOpenCompany(s.buyer_id)} className="btn-link">
                      {buyerNames[s.buyer_id] || "…"}
                    </button>
                  </td>
                  <td style={tdStyle}>{s.consignment_count}</td>
                  <td style={tdStyle}>{s.total_cbm.toFixed(3)}</td>
                  <td style={tdStyle}>{s.total_weight.toFixed(2)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Layer 1 inside a company: consignment codes (FB1, FB2, ...)         */
/* ------------------------------------------------------------------ */

function ConsignmentsView({
  buyerId,
  buyerName,
  onBack,
  onOpenConsignment,
  resolveCodeName,
  codeNames,
  onError,
}: {
  buyerId: string;
  buyerName?: string;
  onBack: () => void;
  onOpenConsignment: (inquiryId: string) => void;
  resolveCodeName: (codeId: string) => Promise<void>;
  codeNames: Record<string, string>;
  onError: (err: unknown) => void;
}) {
  const [rows, setRows] = useState<InquiryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiGet<InquiryListItem[]>(`/inquiries/companies/${buyerId}`);
      setRows(data);
      await Promise.all(data.map((r) => resolveCodeName(r.consignment_code_id)));
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buyerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => (codeNames[r.consignment_code_id] || "").toLowerCase().includes(q));
  }, [rows, search, codeNames]);

  async function handleDelete(inquiryId: string) {
    if (!window.confirm("Delete this consignment and all its items?")) return;
    try {
      await apiDelete(`/inquiries/${inquiryId}`);
      void load();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <button type="button" onClick={onBack} className="btn-link" style={{ marginBottom: 8 }}>
        ← All Companies
      </button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0 }}>{buyerName || "…"} — Consignments</h1>
        <Can permission="inquiry.create">
          <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
            + Add Inquiry Item
          </button>
        </Can>
      </div>

      <input
        placeholder="Search consignment code…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        style={{ padding: 8, border: "1px solid #CBD5E1", borderRadius: 6, fontSize: 13, marginBottom: 12, width: 260 }}
      />

      <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              <th style={thStyle}></th>
              <th style={thStyle}>Consignment Code</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Total CBM</th>
              <th style={thStyle}>Total Weight</th>
              <th style={thStyle}>Updated</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableMessageRow colSpan={7}>Loading…</TableMessageRow>
            ) : filtered.length === 0 ? (
              <TableMessageRow colSpan={7}>No consignments for this company yet.</TableMessageRow>
            ) : (
              filtered.map((r) => (
                <tr key={r.id}>
                  <td style={tdStyle}><input type="checkbox" /></td>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => onOpenConsignment(r.id)} className="btn-link">
                      {codeNames[r.consignment_code_id] || "…"}
                    </button>
                  </td>
                  <td style={tdStyle}>
                    <span className={`badge ${statusBadgeClass(r.consignment_status)}`}>{statusLabel(r.consignment_status)}</span>
                  </td>
                  <td style={tdStyle}>{r.total_cbm.toFixed(3)}</td>
                  <td style={tdStyle}>{r.total_weight.toFixed(2)}</td>
                  <td style={tdStyle}>{new Date(r.updated_at).toLocaleDateString()}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" onClick={() => onOpenConsignment(r.id)} className="btn-link">View</button>
                      <Can permission="inquiry.delete">
                        <button type="button" onClick={() => handleDelete(r.id)} className="btn-link btn-link-danger">Delete</button>
                      </Can>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <AddItemModal
          defaultBuyerId={buyerId}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
          onError={onError}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Layer 2: items within a consignment                                 */
/* ------------------------------------------------------------------ */

function ItemsView({
  inquiryId,
  buyerId,
  buyerName,
  onBack,
  resolveProductAndUom,
  productNames,
  uomNames,
  codeNames,
  resolveCodeName,
  canApprove,
  canUpdate,
  canDelete,
  onError,
}: {
  inquiryId: string;
  buyerId: string;
  buyerName?: string;
  onBack: () => void;
  resolveProductAndUom: (productId: string, uomId: string) => Promise<void>;
  productNames: Record<string, string>;
  uomNames: Record<string, string>;
  codeNames: Record<string, string>;
  resolveCodeName: (codeId: string) => Promise<void>;
  canApprove: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onError: (err: unknown) => void;
}) {
  const [inquiry, setInquiry] = useState<Inquiry | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [addOpen, setAddOpen] = useState(false);
  const [shiftTarget, setShiftTarget] = useState<InquiryItem | null>(null);
  const [remarksTarget, setRemarksTarget] = useState<InquiryItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiGet<Inquiry>(`/inquiries/${inquiryId}`);
      setInquiry(data);
      await resolveCodeName(data.consignment_code_id);
      await Promise.all(data.items.map((i) => resolveProductAndUom(i.product_id, i.uom_id)));
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inquiryId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Document: "All pending entries to show on top by default" -- the backend already
  // orders pending-first; keep that order here rather than re-sorting client-side.
  const items = inquiry?.items ?? [];

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkTallyPost() {
    if (selectedIds.size === 0) return;
    try {
      await apiPost("/inquiries/items/bulk-tally-post", { item_ids: Array.from(selectedIds) });
      setSelectedIds(new Set());
      void load();
    } catch (err) {
      onError(err);
    }
  }

  async function handleApprove(item: InquiryItem) {
    try {
      await apiPost(`/inquiries/${inquiryId}/items/${item.id}/approve`, {});
      void load();
    } catch (err) {
      onError(err);
    }
  }

  async function handleRevert(item: InquiryItem) {
    try {
      await apiPost(`/inquiries/${inquiryId}/items/${item.id}/revert`, {});
      void load();
    } catch (err) {
      onError(err);
    }
  }

  async function handleDeleteItem(item: InquiryItem) {
    if (!window.confirm("Delete this inquiry item?")) return;
    try {
      await apiDelete(`/inquiries/${inquiryId}/items/${item.id}`);
      void load();
    } catch (err) {
      onError(err);
    }
  }

  async function handleQuantityChange(item: InquiryItem, quantity: string) {
    const value = Number(quantity);
    if (!value || value <= 0) return;
    try {
      await apiPatch(`/inquiries/${inquiryId}/items/${item.id}`, { quantity: value });
      void load();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <button type="button" onClick={onBack} className="btn-link" style={{ marginBottom: 8 }}>
        ← {buyerName || "Consignments"}
      </button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0 }}>
            {inquiry ? codeNames[inquiry.consignment_code_id] || "…" : "…"}
          </h1>
          {inquiry && (
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              <span className={`badge ${statusBadgeClass(inquiry.consignment_status)}`}>{statusLabel(inquiry.consignment_status)}</span>
              {"  "}Total CBM: {inquiry.total_cbm.toFixed(3)} · Total Weight: {inquiry.total_weight.toFixed(2)}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Can permission="inquiry.update">
            <button type="button" className="btn btn-secondary" onClick={handleBulkTallyPost} disabled={selectedIds.size === 0}>
              Mark {selectedIds.size > 0 ? `${selectedIds.size} ` : ""}Tally Posted
            </button>
          </Can>
          <Can permission="inquiry.create">
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
              + Add Item
            </button>
          </Can>
        </div>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8, marginTop: 12 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              <th style={thStyle}></th>
              <th style={thStyle}>Product</th>
              <th style={thStyle}>Quantity</th>
              <th style={thStyle}>UOM</th>
              <th style={thStyle}>Brand Pref.</th>
              <th style={thStyle}>Specs / Remarks</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Tally Posted</th>
              <th style={thStyle}>Procurement Remarks</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <TableMessageRow colSpan={10}>Loading…</TableMessageRow>
            ) : items.length === 0 ? (
              <TableMessageRow colSpan={10}>No items in this consignment yet.</TableMessageRow>
            ) : (
              items.map((item) => (
                <tr
                  key={item.id}
                  style={item.requires_license ? { background: "#FEF2F2" } : undefined}
                  title={item.requires_license ? "This product requires a License/Certificate." : undefined}
                >
                  <td style={tdStyle}>
                    <Can permission="inquiry.update">
                      <input type="checkbox" checked={selectedIds.has(item.id)} onChange={() => toggleSelect(item.id)} />
                    </Can>
                  </td>
                  <td style={tdStyle}>
                    <span style={item.requires_license ? { color: "#DC2626", fontWeight: 600 } : undefined}>
                      {productNames[item.product_id] || "…"}
                    </span>
                    {item.requires_license && (
                      <div style={{ fontSize: 11, color: "#DC2626" }}>Requires License / Certificate</div>
                    )}
                  </td>
                  <td style={tdStyle}>
                    <Can permission="inquiry.update">
                      <input
                        type="number"
                        min={0.0001}
                        step="any"
                        defaultValue={item.quantity}
                        onBlur={(e) => handleQuantityChange(item, e.target.value)}
                        style={{ width: 80, padding: 4, border: "1px solid #E2E8F0", borderRadius: 4 }}
                      />
                    </Can>
                    {!canUpdate && item.quantity}
                  </td>
                  <td style={tdStyle}>{uomNames[item.uom_id] || "…"}</td>
                  <td style={tdStyle}>{item.brand_preference || <span className="muted">—</span>}</td>
                  <td style={tdStyle}>{item.product_specs_remarks || <span className="muted">—</span>}</td>
                  <td style={tdStyle}>
                    <span className={`badge ${statusBadgeClass(item.status)}`}>{statusLabel(item.status)}</span>
                  </td>
                  <td style={tdStyle}>{item.tally_entry_posted ? "Posted" : <span className="muted">Pending</span>}</td>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => setRemarksTarget(item)} className="btn-link" title="View / Edit">
                      {item.procurement_remarks ? "View 👁" : "Add"}
                    </button>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {canApprove && item.status === "proposed" && (
                        <button type="button" onClick={() => handleApprove(item)} className="btn-link">Approve</button>
                      )}
                      {canApprove && item.status === "approved" && (
                        <button type="button" onClick={() => handleRevert(item)} className="btn-link">Revert</button>
                      )}
                      <Can permission="inquiry.update">
                        <button type="button" onClick={() => setShiftTarget(item)} className="btn-link">Shift</button>
                      </Can>
                      {canDelete && (
                        <button type="button" onClick={() => handleDeleteItem(item)} className="btn-link btn-link-danger">Delete</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {addOpen && (
        <AddItemModal
          defaultBuyerId={buyerId}
          defaultConsignmentCodeId={inquiry?.consignment_code_id}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); void load(); }}
          onError={onError}
        />
      )}

      {shiftTarget && (
        <ShiftItemModal
          buyerId={buyerId}
          item={shiftTarget}
          onClose={() => setShiftTarget(null)}
          onShifted={() => { setShiftTarget(null); void load(); }}
          onError={onError}
        />
      )}

      {remarksTarget && (
        <ProcurementRemarksModal
          inquiryId={inquiryId}
          item={remarksTarget}
          onClose={() => setRemarksTarget(null)}
          onSaved={() => { setRemarksTarget(null); void load(); }}
          onError={onError}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function AddItemModal({
  defaultBuyerId,
  defaultConsignmentCodeId,
  onClose,
  onSaved,
  onError,
}: {
  defaultBuyerId: string;
  defaultConsignmentCodeId?: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [form, setForm] = useState({ ...EMPTY_ITEM_FORM, buyer_id: defaultBuyerId, consignment_code_id: defaultConsignmentCodeId || "" });
  const [status, setStatus] = useState<"proposed" | "approved">("proposed");

  const codeFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      const { data } = await apiGet<ConsignmentCode[]>(
        `/inquiries/consignment-codes${toQueryString({ buyer_id: defaultBuyerId })}`,
        { signal }
      );
      return data.filter((c) => c.code.toLowerCase().includes(term.toLowerCase())).map((c) => ({ value: c.id, label: c.code }));
    },
    [defaultBuyerId]
  );

  const codeLabel = useCallback(async (id: string) => {
    const { data } = await apiGet<ConsignmentCode[]>(`/inquiries/consignment-codes${toQueryString({ buyer_id: defaultBuyerId })}`);
    return data.find((c) => c.id === id)?.code || id;
  }, [defaultBuyerId]);

  const productFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      const { data } = await apiGet<{ id: string; product_code: string; product_name?: string | null; product_name_tally?: string | null }[]>(
        "/masters/products" + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" }),
        { signal }
      );
      return data.map((d) => ({ value: d.id, label: `${d.product_code} — ${d.product_name || d.product_name_tally}` }));
    },
    []
  );

  const productLabel = useCallback(async (id: string) => {
    const { data } = await apiGet<{ product_code: string; product_name?: string | null; product_name_tally?: string | null }>(`/masters/products/${id}`);
    return `${data.product_code} — ${data.product_name || data.product_name_tally}`;
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.consignment_code_id || !form.product_id || !form.quantity) return;
    try {
      await apiPost("/inquiries/items", {
        buyer_id: form.buyer_id,
        consignment_code_id: form.consignment_code_id,
        product_id: form.product_id,
        quantity: Number(form.quantity),
        brand_preference: form.brand_preference || null,
        product_specs_remarks: form.product_specs_remarks || null,
        status,
      });
      onSaved();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <ModalShell title="Add Inquiry Item" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>Consignment Code *</label>
        <SearchableDropdown
          value={form.consignment_code_id}
          onChange={(v) => setForm((f) => ({ ...f, consignment_code_id: v || "" }))}
          placeholder="e.g. FB1"
          fetchOptions={codeFetcher}
          fetchLabelForValue={codeLabel}
        />

        <label style={{ ...labelStyle, marginTop: 12 }}>Product Name *</label>
        <SearchableDropdown
          value={form.product_id}
          onChange={(v) => setForm((f) => ({ ...f, product_id: v || "" }))}
          placeholder="Search products…"
          fetchOptions={productFetcher}
          fetchLabelForValue={productLabel}
        />

        <div style={{ marginTop: 12 }}>
          <TextField
            id="quantity"
            label="Quantity *"
            required
            type="number"
            value={form.quantity}
            onChange={(v) => setForm((f) => ({ ...f, quantity: v }))}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <TextField
            id="brand_preference"
            label="Brand Preference (optional)"
            value={form.brand_preference}
            onChange={(v) => setForm((f) => ({ ...f, brand_preference: v }))}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <TextAreaField
            id="product_specs_remarks"
            label="Product Specs / Remarks (optional)"
            rows={2}
            value={form.product_specs_remarks}
            onChange={(v) => setForm((f) => ({ ...f, product_specs_remarks: v }))}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <SelectField id="status" label="Status" value={status} onChange={(v) => setStatus(v as "proposed" | "approved")}>
            <option value="proposed">Proposed</option>
            <option value="approved">Approved</option>
          </SelectField>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Add Item</button>
        </div>
      </form>
    </ModalShell>
  );
}

function ShiftItemModal({
  buyerId,
  item,
  onClose,
  onShifted,
  onError,
}: {
  buyerId: string;
  item: InquiryItem;
  onClose: () => void;
  onShifted: () => void;
  onError: (err: unknown) => void;
}) {
  const [targetCodeId, setTargetCodeId] = useState("");

  const codeFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      const { data } = await apiGet<ConsignmentCode[]>(`/inquiries/consignment-codes${toQueryString({ buyer_id: buyerId })}`, { signal });
      return data.filter((c) => c.code.toLowerCase().includes(term.toLowerCase())).map((c) => ({ value: c.id, label: c.code }));
    },
    [buyerId]
  );

  const codeLabel = useCallback(async (id: string) => {
    const { data } = await apiGet<ConsignmentCode[]>(`/inquiries/consignment-codes${toQueryString({ buyer_id: buyerId })}`);
    return data.find((c) => c.id === id)?.code || id;
  }, [buyerId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!targetCodeId) return;
    try {
      await apiPost(`/inquiries/${item.inquiry_id}/items/${item.id}/shift`, { to_consignment_code_id: targetCodeId });
      onShifted();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <ModalShell title="Shift Item to Another Consignment" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>Move to Consignment Code *</label>
        <SearchableDropdown value={targetCodeId} onChange={(v) => setTargetCodeId(v || "")} placeholder="e.g. FB2" fetchOptions={codeFetcher} fetchLabelForValue={codeLabel} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Shift Item</button>
        </div>
      </form>
    </ModalShell>
  );
}

function ProcurementRemarksModal({
  inquiryId,
  item,
  onClose,
  onSaved,
  onError,
}: {
  inquiryId: string;
  item: InquiryItem;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const [remarks, setRemarks] = useState(item.procurement_remarks || "");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await apiPatch(`/inquiries/${inquiryId}/items/${item.id}/procurement-remarks`, { remarks: remarks || null });
      onSaved();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <ModalShell title="Procurement Team Remarks" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <TextAreaField id="remarks" label="Remarks (by Yinglima China Procurement Team)" rows={4} value={remarks} onChange={setRemarks} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.35)" }} onClick={onClose} />
      <div style={{ position: "relative", width: 480, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", background: "#fff", borderRadius: 10, boxShadow: "0 12px 32px rgba(0,0,0,0.18)", padding: 22 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 14 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: "8px 10px", textAlign: "left", borderBottom: "1px solid #E2E8F0" };
const tdStyle: React.CSSProperties = { padding: "6px 10px", borderBottom: "1px solid #F1F5F9" };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 };
