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
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { SearchableDropdown, type DropdownOption, type FetchOptions } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, toQueryString } from "@/lib/api";
import { useLiveModule } from "@/lib/live/useLive";
import { useAuth, usePendingGuard } from "@/lib/hooks";
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

function InquiriesBuyerSummarySkeletonRows({ count = 6 }: { count?: number }) {
  const companyWidths = ["70%", "85%", "60%", "75%", "90%", "65%"];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={`inq-b-sk-${i}`}>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "16px", height: "16px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: companyWidths[i % companyWidths.length], height: "15px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", gap: "4px" }}>
              <div className="skeleton-line" style={{ width: "45px", height: "18px", borderRadius: "10px" }} />
              <div className="skeleton-line" style={{ width: "45px", height: "18px", borderRadius: "10px" }} />
            </div>
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "65px", height: "20px", borderRadius: "12px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "40px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "45px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "70px", height: "14px", borderRadius: "4px" }} />
          </td>
          <td style={{ padding: "12px 14px" }}>
            <div className="skeleton-line" style={{ width: "60px", height: "24px", borderRadius: "4px" }} />
          </td>
        </tr>
      ))}
    </>
  );
}

function InquiriesConsignmentSkeletonRows({ count = 5 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={`inq-c-sk-${i}`}>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "16px", height: "16px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "65px", height: "15px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "70px", height: "20px", borderRadius: "12px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "45px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "50px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "75px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "50px", height: "24px", borderRadius: "4px" }} /></td>
        </tr>
      ))}
    </>
  );
}

function InquiriesItemsSkeletonRows({ count = 6 }: { count?: number }) {
  const prodWidths = ["80%", "65%", "90%", "75%", "85%"];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={`inq-i-sk-${i}`}>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "16px", height: "16px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: prodWidths[i % prodWidths.length], height: "15px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "35px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "30px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "55px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "70px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "65px", height: "20px", borderRadius: "12px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "40px", height: "18px", borderRadius: "10px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "60px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}>
            <div style={{ display: "flex", gap: "6px" }}>
              <div className="skeleton-line" style={{ width: "28px", height: "28px", borderRadius: "4px" }} />
              <div className="skeleton-line" style={{ width: "28px", height: "28px", borderRadius: "4px" }} />
            </div>
          </td>
        </tr>
      ))}
    </>
  );
}

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
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddInitialBuyerId, setQuickAddInitialBuyerId] = useState("");

  const navigateToView = useCallback((nextView: View) => {
    setView(nextView);
  }, []);

  // Name caches, resolved lazily as ids appear (bounded to what's on screen).
  const [buyerNames, setBuyerNames] = useState<Record<string, string>>({});
  const [codeNames, setCodeNames] = useState<Record<string, string>>({});
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [uomNames, setUomNames] = useState<Record<string, string>>({});

  const resolveBuyerName = useCallback(async (buyerId: string) => {
    try {
      const { data } = await apiGet<Buyer>(`/buyers/${buyerId}`);
      setBuyerNames((prev) => ({ ...prev, [buyerId]: data.company_name || (data as any).name || buyerId }));
    } catch {
      setBuyerNames((prev) => ({ ...prev, [buyerId]: "Unknown Company" }));
    }
  }, []);

  const resolveCodeName = useCallback(async (_codeId?: string) => {
    try {
      const { data } = await apiGet<ConsignmentCode[]>("/inquiries/consignment-codes");
      const map: Record<string, string> = {};
      data.forEach((c) => { map[c.id] = c.code; });
      setCodeNames((prev) => ({ ...prev, ...map }));
    } catch {
      /* best-effort */
    }
  }, []);

  const resolveProductAndUom = useCallback(async (productId: string, uomId: string) => {
    try {
      const { data } = await apiGet<{ product_code: string; product_name?: string | null; product_name_tally?: string | null }>(`/masters/products/${productId}`);
      setProductNames((prev) => ({ ...prev, [productId]: `${data.product_code} — ${data.product_name || data.product_name_tally}` }));
    } catch {
      setProductNames((prev) => ({ ...prev, [productId]: "Unknown Product" }));
    }
    try {
      const { data } = await apiGet<{ name: string }>(`/masters/uom/${uomId}`);
      setUomNames((prev) => ({ ...prev, [uomId]: data.name }));
    } catch {
      setUomNames((prev) => ({ ...prev, [uomId]: uomId }));
    }
  }, []);

  const [stats, setStats] = useState({ pending: 0, approved: 0, ongoing: 0, completed: 0, total_order: 0 });
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Calculate dynamic inquiry counts from database
  useEffect(() => {
    (async () => {
      try {
        const { data: summaries } = await apiGet<CompanySummary[]>("/inquiries/companies");
        let pending = 0;
        let approved = 0;
        let ongoing = 0;
        let completed = 0;
        let total_order = 0;

        for (const s of summaries) {
          total_order += s.consignment_count || 0;
          if (s.consignment_status === "proposed") {
            pending += s.consignment_count || 0;
            ongoing += s.consignment_count || 0;
          } else if (s.consignment_status === "partial_approved") {
            ongoing += s.consignment_count || 0;
            approved += s.approved_count || 0;
            pending += s.proposed_count || 0;
          } else if (s.consignment_status === "fully_approved") {
            approved += s.consignment_count || 0;
            completed += s.consignment_count || 0;
          }
        }
        setStats({ pending, approved, ongoing, completed, total_order });
      } catch {
        /* fallback */
      }
    })();
  }, [quickAddOpen, view, refreshTrigger]);

  return (
    <AppShell activeKey="inquiries">
      <main className="page" style={{ padding: "24px" }}>
        {/* Top Breadcrumb & Actions Bar */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <div>
            <h1 style={{ fontSize: "24px", fontWeight: 700, color: "#0f172a", margin: 0 }}>Inquiry</h1>
            <div style={{ fontSize: "13px", color: "#64748b", marginTop: "2px" }}>
              Dashboard / Sales / Inquiries
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => { setQuickAddInitialBuyerId(""); setQuickAddOpen(true); }}
              style={{
                background: "#0061f2",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 2px 4px rgba(0,97,242,0.2)",
              }}
            >
              + Quick Add
            </button>
            <button
              type="button"
              onClick={() => { setQuickAddInitialBuyerId(""); setQuickAddOpen(true); }}
              style={{
                background: "#0061f2",
                color: "#ffffff",
                border: "none",
                borderRadius: "6px",
                padding: "8px 16px",
                fontSize: "13px",
                fontWeight: 600,
                cursor: "pointer",
                boxShadow: "0 2px 4px rgba(0,97,242,0.2)",
              }}
            >
              + ADD NEW
            </button>
          </div>
        </div>

        {/* Top KPI Cards matching Figma prototype */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "16px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: "#fffbe6",
                border: "1px solid #fef3c7",
                color: "#b45309",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
              }}
            >
              🕒
            </div>
            <div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                {String(stats.pending).padStart(2, "0")}
              </div>
              <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500 }}>Pending</div>
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "16px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: "#f0fdf4",
                border: "1px solid #bbf7d0",
                color: "#15803d",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
              }}
            >
              ✅
            </div>
            <div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                {String(stats.approved).padStart(2, "0")}
              </div>
              <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500 }}>Approved</div>
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "16px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: "#eff6ff",
                border: "1px solid #bfdbfe",
                color: "#1d4ed8",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
              }}
            >
              🔄
            </div>
            <div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                {String(stats.ongoing).padStart(2, "0")}
              </div>
              <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500 }}>Ongoing</div>
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "16px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: "#f0f9ff",
                border: "1px solid #bae6fd",
                color: "#0284c7",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
              }}
            >
              👍
            </div>
            <div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                {String(stats.completed).padStart(2, "0")}
              </div>
              <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500 }}>Completed</div>
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: "10px",
              padding: "16px",
              display: "flex",
              alignItems: "center",
              gap: "14px",
              boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            }}
          >
            <div
              style={{
                width: "42px",
                height: "42px",
                borderRadius: "50%",
                background: "#f8fafc",
                border: "1px solid #cbd5e1",
                color: "#334155",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "18px",
              }}
            >
              📦
            </div>
            <div>
              <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                {String(stats.total_order).padStart(2, "0")}
              </div>
              <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500 }}>Total Order</div>
            </div>
          </div>
        </div>

        <Banner error={error} />

        {view.layer === "companies" && (
          <CompaniesView
            onOpenCompany={(buyerId) => { navigateToView({ layer: "consignments", buyerId }); void resolveBuyerName(buyerId); }}
            resolveBuyerName={resolveBuyerName}
            buyerNames={buyerNames}
            onError={setError}
            refreshKey={refreshTrigger}
            onOpenQuickAdd={(buyerId) => { setQuickAddInitialBuyerId(buyerId || ""); setQuickAddOpen(true); }}
          />
        )}
        {view.layer === "consignments" && (
          <ConsignmentsView
            buyerId={view.buyerId}
            buyerName={buyerNames[view.buyerId]}
            onBack={() => setView({ layer: "companies" })}
            onOpenConsignment={(inquiryId) => navigateToView({ layer: "items", inquiryId, buyerId: view.buyerId })}
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

        {/* Quick Add Side Drawer */}
        {quickAddOpen && (
          <QuickInquiryDrawer
            initialBuyerId={quickAddInitialBuyerId}
            onClose={() => setQuickAddOpen(false)}
            onSaved={() => {
              setQuickAddOpen(false);
              setRefreshTrigger((k) => k + 1);
              setView({ layer: "companies" });
            }}
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
  refreshKey,
  onOpenQuickAdd,
}: {
  onOpenCompany: (buyerId: string) => void;
  resolveBuyerName: (buyerId: string) => Promise<void>;
  buyerNames: Record<string, string>;
  onError: (err: unknown) => void;
  refreshKey: number;
  onOpenQuickAdd: (buyerId?: string) => void;
}) {
  const [summaries, setSummaries] = useState<CompanySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBuyerIds, setSelectedBuyerIds] = useState<string[]>([]);

  const loadSummaries = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await apiGet<CompanySummary[]>("/inquiries/companies");
      const activeSummaries = data.filter((s) => s.consignment_count > 0);
      setSummaries(activeSummaries);
      activeSummaries.forEach((s) => {
        if (!s.company_name || s.company_name === "Unknown Company") {
          void resolveBuyerName(s.buyer_id);
        }
      });
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [onError, resolveBuyerName]);

  useEffect(() => {
    void loadSummaries();
  }, [loadSummaries, refreshKey]);

  const toggleSelectAll = () => {
    if (selectedBuyerIds.length === summaries.length) {
      setSelectedBuyerIds([]);
    } else {
      setSelectedBuyerIds(summaries.map((s) => s.buyer_id));
    }
  };

  const toggleSelectOne = (id: string) => {
    setSelectedBuyerIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  async function handleDeleteCompanyInquiries(buyerId: string) {
    if (!window.confirm("Are you sure you want to delete all consignments for this buyer company?")) return;
    try {
      const { data: consignments } = await apiGet<InquiryListItem[]>(`/inquiries/companies/${buyerId}`);
      await Promise.all(consignments.map((c) => apiDelete(`/inquiries/${c.id}`)));
      void loadSummaries();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0 }}>Inquiries — Company Wise</h1>
          <p className="muted" style={{ margin: "4px 0 0 0" }}>
            Select a buyer company to see its consignments (e.g. FB1, FB2, ING1…).
          </p>
        </div>
      </div>
      <div style={{ overflowX: "auto", border: "1px solid #E2E8F0", borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "#F8FAFC" }}>
              <th style={{ ...thStyle, width: "40px" }}>
                <input
                  type="checkbox"
                  checked={summaries.length > 0 && selectedBuyerIds.length === summaries.length}
                  onChange={toggleSelectAll}
                />
              </th>
              <th style={thStyle}>Inquiry By (Buyer Company)</th>
              <th style={thStyle}>Consignment Codes</th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Total CBM</th>
              <th style={thStyle}>Total Weight</th>
              <th style={thStyle}>Updated Date</th>
              <th style={thStyle}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <InquiriesBuyerSummarySkeletonRows count={6} />
            ) : summaries.length === 0 ? (
              <TableMessageRow colSpan={8}>No inquiries yet. Add an item from a consignment to get started.</TableMessageRow>
            ) : (
              summaries.map((s) => (
                <tr key={s.buyer_id}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selectedBuyerIds.includes(s.buyer_id)}
                      onChange={() => toggleSelectOne(s.buyer_id)}
                    />
                  </td>
                  <td style={tdStyle}>
                    <button type="button" onClick={() => onOpenCompany(s.buyer_id)} className="btn-link" style={{ fontWeight: 600 }}>
                      🏢 {s.company_name || buyerNames[s.buyer_id] || "..."}
                    </button>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "4px", flexWrap: "wrap" }}>
                      {s.consignment_codes && s.consignment_codes.length > 0 ? (
                        s.consignment_codes.map((code, idx) => (
                          <span
                            key={idx}
                            onClick={() => onOpenCompany(s.buyer_id)}
                            style={{
                              background: "#eff6ff",
                              color: "#1d4ed8",
                              border: "1px solid #bfdbfe",
                              padding: "2px 8px",
                              borderRadius: "4px",
                              fontSize: "12px",
                              fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            📦 {code}
                          </span>
                        ))
                      ) : (
                        <span style={{ color: "#94a3b8" }}>{s.consignment_count} consignment(s)</span>
                      )}
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span className={`badge ${statusBadgeClass(s.consignment_status)}`}>
                      {statusLabel(s.consignment_status)}
                    </span>
                  </td>
                  <td style={tdStyle}>{s.total_cbm.toFixed(3)}</td>
                  <td style={tdStyle}>{s.total_weight.toFixed(2)}</td>
                  <td style={tdStyle}>{s.updated_at ? new Date(s.updated_at).toLocaleDateString() : "-"}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button
                        type="button"
                        onClick={() => onOpenCompany(s.buyer_id)}
                        className="btn btn-secondary"
                        style={{ padding: "4px 8px", fontSize: "12px" }}
                        title="View Details"
                      >
                        👁️ View
                      </button>
                      <button
                        type="button"
                        onClick={() => onOpenQuickAdd(s.buyer_id)}
                        className="btn btn-secondary"
                        style={{ padding: "4px 8px", fontSize: "12px" }}
                        title="Edit / Add New Item"
                      >
                        ✏️ Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteCompanyInquiries(s.buyer_id)}
                        className="btn btn-secondary"
                        style={{ padding: "4px 8px", fontSize: "12px", color: "#ef4444" }}
                        title="Delete All Consignments"
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  </td>
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
  // Phase 7: keyed so deleting one row never disables another row's button.
  const { isPending: isRowActionPending, guard: guardRowAction } = usePendingGuard<string>();

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
    await guardRowAction(`delete:${inquiryId}`, async () => {
      try {
        await apiDelete(`/inquiries/${inquiryId}`);
        void load();
      } catch (err) {
        onError(err);
      }
    });
  }

  return (
    <>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "#0F172A", margin: 0 }}>{buyerName || "…"} — Consignments</h1>
        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button type="button" onClick={onBack} className="btn btn-outline" style={{ background: "#ffffff", border: "1px solid #cbd5e1", color: "#475569", fontWeight: 600, fontSize: "13px", padding: "6px 14px", borderRadius: "6px", cursor: "pointer" }}>
            ← All Companies
          </button>
          <Can permission="inquiry.create">
            <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
              + Add Inquiry Item
            </button>
          </Can>
        </div>
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
              <InquiriesConsignmentSkeletonRows count={5} />
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
                        <button
                          type="button"
                          onClick={() => handleDelete(r.id)}
                          disabled={isRowActionPending(`delete:${r.id}`)}
                          className="btn-link btn-link-danger"
                        >
                          {isRowActionPending(`delete:${r.id}`) ? "Deleting…" : "Delete"}
                        </button>
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
  // Phase 7: keyed per item+action so approving/reverting/deleting one row,
  // or the bulk tally-post, never disables an unrelated row's controls.
  const { isPending: isRowActionPending, guard: guardRowAction } = usePendingGuard<string>();

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

  /**
   * Live sync (Phase 9): backend inquiry events (`app.inquiries.routes.
   * _publish_inquiry_event`) are published at the ITEM level -- entity_id
   * is the InquiryItem's own id, not the parent consignment's -- and
   * carry only a small partial `changes` payload (see the dispatcher's
   * own docstring), not a full item record. Rather than duplicate this
   * page's own quantity/status/shift/approve business rules to hand-patch
   * `inquiry.items` from that partial payload (which `useLiveList` is
   * built for on FLAT lists, not this nested `Inquiry.items` shape), this
   * performs a targeted re-fetch of just this one consignment whenever
   * any inquiry event arrives while it's open. Cheap (one GET, not the
   * whole Layer-1 list) and always correct, since `load()` is the exact
   * same fetch this view already uses for its initial render.
   */
  useLiveModule("inquiries", () => {
    void load();
  });

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
    await guardRowAction("bulk-tally-post", async () => {
      try {
        await apiPost("/inquiries/items/bulk-tally-post", { item_ids: Array.from(selectedIds) });
        setSelectedIds(new Set());
        void load();
      } catch (err) {
        onError(err);
      }
    });
  }

  async function handleApprove(item: InquiryItem) {
    await guardRowAction(`approve:${item.id}`, async () => {
      try {
        await apiPost(`/inquiries/${inquiryId}/items/${item.id}/approve`, {});
        void load();
      } catch (err) {
        onError(err);
      }
    });
  }

  async function handleRevert(item: InquiryItem) {
    await guardRowAction(`revert:${item.id}`, async () => {
      try {
        await apiPost(`/inquiries/${inquiryId}/items/${item.id}/revert`, {});
        void load();
      } catch (err) {
        onError(err);
      }
    });
  }

  async function handleDeleteItem(item: InquiryItem) {
    if (!window.confirm("Delete this inquiry item?")) return;
    await guardRowAction(`delete:${item.id}`, async () => {
      try {
        await apiDelete(`/inquiries/${inquiryId}/items/${item.id}`);
        void load();
      } catch (err) {
        onError(err);
      }
    });
  }

  async function handleQuantityChange(item: InquiryItem, quantity: string) {
    const value = Number(quantity);
    if (!value || value <= 0) return;
    await guardRowAction(`qty:${item.id}`, async () => {
      try {
        await apiPatch(`/inquiries/${inquiryId}/items/${item.id}`, { quantity: value });
        void load();
      } catch (err) {
        onError(err);
      }
    });
  }

  return (
    <>
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
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button type="button" onClick={onBack} className="btn btn-outline" style={{ background: "#ffffff", border: "1px solid #cbd5e1", color: "#475569", fontWeight: 600, fontSize: "13px", padding: "6px 14px", borderRadius: "6px", cursor: "pointer" }}>
            ← {buyerName || "Consignments"}
          </button>
          <Can permission="inquiry.update">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleBulkTallyPost}
              disabled={selectedIds.size === 0 || isRowActionPending("bulk-tally-post")}
            >
              {isRowActionPending("bulk-tally-post")
                ? "Posting…"
                : `Mark ${selectedIds.size > 0 ? `${selectedIds.size} ` : ""}Tally Posted`}
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
              <InquiriesItemsSkeletonRows count={6} />
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
                        disabled={isRowActionPending(`qty:${item.id}`)}
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
                        <button
                          type="button"
                          onClick={() => handleApprove(item)}
                          disabled={isRowActionPending(`approve:${item.id}`)}
                          className="btn-link"
                        >
                          {isRowActionPending(`approve:${item.id}`) ? "Approving…" : "Approve"}
                        </button>
                      )}
                      {canApprove && item.status === "approved" && (
                        <button
                          type="button"
                          onClick={() => handleRevert(item)}
                          disabled={isRowActionPending(`revert:${item.id}`)}
                          className="btn-link"
                        >
                          {isRowActionPending(`revert:${item.id}`) ? "Reverting…" : "Revert"}
                        </button>
                      )}
                      <Can permission="inquiry.update">
                        <button type="button" onClick={() => setShiftTarget(item)} className="btn-link">Shift</button>
                      </Can>
                      {canDelete && (
                        <button
                          type="button"
                          onClick={() => handleDeleteItem(item)}
                          disabled={isRowActionPending(`delete:${item.id}`)}
                          className="btn-link btn-link-danger"
                        >
                          {isRowActionPending(`delete:${item.id}`) ? "Deleting…" : "Delete"}
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
  const [submitting, setSubmitting] = useState(false);

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
    if (submitting) return; // Phase 7: ignore a second click while the first save is still in flight
    if (!form.consignment_code_id || !form.product_id || !form.quantity) return;
    setSubmitting(true);
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
    } finally {
      setSubmitting(false);
    }
  }

  const handleProductSelect = async (v: string | null) => {
    const prodId = v || "";
    setForm((f) => ({ ...f, product_id: prodId }));
    if (prodId) {
      try {
        const { data: prod } = await apiGet<any>(`/masters/products/${prodId}`);
        if (prod) {
          setForm((f) => ({
            ...f,
            product_specs_remarks: prod.specification || prod.description || "",
          }));
        }
      } catch {
        /* ignore */
      }
    }
  };

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
          onChange={handleProductSelect}
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
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={submitting ? { cursor: "default", opacity: 0.7 } : undefined}
          >
            {submitting ? "Adding…" : "Add Item"}
          </button>
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
  const [submitting, setSubmitting] = useState(false);

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
    if (submitting) return; // Phase 7: ignore a second click while the first save is still in flight
    if (!targetCodeId) return;
    setSubmitting(true);
    try {
      await apiPost(`/inquiries/${item.inquiry_id}/items/${item.id}/shift`, { to_consignment_code_id: targetCodeId });
      onShifted();
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Shift Item to Another Consignment" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <label style={labelStyle}>Move to Consignment Code *</label>
        <SearchableDropdown value={targetCodeId} onChange={(v) => setTargetCodeId(v || "")} placeholder="e.g. FB2" fetchOptions={codeFetcher} fetchLabelForValue={codeLabel} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={submitting ? { cursor: "default", opacity: 0.7 } : undefined}
          >
            {submitting ? "Shifting…" : "Shift Item"}
          </button>
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
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // Phase 7: ignore a second click while the first save is still in flight
    setSubmitting(true);
    try {
      await apiPatch(`/inquiries/${inquiryId}/items/${item.id}/procurement-remarks`, { remarks: remarks || null });
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ModalShell title="Procurement Team Remarks" onClose={onClose}>
      <form onSubmit={handleSubmit}>
        <TextAreaField id="remarks" label="Remarks (by Yinglima China Procurement Team)" rows={4} value={remarks} onChange={setRemarks} />
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={submitting ? { cursor: "default", opacity: 0.7 } : undefined}
          >
            {submitting ? "Saving…" : "Save"}
          </button>
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

/* ------------------------------------------------------------------ */
/* Quick Access Side Drawer for Inquiry Creation                      */
/* ------------------------------------------------------------------ */

interface QuickItemRow {
  id: string;
  product_id: string;
  product_name: string;
  uom_name: string;
  quantity: string;
  brand_preference: string;
  product_specs_remarks: string;
  requires_license: boolean;
  license_details?: string | null;
}

function QuickInquiryDrawer({
  initialBuyerId = "",
  onClose,
  onSaved,
  onError,
}: {
  initialBuyerId?: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
}) {
  const { profile } = useAuth();
  const [companies, setCompanies] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const [uoms, setUoms] = useState<any[]>([]);

  const [selectedBuyerId, setSelectedBuyerId] = useState(initialBuyerId || "");
  const [consignmentCodes, setConsignmentCodes] = useState<ConsignmentCode[]>([]);
  const [selectedCodeId, setSelectedCodeId] = useState("");
  const [customNewCode, setCustomNewCode] = useState("");
  const [isCreatingNewCode, setIsCreatingNewCode] = useState(false);

  const [items, setItems] = useState<QuickItemRow[]>([
    {
      id: `row_${Date.now()}_1`,
      product_id: "",
      product_name: "",
      uom_name: "",
      quantity: "",
      brand_preference: "",
      product_specs_remarks: "",
      requires_license: false,
    },
  ]);

  const [saving, setSaving] = useState(false);

  // Auto-stamp Date & User
  const stampedDateStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  const stampedUserName = String(profile?.full_name || profile?.username || "Rahul Patel");

  useEffect(() => {
    (async () => {
      try {
        const [compRes, prodRes, uomRes] = await Promise.all([
          apiGet<any>("/buyers?limit=1000"),
          apiGet<any[]>("/masters/products"),
          apiGet<any[]>("/masters/uom"),
        ]);
        const buyersList = Array.isArray(compRes.data) ? compRes.data : compRes.data?.data || [];
        const formattedBuyers = buyersList.map((b: any) => ({
          ...b,
          name: b.company_name || b.name || "Unnamed Buyer",
        }));
        setCompanies(formattedBuyers);
        setProducts(prodRes.data);
        setUoms(uomRes.data);
      } catch (err) {
        onError(err);
      }
    })();
  }, []);

  const [allConsignmentCodes, setAllConsignmentCodes] = useState<ConsignmentCode[]>([]);

  // Fetch all global consignment codes for global code calculation
  useEffect(() => {
    (async () => {
      try {
        const { data } = await apiGet<ConsignmentCode[]>("/inquiries/consignment-codes");
        setAllConsignmentCodes(data);
      } catch {
        setAllConsignmentCodes([]);
      }
    })();
  }, [selectedBuyerId]);

  // Fetch consignment codes when buyer or branch changes
  useEffect(() => {
    if (!selectedBuyerId) {
      setConsignmentCodes([]);
      setSelectedCodeId("");
      return;
    }
    (async () => {
      try {
        const { data } = await apiGet<ConsignmentCode[]>(`/inquiries/consignment-codes${toQueryString({ buyer_id: selectedBuyerId })}`);
        setConsignmentCodes(data);
        if (data.length > 0 && initialBuyerId === selectedBuyerId) {
          setSelectedCodeId(data[0].id);
          setIsCreatingNewCode(false);
        } else {
          setSelectedCodeId("__NEW__");
          setIsCreatingNewCode(true);
        }
      } catch {
        setConsignmentCodes([]);
        setSelectedCodeId("__NEW__");
        setIsCreatingNewCode(true);
      }
    })();
  }, [selectedBuyerId, initialBuyerId]);

  // Fetch existing items when selectedCodeId points to an existing consignment
  useEffect(() => {
    if (!selectedBuyerId || !selectedCodeId || selectedCodeId === "__NEW__") {
      return;
    }
    (async () => {
      try {
        const { data: consignments } = await apiGet<any[]>(`/inquiries/companies/${selectedBuyerId}`);
        const matchingInquiry = consignments.find((c) => c.consignment_code_id === selectedCodeId);
        if (matchingInquiry) {
          const { data: inqItems } = await apiGet<any[]>(`/inquiries/${matchingInquiry.id}/items`);
          if (Array.isArray(inqItems) && inqItems.length > 0) {
            const mappedRows: QuickItemRow[] = inqItems.map((item) => {
              const prod = products.find((p) => p.id === item.product_id);
              const uomObj = uoms.find((u) => u.id === (prod?.uom_id || item.uom_id));
              const licReq = prod?.license_certificate_required;
              return {
                id: item.id,
                product_id: item.product_id,
                product_name: prod ? (prod.product_name_tally || prod.product_name) : (item.product_name || ""),
                uom_name: uomObj ? `${uomObj.name} (${uomObj.code})` : "",
                quantity: String(item.quantity || ""),
                brand_preference: item.brand_preference || "",
                product_specs_remarks: item.product_specs_remarks || (prod?.specification || prod?.description || ""),
                requires_license: Boolean(licReq && licReq.trim()),
                license_details: licReq || null,
              };
            });
            setItems(mappedRows);
          }
        }
      } catch {
        /* ignore fetch error */
      }
    })();
  }, [selectedBuyerId, selectedCodeId, products, uoms]);

  const selectedCompany = companies.find((c) => c.id === selectedBuyerId);

  // Compute recommended auto-code based on Buyer Company name/code (e.g. YG1, FB1, OS1)
  const recommendedCode = useMemo(() => {
    if (!selectedCompany) return "";
    const name = String(selectedCompany.name || selectedCompany.company_name || "");
    const code = selectedCompany.code;

    let prefix = "";
    if (code && String(code).trim()) {
      prefix = String(code).trim().toUpperCase();
    } else {
      const lower = name.toLowerCase();
      if (lower.includes("yinglima")) prefix = "YG";
      else if (lower.includes("food") || lower.includes("f&b") || lower.includes("f & b")) prefix = "FB";
      else if (lower.includes("one stop") || lower.includes("onestop")) prefix = "OS";
      else if (lower.includes("inhyma")) prefix = "INM";
      else {
        const words = name.trim().split(/\s+/).filter(Boolean);
        if (words.length >= 2) {
          prefix = words.map((w) => w[0]).join("").toUpperCase();
        } else if (name.length >= 2) {
          prefix = (name[0] + name[name.length - 1]).toUpperCase();
        } else {
          prefix = name.toUpperCase() || "CMP";
        }
      }
    }

    // Find highest index among ALL existing global codes with prefix
    const matchingCodes = allConsignmentCodes.filter((c) => c.code && c.code.toUpperCase().startsWith(prefix));
    let maxNum = 0;
    matchingCodes.forEach((c) => {
      const num = parseInt(c.code.toUpperCase().replace(prefix, ""), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    });
    return `${prefix}${maxNum + 1}`;
  }, [selectedCompany, allConsignmentCodes]);

  // Auto-fill recommended code into input as a real, bold value
  useEffect(() => {
    if (recommendedCode) {
      setCustomNewCode(recommendedCode);
    }
  }, [recommendedCode]);

  const handleAddItemRow = () => {
    setItems((prev) => [
      ...prev,
      {
        id: `row_${Date.now()}_${prev.length + 1}`,
        product_id: "",
        product_name: "",
        uom_name: "",
        quantity: "",
        brand_preference: "",
        product_specs_remarks: "",
        requires_license: false,
      },
    ]);
  };

  const handleRemoveItemRow = (index: number) => {
    if (items.length <= 1) return;
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleProductSelect = async (index: number, productId: string) => {
    if (!productId) {
      const updated = [...items];
      updated[index] = {
        ...updated[index],
        product_id: "",
        product_name: "",
        uom_name: "",
        requires_license: false,
      };
      setItems(updated);
      return;
    }

    let pickedProduct = products.find((p) => p.id === productId);
    if (!pickedProduct) {
      try {
        const { data } = await apiGet<any>(`/masters/products/${productId}`);
        pickedProduct = data;
      } catch {
        /* ignore */
      }
    }

    if (pickedProduct) {
      const uomObj = uoms.find((u) => u.id === pickedProduct.uom_id);
      const licReq = pickedProduct.license_certificate_required;
      const updated = [...items];
      updated[index] = {
        ...updated[index],
        product_id: pickedProduct.id,
        product_name: pickedProduct.product_name_tally || pickedProduct.product_name,
        uom_name: uomObj ? `${uomObj.name} (${uomObj.code})` : (pickedProduct.uom?.name || ""),
        brand_preference: updated[index].brand_preference || pickedProduct.brand_name || "",
        product_specs_remarks: pickedProduct.specification || pickedProduct.description || "",
        requires_license: Boolean(licReq && licReq.trim()),
        license_details: licReq || null,
      };
      setItems(updated);
    }
  };

  const handleUpdateItemField = (index: number, field: keyof QuickItemRow, val: any) => {
    const updated = [...items];
    updated[index] = { ...updated[index], [field]: val };
    setItems(updated);
  };

  const buyerFetcher: FetchOptions = useCallback(
    async (term, signal) => {
      const { data } = await apiGet<any>("/buyers" + toQueryString({ search: term, limit: 20 }), { signal });
      const list = Array.isArray(data) ? data : (data?.data || []);
      return list.map((b: any) => ({
        value: b.id,
        label: b.company_name || b.name || "Unnamed Buyer",
      }));
    },
    []
  );

  const buyerLabel = useCallback(async (id: string) => {
    try {
      const { data } = await apiGet<any>(`/buyers/${id}`);
      return data.company_name || data.name || id;
    } catch {
      return id;
    }
  }, []);

  const productFetcher: FetchOptions = useCallback(
    async (term, signal) => {
      const { data } = await apiGet<any[]>(
        "/masters/products" + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" }),
        { signal }
      );
      return data.map((d) => ({
        value: d.id,
        label: `${d.product_name_tally || d.product_name} (${d.product_code || "NO-CODE"})`,
      }));
    },
    []
  );

  const productLabel = useCallback(async (id: string) => {
    try {
      const { data } = await apiGet<any>(`/masters/products/${id}`);
      return `${data.product_name_tally || data.product_name} (${data.product_code || "NO-CODE"})`;
    } catch {
      return id;
    }
  }, []);

  const handleSubmit = async (submitStatus: "proposed" | "approved") => {
    if (!selectedBuyerId) {
      alert("Please select a Buyer Company.");
      return;
    }
    const validItems = items.filter((i) => i.product_id && parseFloat(i.quantity) > 0);
    if (validItems.length === 0) {
      alert("Please add at least one product with valid quantity.");
      return;
    }

    setSaving(true);
    try {
      let finalCodeId = selectedCodeId;

      // Create new consignment code if needed
      if (isCreatingNewCode || !finalCodeId) {
        const codeToCreate = customNewCode.trim().toUpperCase() || recommendedCode;
        const createRes = await apiPost<ConsignmentCode>("/inquiries/consignment-codes", {
          code: codeToCreate,
          label: `${selectedCompany?.name || ""} Consignment ${codeToCreate}`,
          buyer_id: selectedBuyerId,
          branch_id: null,
        });
        finalCodeId = createRes.data.id;
      } else {
        // Clean up previous items of this consignment before re-saving updated list
        try {
          const { data: consignments } = await apiGet<any[]>(`/inquiries/companies/${selectedBuyerId}`);
          const matchingInquiry = consignments.find((c) => c.consignment_code_id === finalCodeId);
          if (matchingInquiry) {
            const { data: existingItems } = await apiGet<any[]>(`/inquiries/${matchingInquiry.id}/items`);
            if (Array.isArray(existingItems) && existingItems.length > 0) {
              await Promise.all(existingItems.map((i: any) => apiDelete(`/inquiries/${matchingInquiry.id}/items/${i.id}`)));
            }
          }
        } catch {
          /* ignore delete cleanup errors */
        }
      }

      // Save inquiry items
      for (const itemRow of validItems) {
        await apiPost("/inquiries/items", {
          buyer_id: selectedBuyerId,
          branch_id: null,
          consignment_code_id: finalCodeId,
          product_id: itemRow.product_id,
          quantity: parseFloat(itemRow.quantity),
          brand_preference: itemRow.brand_preference || null,
          product_specs_remarks: itemRow.product_specs_remarks || null,
          status: submitStatus,
        });
      }

      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100000, display: "flex", justifyContent: "flex-end" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15, 23, 42, 0.45)", backdropFilter: "blur(3px)" }} onClick={onClose} />

      <div
        style={{
          position: "relative",
          width: "680px",
          maxWidth: "95vw",
          height: "100vh",
          background: "#ffffff",
          boxShadow: "-10px 0 25px rgba(0, 0, 0, 0.15)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {/* Header Bar */}
        <div style={{ padding: "20px 24px", background: "#f8fafc", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 700, color: "#0f172a" }}>⚡ Create Quick Inquiry</h3>
            <div style={{ fontSize: "12.5px", color: "#64748b", marginTop: "2px" }}>
              Quickly add products &amp; generate consignment requirements.
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        {/* Form Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Company & Branch Header Card */}
          <div style={{ background: "#f1f5f9", padding: "16px", borderRadius: "10px", border: "1px solid #cbd5e1" }}>
            <div style={{ marginBottom: "14px" }}>
              <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                Inquiry By (Buyer Company) *
              </label>
              <SearchableDropdown
                value={selectedBuyerId}
                onChange={(val) => setSelectedBuyerId(val || "")}
                placeholder="Search Buyer Company..."
                fetchOptions={buyerFetcher}
                fetchLabelForValue={buyerLabel}
              />
            </div>

            {/* Consignment Code & Date Stamping Bar */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", alignItems: "center" }}>
              <div>
                <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                  Consignment Code *
                </label>
                {!isCreatingNewCode && consignmentCodes.length > 0 ? (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <select
                      value={selectedCodeId}
                      onChange={(e) => {
                        if (e.target.value === "__NEW__") {
                          setCustomNewCode(recommendedCode);
                          setIsCreatingNewCode(true);
                        } else {
                          setSelectedCodeId(e.target.value);
                        }
                      }}
                      style={{ flex: 1, padding: "8px 12px", borderRadius: "6px", border: "1px solid #0061f2", fontSize: "13.5px", fontWeight: 700, color: "#0061f2", background: "#eff6ff" }}
                    >
                      <option value="__NEW__">➕ Create New Code ({recommendedCode || "Auto"})</option>
                      {consignmentCodes.map((c) => (
                        <option key={c.id} value={c.id}>📦 Existing Code ({c.code})</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div style={{ display: "flex", gap: "8px" }}>
                    <input
                      type="text"
                      placeholder={`e.g. ${recommendedCode}`}
                      value={customNewCode}
                      onChange={(e) => setCustomNewCode(e.target.value.toUpperCase())}
                      style={{ flex: 1, padding: "8px 12px", borderRadius: "6px", border: "1.5px solid #0061f2", fontSize: "13.5px", fontWeight: 700, color: "#0f172a", background: "#f8fafc" }}
                    />
                    {consignmentCodes.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setIsCreatingNewCode(false)}
                        style={{ padding: "6px 10px", background: "#e2e8f0", border: "none", borderRadius: "6px", fontSize: "12px", cursor: "pointer" }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Date & User Auto Stamping Badge */}
              <div>
                <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "6px" }}>
                  Auto Stamping (Date &amp; User)
                </label>
                <div style={{ background: "#ffffff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "12.5px", fontWeight: 600, color: "#334155", display: "flex", alignItems: "center", gap: "8px" }}>
                  <span>📅 {stampedDateStr}</span>
                  <span style={{ color: "#94a3b8" }}>|</span>
                  <span>👤 {stampedUserName}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Product Items Repeater Section */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px" }}>
              <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a" }}>📦 Product Line Items</h4>
              <button
                type="button"
                onClick={handleAddItemRow}
                style={{ background: "#e0f2fe", color: "#0369a1", border: "1px solid #bae6fd", borderRadius: "6px", padding: "6px 12px", fontSize: "12.5px", fontWeight: 700, cursor: "pointer" }}
              >
                + Add Item
              </button>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
              {items.map((row, idx) => (
                <div
                  key={row.id}
                  style={{
                    background: row.requires_license ? "#fef2f2" : "#ffffff",
                    border: row.requires_license ? "2px solid #ef4444" : "1px solid #e2e8f0",
                    borderRadius: "10px",
                    padding: "16px",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.03)",
                    display: "flex",
                    flexDirection: "column",
                    gap: "12px",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: "12px", fontWeight: 700, color: "#64748b" }}>Item #{idx + 1}</span>
                    {items.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveItemRow(idx)}
                        style={{ background: "none", border: "none", color: "#ef4444", fontSize: "16px", cursor: "pointer" }}
                        title="Remove Item"
                      >
                        🗑️
                      </button>
                    )}
                  </div>

                  {/* 🔴 RED License Warning Banner */}
                  {row.requires_license && (
                    <div style={{ background: "#fee2e2", border: "1px solid #fca5a5", color: "#b91c1c", padding: "8px 12px", borderRadius: "6px", fontSize: "12px", fontWeight: 700, display: "flex", alignItems: "center", gap: "6px" }}>
                      ⚠️ License / Certificate Needed: {row.license_details || "Import Certificate Required"}
                    </div>
                  )}

                  {/* Product Search & Quantity */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 140px", gap: "12px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                        Product Name *
                      </label>
                      <SearchableDropdown
                        value={row.product_id}
                        onChange={(val) => handleProductSelect(idx, val || "")}
                        placeholder="Search products…"
                        fetchOptions={productFetcher}
                        fetchLabelForValue={productLabel}
                      />
                    </div>

                    <div>
                      <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#334155", marginBottom: "4px" }}>
                        Quantity {row.uom_name ? `(${row.uom_name})` : ""} *
                      </label>
                      <input
                        type="number"
                        placeholder="e.g. 50"
                        value={row.quantity}
                        onChange={(e) => handleUpdateItemField(idx, "quantity", e.target.value)}
                        style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e0", fontSize: "13px" }}
                      />
                    </div>
                  </div>

                  {/* Brand Preference & Product Specs */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "11.5px", color: "#64748b", marginBottom: "4px" }}>
                        Brand Preference (optional)
                      </label>
                      <input
                        type="text"
                        placeholder="Default from master"
                        value={row.brand_preference}
                        onChange={(e) => handleUpdateItemField(idx, "brand_preference", e.target.value)}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "5px", border: "1px solid #cbd5e0", fontSize: "12.5px" }}
                      />
                    </div>

                    <div>
                      <label style={{ display: "block", fontSize: "11.5px", color: "#64748b", marginBottom: "4px" }}>
                        Specs / Remarks (optional)
                      </label>
                      <input
                        type="text"
                        placeholder="Default specs"
                        value={row.product_specs_remarks}
                        onChange={(e) => handleUpdateItemField(idx, "product_specs_remarks", e.target.value)}
                        style={{ width: "100%", padding: "6px 10px", borderRadius: "5px", border: "1px solid #cbd5e0", fontSize: "12.5px" }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Drawer Footer Actions */}
        <div style={{ padding: "16px 24px", background: "#f8fafc", borderTop: "1px solid #e2e8f0", display: "flex", justifyContent: "flex-end", gap: "12px" }}>
          <button
            type="button"
            onClick={onClose}
            style={{ background: "#ffffff", border: "1px solid #cbd5e1", borderRadius: "6px", padding: "9px 18px", fontSize: "13px", fontWeight: 600, color: "#475569", cursor: "pointer" }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleSubmit("proposed")}
            style={{ background: "#0061f2", border: "none", borderRadius: "6px", padding: "9px 18px", fontSize: "13px", fontWeight: 600, color: "#ffffff", cursor: "pointer" }}
          >
            {saving ? "Saving..." : "Save as Proposed"}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => handleSubmit("approved")}
            style={{ background: "#16a34a", border: "none", borderRadius: "6px", padding: "9px 18px", fontSize: "13px", fontWeight: 600, color: "#ffffff", cursor: "pointer" }}
          >
            {saving ? "Saving..." : "Save & Approve"}
          </button>
        </div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: "11px 12px",
  textAlign: "left",
  borderBottom: "2px solid #CBD5E1",
  background: "#F8FAFC",
  color: "#0F172A",
  fontWeight: 700,
  fontSize: "12px",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const tdStyle: React.CSSProperties = { padding: "10px 12px", borderBottom: "1px solid #E2E8F0", verticalAlign: "middle" };
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#334155", marginBottom: 6 };
