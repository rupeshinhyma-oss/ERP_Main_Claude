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
import { useSearchParams } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { Banner, Can, TableMessageRow } from "@/components/ui";
import { SearchableDropdown, SearchableDropdownMultiPanel, type DropdownOption, type FetchOptions } from "@/components/SearchableDropdown";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiDelete, apiGet, apiPatch, apiPost, toQueryString } from "@/lib/api";
import { useLiveModule } from "@/lib/live/useLive";
import { useAuth, usePendingGuard } from "@/lib/hooks";
import { autoTitleCase } from "@/utils/text";
import type { Buyer } from "@/types/buyers";
import type { CompanySummary, ConsignmentCode, Inquiry, InquiryItem, InquiryListItem, Quotation } from "@/types/inquiries";

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
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={`inq-b-sk-${i}`}>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "24px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "160px", height: "16px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "50px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "70px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "70px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "85px", height: "22px", borderRadius: "12px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "55px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "14px" }}><div className="skeleton-line" style={{ width: "40px", height: "28px", borderRadius: "6px" }} /></td>
        </tr>
      ))}
    </>
  );
}

function InquiriesConsignmentSkeletonRows({ count = 6 }: { count?: number }) {
  const codeWidths = ["50px", "45px", "55px", "60px", "40px"];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={`inq-c-sk-${i}`}>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: codeWidths[i % codeWidths.length], height: "15px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "65px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "65px", height: "14px", borderRadius: "4px" }} /></td>
          <td style={{ padding: "12px 14px" }}><div className="skeleton-line" style={{ width: "80px", height: "22px", borderRadius: "12px" }} /></td>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const buyerIdParam = searchParams.get("buyerId");
  const inquiryIdParam = searchParams.get("inquiryId");

  const view = useMemo<View>(() => {
    if (inquiryIdParam && buyerIdParam) {
      return { layer: "items", inquiryId: inquiryIdParam, buyerId: buyerIdParam };
    }
    if (buyerIdParam) {
      return { layer: "consignments", buyerId: buyerIdParam };
    }
    return { layer: "companies" };
  }, [buyerIdParam, inquiryIdParam]);

  const [error, setError] = useState<unknown>(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddInitialBuyerId, setQuickAddInitialBuyerId] = useState("");

  const navigateToView = useCallback(
    (nextView: View) => {
      if (nextView.layer === "items") {
        setSearchParams({ buyerId: nextView.buyerId, inquiryId: nextView.inquiryId });
      } else if (nextView.layer === "consignments") {
        setSearchParams({ buyerId: nextView.buyerId });
      } else {
        setSearchParams({});
      }
    },
    [setSearchParams]
  );

  // Name caches, kept for optional fallbacks
  const [buyerNames, setBuyerNames] = useState<Record<string, string>>({});
  const [codeNames, setCodeNames] = useState<Record<string, string>>({});
  const [productNames, setProductNames] = useState<Record<string, string>>({});
  const [uomNames, setUomNames] = useState<Record<string, string>>({});
  const [stats, setStats] = useState({ pending: 0, approved: 0, ongoing: 0, completed: 0, total_order: 0 });
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const resolveBuyerName = useCallback(async (buyerId: string) => {
    try {
      const { data } = await apiGet<Buyer>(`/buyers/${buyerId}`);
      setBuyerNames((prev) => ({ ...prev, [buyerId]: data.company_name || (data as any).name || buyerId }));
    } catch {
      setBuyerNames((prev) => ({ ...prev, [buyerId]: "Unknown Company" }));
    }
  }, []);

  useEffect(() => {
    if (buyerIdParam && !buyerNames[buyerIdParam]) {
      void resolveBuyerName(buyerIdParam);
    }
  }, [buyerIdParam, buyerNames, resolveBuyerName]);

  useEffect(() => {
    (async () => {
      try {
        const [codeRes, prodRes, uomRes, buyerRes] = await Promise.all([
          apiGet<ConsignmentCode[]>("/inquiries/consignment-codes"),
          apiGet<any>("/masters/products?page_size=1000"),
          apiGet<any>("/masters/uom?page_size=1000"),
          apiGet<any>("/buyers?limit=1000"),
        ]);
        const cMap: Record<string, string> = {};
        codeRes.data.forEach((c) => { cMap[c.id] = c.code; });
        setCodeNames(cMap);

        const bList: any[] = Array.isArray(buyerRes.data) ? buyerRes.data : buyerRes.data?.data || [];
        const bMap: Record<string, string> = {};
        bList.forEach((b: any) => { bMap[b.id] = b.company_name || b.name || "Buyer"; });
        setBuyerNames(bMap);

        const pList: any[] = Array.isArray(prodRes.data) ? prodRes.data : prodRes.data?.data || [];
        const pMap: Record<string, string> = {};
        pList.forEach((p: any) => { pMap[p.id] = `${p.product_code || ""} — ${p.product_name || p.product_name_tally || ""}`; });
        setProductNames(pMap);

        const uList: any[] = Array.isArray(uomRes.data) ? uomRes.data : uomRes.data?.data || [];
        const uMap: Record<string, string> = {};
        uList.forEach((u: any) => { uMap[u.id] = u.name; });
        setUomNames(uMap);
      } catch {
        /* best-effort */
      }
    })();
  }, [refreshTrigger]);

  // Calculate dynamic inquiry counts from database without unnecessary refetches on view change
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
  }, [refreshTrigger]);

  return (
    <AppShell activeKey="inquiries">
      <main className="page" style={{ padding: "24px" }}>
        {/* Top Breadcrumb & Actions Bar & KPI Cards (Only on Companies Dashboard Layer) */}
        {view.layer === "companies" && (
          <>
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

            {/* Top 5 KPI Cards matching Figma prototype for Company Dashboard */}
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
                  transition: "all 0.15s ease",
                }}
              >
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "10px",
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    color: "#d97706",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
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
                  transition: "all 0.15s ease",
                }}
              >
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "10px",
                    background: "#ecfdf5",
                    border: "1px solid #a7f3d0",
                    color: "#059669",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
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
                  transition: "all 0.15s ease",
                }}
              >
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "10px",
                    background: "#eff6ff",
                    border: "1px solid #bfdbfe",
                    color: "#2563eb",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                  </svg>
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
                  transition: "all 0.15s ease",
                }}
              >
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "10px",
                    background: "#f0fdfa",
                    border: "1px solid #99f6e4",
                    color: "#0d9488",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
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
                  transition: "all 0.15s ease",
                }}
              >
                <div
                  style={{
                    width: "44px",
                    height: "44px",
                    borderRadius: "10px",
                    background: "#f5f3ff",
                    border: "1px solid #ddd6fe",
                    color: "#7c3aed",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
                    <line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                </div>
                <div>
                  <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
                    {String(stats.total_order).padStart(2, "0")}
                  </div>
                  <div style={{ fontSize: "12.5px", color: "#64748b", fontWeight: 500 }}>Total Order</div>
                </div>
              </div>
            </div>
          </>
        )}

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
            onBack={() => navigateToView({ layer: "companies" })}
            onOpenConsignment={(inquiryId) => navigateToView({ layer: "items", inquiryId, buyerId: view.buyerId })}
            codeNames={codeNames}
            onError={setError}
          />
        )}
        {view.layer === "items" && (
          <ItemsView
            inquiryId={view.inquiryId}
            buyerId={view.buyerId}
            buyerName={buyerNames[view.buyerId]}
            onBack={() => navigateToView({ layer: "consignments", buyerId: view.buyerId })}
            productNames={productNames}
            uomNames={uomNames}
            codeNames={codeNames}
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
              navigateToView({ layer: "companies" });
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
  codeNames,
  onError,
}: {
  buyerId: string;
  buyerName?: string;
  onBack: () => void;
  onOpenConsignment: (inquiryId: string) => void;
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
    } catch (err) {
      onError(err);
    } finally {
      setLoading(false);
    }
  }, [buyerId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!search.trim()) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => (r.consignment_code || codeNames[r.consignment_code_id] || "").toLowerCase().includes(q));
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
                      {r.consignment_code || codeNames[r.consignment_code_id] || "…"}
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

/* ------------------------------------------------------------------ */
/* Layer 2: items within a consignment (Figma Master-Detail View)     */
/* ------------------------------------------------------------------ */

function ItemsView({
  inquiryId,
  buyerId,
  buyerName: _buyerName,
  onBack,
  productNames,
  uomNames: _uomNames,
  codeNames,
  canApprove: _canApprove,
  canUpdate: _canUpdate,
  canDelete: _canDelete,
  onError,
}: {
  inquiryId: string;
  buyerId: string;
  buyerName?: string;
  onBack: () => void;
  productNames: Record<string, string>;
  uomNames: Record<string, string>;
  codeNames: Record<string, string>;
  canApprove: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onError: (err: unknown) => void;
}) {
  const [inquiry, setInquiry] = useState<Inquiry | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [productTab, setProductTab] = useState<"all" | "approved" | "pending">("all");
  const [productSearch, setProductSearch] = useState("");
  const [quotationSearch, setQuotationSearch] = useState("");
  const [quotationSupplierFilter, setQuotationSupplierFilter] = useState("");
  const [quotations, setQuotations] = useState<Quotation[]>([]);
  const [loadingQuotes, setLoadingQuotes] = useState(false);

  // Modals & Drawers state
  const [addOpen, setAddOpen] = useState(false);
  const [shiftTarget, setShiftTarget] = useState<InquiryItem | null>(null);
  const [remarksTarget, setRemarksTarget] = useState<InquiryItem | null>(null);
  const [addQuoteOpen, setAddQuoteOpen] = useState(false);
  const [rfqOpen, setRfqOpen] = useState(false);
  const [viewTermsTarget, setViewTermsTarget] = useState<Quotation | null>(null);
  const [productInfoTarget, setProductInfoTarget] = useState<InquiryItem | null>(null);
  const [activeActionMenuId, setActiveActionMenuId] = useState<string | null>(null);
  const [editQtyItem, setEditQtyItem] = useState<{ id: string; qty: number } | null>(null);

  const { guard: guardRowAction } = usePendingGuard<string>();

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const { data } = await apiGet<Inquiry>(`/inquiries/${inquiryId}`);
      setInquiry(data);
      setSelectedItemId((prev) => prev || (data.items && data.items.length > 0 ? data.items[0].id : ""));
    } catch (err) {
      if (!silent) onError(err);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [inquiryId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  // Live real-time WebSocket subscription: updates quietly when a supplier submits a quotation
  useLiveModule("inquiries", () => {
    void load(true);
    if (selectedItemId) {
      void loadQuotations(selectedItemId, true);
    }
  });

  const items = inquiry?.items ?? [];

  // Selected item reference
  const selectedItem = useMemo(() => {
    return items.find((i) => i.id === selectedItemId) || items[0] || null;
  }, [items, selectedItemId]);

  // Load quotations when selected item changes
  const loadQuotations = useCallback(async (itemId: string, silent = false) => {
    if (!silent) setLoadingQuotes(true);
    try {
      const { data } = await apiGet<Quotation[]>(`/inquiries/items/${itemId}/quotations`);
      setQuotations(data || []);
    } catch (err) {
      console.warn("Failed to load quotations", err);
      if (!silent) setQuotations([]);
    } finally {
      if (!silent) setLoadingQuotes(false);
    }
  }, []);

  useEffect(() => {
    if (selectedItem?.id) {
      void loadQuotations(selectedItem.id);
    } else {
      setQuotations([]);
    }
  }, [selectedItem?.id, loadQuotations]);

  // Seamless silent auto-sync every 3s so mobile submissions appear instantly on screen
  useEffect(() => {
    if (!selectedItem?.id) return;
    const interval = setInterval(() => {
      void loadQuotations(selectedItem.id, true);
    }, 3000);
    return () => clearInterval(interval);
  }, [selectedItem?.id, loadQuotations]);

  // Filtered products on left
  const filteredProducts = useMemo(() => {
    let list = items;
    if (productTab === "approved") {
      list = list.filter((i) => i.status === "approved");
    } else if (productTab === "pending") {
      list = list.filter((i) => i.status !== "approved");
    }
    if (productSearch.trim()) {
      const q = productSearch.toLowerCase().trim();
      list = list.filter((i) => {
        const name = (i.product_name || i.product_name_tally || "").toLowerCase();
        const code = (i.product_code || "").toLowerCase();
        return name.includes(q) || code.includes(q);
      });
    }
    return list;
  }, [items, productTab, productSearch]);

  const approvedCount = items.filter((i) => i.status === "approved").length;
  const pendingCount = items.filter((i) => i.status !== "approved").length;

  // Filtered quotations on right
  const filteredQuotations = useMemo(() => {
    let list = quotations;
    if (quotationSupplierFilter) {
      list = list.filter((q) => q.supplier_id === quotationSupplierFilter);
    }
    if (quotationSearch.trim()) {
      const q = quotationSearch.toLowerCase().trim();
      list = list.filter(
        (item) =>
          item.quote_number.toLowerCase().includes(q) ||
          (item.supplier_name && item.supplier_name.toLowerCase().includes(q))
      );
    }
    return list;
  }, [quotations, quotationSupplierFilter, quotationSearch]);

  // Unique suppliers from quotations for filter
  const quotationSuppliers = useMemo(() => {
    const map = new Map<string, string>();
    quotations.forEach((q) => {
      if (q.supplier_id && q.supplier_name) {
        map.set(q.supplier_id, q.supplier_name);
      }
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [quotations]);

  // Total Confirmed Amount
  const totalAmount = useMemo(() => {
    return quotations
      .filter((q) => q.status === "approved")
      .reduce((sum, q) => sum + (q.total_cost || 0), 0);
  }, [quotations]);

  async function handleApproveQuote(quote: Quotation) {
    await guardRowAction(`quote_status:${quote.id}`, async () => {
      try {
        await apiPatch(`/inquiries/quotations/${quote.id}/status`, { status: "approved" });
        if (selectedItem?.id) void loadQuotations(selectedItem.id);
        void load();
      } catch (err) {
        onError(err);
      } finally {
        setActiveActionMenuId(null);
      }
    });
  }

  async function handleRejectQuote(quote: Quotation) {
    await guardRowAction(`quote_status:${quote.id}`, async () => {
      try {
        await apiPatch(`/inquiries/quotations/${quote.id}/status`, { status: "rejected" });
        if (selectedItem?.id) void loadQuotations(selectedItem.id);
        void load();
      } catch (err) {
        onError(err);
      } finally {
        setActiveActionMenuId(null);
      }
    });
  }

  async function handleDeleteQuote(quote: Quotation) {
    if (!window.confirm(`Are you sure you want to delete Quotation #${quote.quote_number}?`)) {
      return;
    }
    await guardRowAction(`quote_delete:${quote.id}`, async () => {
      try {
        await apiDelete(`/inquiries/quotations/${quote.id}`);
        if (selectedItem?.id) void loadQuotations(selectedItem.id);
        void load();
      } catch (err) {
        onError(err);
      } finally {
        setActiveActionMenuId(null);
      }
    });
  }

  async function handleQuantitySave(item: InquiryItem, newQty: number) {
    if (!newQty || newQty <= 0) return;
    try {
      await apiPatch(`/inquiries/${inquiryId}/items/${item.id}`, { quantity: newQty });
      setEditQtyItem(null);
      void load();
    } catch (err) {
      onError(err);
    }
  }

  async function handleDeleteItem(item: InquiryItem) {
    if (!window.confirm("Are you sure you want to delete this product item?")) return;
    try {
      await apiDelete(`/inquiries/${inquiryId}/items/${item.id}`);
      if (selectedItemId === item.id) {
        setSelectedItemId(null);
      }
      void load();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* ---------------- Top Consignment Header & Actions ---------------- */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
          <h1 style={{ fontSize: "24px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
            #{inquiry?.consignment_code || (inquiry ? codeNames[inquiry.consignment_code_id] || "..." : "...")}
          </h1>
          <span
            style={{
              padding: "4px 12px",
              borderRadius: "20px",
              fontSize: "12.5px",
              fontWeight: 600,
              background:
                inquiry?.consignment_status === "fully_approved"
                  ? "#dcfce7"
                  : inquiry?.consignment_status === "partial_approved"
                    ? "#e0f2fe"
                    : "#fef3c7",
              color:
                inquiry?.consignment_status === "fully_approved"
                  ? "#15803d"
                  : inquiry?.consignment_status === "partial_approved"
                    ? "#0284c7"
                    : "#b45309",
              border: `1px solid ${inquiry?.consignment_status === "fully_approved"
                  ? "#bbf7d0"
                  : inquiry?.consignment_status === "partial_approved"
                    ? "#bae6fd"
                    : "#fde68a"
                }`,
            }}
          >
            {statusLabel(inquiry?.consignment_status || "proposed")}
          </span>
          <button
            type="button"
            onClick={() => setProductInfoTarget(selectedItem)}
            style={{ background: "none", border: "none", color: "#2563eb", fontSize: "13.5px", fontWeight: 600, cursor: "pointer", textDecoration: "underline" }}
          >
            View Info.
          </button>
        </div>

        <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
          <button
            type="button"
            onClick={onBack}
            style={{
              background: "#ffffff",
              border: "1px solid #cbd5e1",
              color: "#334155",
              fontWeight: 600,
              fontSize: "13px",
              padding: "7px 16px",
              borderRadius: "8px",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "6px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
            }}
          >
            ← Back
          </button>
          <Can permission="inquiry.create">
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              style={{
                background: "#2563eb",
                color: "#ffffff",
                border: "none",
                fontWeight: 600,
                fontSize: "13px",
                padding: "7px 16px",
                borderRadius: "8px",
                cursor: "pointer",
                boxShadow: "0 1px 2px rgba(37,99,235,0.2)",
              }}
            >
              + Add Item
            </button>
          </Can>
        </div>
      </div>

      {/* ---------------- 3 KPI Summary Cards ---------------- */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "16px" }}>
        {/* Card 1: Total Amount */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              background: "#eff6ff",
              border: "1px solid #bfdbfe",
              color: "#2563eb",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="20" height="13" x="2" y="5.5" rx="2" />
              <circle cx="12" cy="12" r="2.5" />
              <path d="M6 12h.01M18 12h.01" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
              ¥{totalAmount.toLocaleString()}
            </div>
            <div style={{ fontSize: "12.5px", color: "#64748b" }}>
              Total Amount <span style={{ fontSize: "11px", color: "#94a3b8" }}>As per Product Confirm</span>
            </div>
          </div>
        </div>

        {/* Card 2: Total CBM */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              background: "#f0fdfa",
              border: "1px solid #99f6e4",
              color: "#0d9488",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
              <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
              <line x1="12" y1="22.08" x2="12" y2="12" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
              {(inquiry?.total_cbm || 0).toFixed(1)}
            </div>
            <div style={{ fontSize: "12.5px", color: "#64748b" }}>Total CBM</div>
          </div>
        </div>

        {/* Card 3: Total Weight */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            padding: "16px 20px",
            display: "flex",
            alignItems: "center",
            gap: "14px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
          }}
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "10px",
              background: "#faf5ff",
              border: "1px solid #e9d5ff",
              color: "#9333ea",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
              <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
              <path d="M7 21h10" />
              <path d="M12 3v18" />
              <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: "20px", fontWeight: 700, color: "#0f172a" }}>
              {Math.round(inquiry?.total_weight || 0).toLocaleString()}
            </div>
            <div style={{ fontSize: "12.5px", color: "#64748b" }}>Total Weight (kg)</div>
          </div>
        </div>
      </div>

      {/* ---------------- Main 2-Column Master-Detail Layout ---------------- */}
      <div style={{ display: "grid", gridTemplateColumns: "360px 1fr", gap: "20px", alignItems: "stretch", minHeight: "calc(100vh - 210px)", paddingBottom: "24px" }}>
        {/* ================= LEFT COLUMN: PRODUCTS LIST (MASTER) ================= */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            padding: "18px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            minHeight: "calc(100vh - 210px)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
              Products ({items.length})
            </h3>
            <Can permission="inquiry.create">
              <button
                type="button"
                onClick={() => setAddOpen(true)}
                style={{ background: "none", border: "none", color: "#2563eb", fontSize: "13px", fontWeight: 600, cursor: "pointer" }}
              >
                + Add
              </button>
            </Can>
          </div>

          {/* Filter Tabs: All, Approved, Pending */}
          <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0", gap: "4px" }}>
            <button
              type="button"
              onClick={() => setProductTab("all")}
              style={{
                padding: "8px 12px",
                border: "none",
                background: "none",
                fontSize: "13px",
                fontWeight: productTab === "all" ? 700 : 500,
                color: productTab === "all" ? "#2563eb" : "#64748b",
                borderBottom: productTab === "all" ? "2px solid #2563eb" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setProductTab("approved")}
              style={{
                padding: "8px 12px",
                border: "none",
                background: "none",
                fontSize: "13px",
                fontWeight: productTab === "approved" ? 700 : 500,
                color: productTab === "approved" ? "#2563eb" : "#64748b",
                borderBottom: productTab === "approved" ? "2px solid #2563eb" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              Approved ({approvedCount})
            </button>
            <button
              type="button"
              onClick={() => setProductTab("pending")}
              style={{
                padding: "8px 12px",
                border: "none",
                background: "none",
                fontSize: "13px",
                fontWeight: productTab === "pending" ? 700 : 500,
                color: productTab === "pending" ? "#2563eb" : "#64748b",
                borderBottom: productTab === "pending" ? "2px solid #2563eb" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              Pending ({pendingCount})
            </button>
          </div>

          {/* Search Bar */}
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: "10px", top: "9px", color: "#94a3b8", fontSize: "14px" }}>🔍</span>
            <input
              type="text"
              placeholder="Search here..."
              value={productSearch}
              onChange={(e) => setProductSearch(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 10px 8px 32px",
                borderRadius: "8px",
                border: "1px solid #cbd5e1",
                fontSize: "13px",
                outline: "none",
              }}
            />
          </div>

          {/* Products Cards List */}
          <div style={{ display: "flex", flexDirection: "column", gap: "10px", flex: 1, maxHeight: "calc(100vh - 360px)", overflowY: "auto", paddingRight: "4px" }}>
            {loading ? (
              <div style={{ padding: "20px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>Loading products...</div>
            ) : filteredProducts.length === 0 ? (
              <div style={{ padding: "24px 12px", textAlign: "center", color: "#94a3b8", fontSize: "13px" }}>
                No products found.
              </div>
            ) : (
              filteredProducts.map((item) => {
                const isSelected = selectedItem?.id === item.id;
                const isApproved = item.status === "approved";
                return (
                  <div
                    key={item.id}
                    onClick={() => setSelectedItemId(item.id)}
                    style={{
                      padding: "12px 14px",
                      borderRadius: "10px",
                      border: isSelected ? "2px solid #2563eb" : "1px solid #e2e8f0",
                      background: isSelected ? "#f0f7ff" : "#ffffff",
                      cursor: "pointer",
                      display: "flex",
                      flexDirection: "column",
                      gap: "8px",
                      transition: "all 0.15s ease",
                      boxShadow: isSelected ? "0 2px 8px rgba(37,99,235,0.08)" : undefined,
                    }}
                  >
                    {/* Top Status Tag & Info Link */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span
                        style={{
                          padding: "2px 8px",
                          borderRadius: "4px",
                          fontSize: "11.5px",
                          fontWeight: 700,
                          background: isApproved ? "#dcfce7" : "#fef3c7",
                          color: isApproved ? "#15803d" : "#b45309",
                          border: `1px solid ${isApproved ? "#bbf7d0" : "#fde68a"}`,
                        }}
                      >
                        {statusLabel(item.status)}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setProductInfoTarget(item);
                        }}
                        style={{ background: "none", border: "none", color: "#64748b", fontSize: "12px", cursor: "pointer", textDecoration: "underline" }}
                      >
                        Info.
                      </button>
                    </div>

                    {/* Product Name & Code */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div>
                        <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a", lineHeight: 1.3 }}>
                          {item.product_name || item.product_name_tally || productNames[item.product_id] || "Product"}
                        </div>
                        <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                          #{item.product_code || "PC1093W40"}
                        </div>
                      </div>
                      <span style={{ color: "#94a3b8", fontSize: "14px", fontWeight: 700 }}>→</span>
                    </div>

                    {/* Quantity & Packaging Qty */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "12.5px", color: "#334155" }}>
                      <div>
                        <span style={{ fontWeight: 700, color: "#0f172a" }}>{item.quantity}</span> Qty.{" "}
                        <span style={{ fontWeight: 600 }}>{item.packaging_quantity || 10}</span> Pkg. Qty.
                      </div>
                      <div style={{ display: "flex", gap: "4px", alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditQtyItem({ id: item.id, qty: item.quantity });
                          }}
                          title="Edit Quantity"
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "#64748b",
                            padding: "4px",
                            borderRadius: "6px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                            <path d="m15 5 4 4" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setShiftTarget(item);
                          }}
                          title="Shift to Another Consignment"
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "#64748b",
                            padding: "4px",
                            borderRadius: "6px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M16 3h5v5" />
                            <path d="M4 20L21 3" />
                            <path d="M21 16v5h-5" />
                            <path d="M15 15l6 6" />
                            <path d="M4 4l5 5" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRemarksTarget(item);
                          }}
                          title="Procurement Remarks"
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "#64748b",
                            padding: "4px",
                            borderRadius: "6px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteItem(item);
                          }}
                          title="Delete Product Item"
                          style={{
                            background: "transparent",
                            border: "none",
                            cursor: "pointer",
                            color: "#ef4444",
                            padding: "4px",
                            borderRadius: "6px",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M3 6h18" />
                            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                          </svg>
                        </button>
                      </div>
                    </div>

                    {/* Quotation Counter & Status */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #f1f5f9", paddingTop: "6px", fontSize: "12px" }}>
                      <span style={{ color: "#64748b" }}>
                        {item.quotation_count || 0} Quotation Received
                      </span>
                      <span style={{ fontWeight: 700, color: isApproved ? "#2563eb" : "#ea580c" }}>
                        {statusLabel(item.status)}
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* ================= RIGHT COLUMN: PRODUCT DETAILS & QUOTATIONS (DETAIL) ================= */}
        <div
          style={{
            background: "#ffffff",
            borderRadius: "12px",
            border: "1px solid #e2e8f0",
            padding: "20px",
            boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
            display: "flex",
            flexDirection: "column",
            gap: "18px",
            minHeight: "calc(100vh - 210px)",
            minWidth: 0,
            overflow: "hidden",
          }}
        >
          {/* Tabs row: Quotation / Messages */}
          <div style={{ display: "flex", borderBottom: "1px solid #e2e8f0", gap: "24px" }}>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 700,
                color: "#2563eb",
                paddingBottom: "10px",
                borderBottom: "2px solid #2563eb",
                cursor: "pointer",
              }}
            >
              Quotation
            </div>
            <div
              style={{
                fontSize: "14px",
                fontWeight: 500,
                color: "#64748b",
                paddingBottom: "10px",
                cursor: "pointer",
              }}
            >
              Messages (1)
            </div>
          </div>

          {selectedItem ? (
            <>
              {/* Product Header & Action Buttons */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                <div>
                  <h2 style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a", margin: 0 }}>
                    {selectedItem.product_name || selectedItem.product_name_tally || productNames[selectedItem.product_id]}
                  </h2>
                  <div style={{ fontSize: "13px", color: "#64748b", marginTop: "3px" }}>
                    #{selectedItem.product_code || "PC1093W40"}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <button
                    type="button"
                    onClick={() => setRfqOpen(true)}
                    style={{
                      background: "#fffbeb",
                      border: "1.5px solid #f59e0b",
                      color: "#b45309",
                      padding: "8px 16px",
                      borderRadius: "8px",
                      fontSize: "13px",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 1px 2px rgba(245,158,11,0.1)",
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    Request Quotation
                  </button>

                  <button
                    type="button"
                    onClick={() => setAddQuoteOpen(true)}
                    style={{
                      background: "#eff6ff",
                      border: "1.5px solid #3b82f6",
                      color: "#1d4ed8",
                      padding: "8px 16px",
                      borderRadius: "8px",
                      fontSize: "13px",
                      fontWeight: 600,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "6px",
                      boxShadow: "0 1px 2px rgba(59,130,246,0.1)",
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19" />
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                    Add Quotation
                  </button>
                </div>
              </div>

              {/* Product Specs Strip */}
              <div
                style={{
                  display: "flex",
                  gap: "36px",
                  background: "#f8fafc",
                  padding: "12px 18px",
                  borderRadius: "8px",
                  border: "1px solid #f1f5f9",
                  flexWrap: "wrap",
                }}
              >
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                    {selectedItem.packaging_quantity || 10}
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Pkg. Qty.</div>
                </div>
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                    {selectedItem.packaging_gross_weight || 20} KG
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Pkg. Unit Weight</div>
                </div>
                <div>
                  <div style={{ fontSize: "14px", fontWeight: 700, color: "#0f172a" }}>
                    {selectedItem.packaging_unit_cbm || 3.5} CBM
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Pkg. Unit CBM</div>
                </div>
              </div>

              {/* Quotations Table Toolbar */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                  <select
                    style={{
                      padding: "6px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      color: "#334155",
                    }}
                  >
                    <option value="10">10 items</option>
                    <option value="25">25 items</option>
                    <option value="50">50 items</option>
                  </select>

                  <select
                    value={quotationSupplierFilter}
                    onChange={(e) => setQuotationSupplierFilter(e.target.value)}
                    style={{
                      padding: "6px 10px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      color: "#334155",
                    }}
                  >
                    <option value="">All Suppliers</option>
                    {quotationSuppliers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>

                <div style={{ position: "relative", width: "240px", maxWidth: "100%" }}>
                  <span style={{ position: "absolute", left: "10px", top: "7px", color: "#94a3b8", fontSize: "13px" }}>🔍</span>
                  <input
                    type="text"
                    placeholder="Search here..."
                    value={quotationSearch}
                    onChange={(e) => setQuotationSearch(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "6px 10px 6px 30px",
                      borderRadius: "6px",
                      border: "1px solid #cbd5e1",
                      fontSize: "13px",
                      outline: "none",
                    }}
                  />
                </div>
              </div>

              {/* Quotations Table */}
              <div style={{ overflowX: "auto", overflowY: "visible", border: "1px solid #e2e8f0", borderRadius: "8px", flex: 1, minHeight: "420px", display: "flex", flexDirection: "column", width: "100%", maxWidth: "100%" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "750px", fontSize: "13px" }}>
                  <thead>
                    <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                      <th style={thStyle}>QT. No.</th>
                      <th style={thStyle}>Supplier</th>
                      <th style={thStyle}>Quantity</th>
                      <th style={thStyle}>Unit Price</th>
                      <th style={thStyle}>Total Cost</th>
                      <th style={thStyle}>Exp. Receiving</th>
                      <th style={thStyle}>T&C</th>
                      <th style={thStyle}>Status</th>
                      <th style={{ ...thStyle, textAlign: "right" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingQuotes ? (
                      <InquiriesItemsSkeletonRows count={3} />
                    ) : filteredQuotations.length === 0 ? (
                      <tr>
                        <td colSpan={9} style={{ padding: "48px 16px", textAlign: "center", color: "#94a3b8" }}>
                          <div style={{ fontSize: "14px", fontWeight: 600, color: "#64748b", marginBottom: "6px" }}>
                            No quotations received yet
                          </div>
                          <div style={{ fontSize: "12.5px" }}>
                            Click <strong style={{ color: "#3b82f6" }}>+ Add Quotation</strong> to record a supplier's quote or <strong style={{ color: "#d97706" }}>⚡ Request Quotation</strong> to dispatch an RFQ.
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredQuotations.map((quote) => {
                        const usdAmount = Number((quote.total_cost / 7.25).toFixed(2)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        const isQuoteApproved = quote.status === "approved";
                        const isActionOpen = activeActionMenuId === quote.id;

                        return (
                          <tr key={quote.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                            <td style={{ ...tdStyle, fontWeight: 600, color: "#1e293b" }}>
                              {quote.quote_number}
                            </td>
                            <td style={{ ...tdStyle, fontWeight: 600, color: "#0f172a" }}>
                              {quote.supplier_name || "Supplier"}
                            </td>
                            <td style={tdStyle}>{quote.quantity}</td>
                            <td style={{ ...tdStyle, fontWeight: 600 }}>
                              ¥{quote.unit_price}
                            </td>
                            <td style={tdStyle}>
                              <div style={{ fontWeight: 700, color: "#0f172a" }}>
                                ¥{quote.total_cost.toLocaleString()}
                              </div>
                              <div style={{ fontSize: "11px", color: "#2563eb" }}>
                                ${usdAmount} <span style={{ color: "#94a3b8" }}>Inclusive Tax</span>
                              </div>
                            </td>
                            <td style={tdStyle}>
                              {quote.expected_receiving_date || "—"}
                            </td>
                            <td style={tdStyle}>
                              <button
                                type="button"
                                onClick={() => setViewTermsTarget(quote)}
                                style={{
                                  background: "none",
                                  border: "none",
                                  color: "#0284c7",
                                  fontSize: "12.5px",
                                  fontWeight: 600,
                                  cursor: "pointer",
                                  display: "flex",
                                  alignItems: "center",
                                  gap: "4px",
                                }}
                              >
                                👁️ View
                              </button>
                            </td>
                            <td style={tdStyle}>
                              <span
                                style={{
                                  padding: "3px 10px",
                                  borderRadius: "12px",
                                  fontSize: "11.5px",
                                  fontWeight: 600,
                                  background: isQuoteApproved ? "#dcfce7" : quote.status === "rejected" ? "#fee2e2" : "#fef3c7",
                                  color: isQuoteApproved ? "#15803d" : quote.status === "rejected" ? "#b91c1c" : "#b45309",
                                  border: `1px solid ${isQuoteApproved ? "#bbf7d0" : quote.status === "rejected" ? "#fca5a5" : "#fde68a"
                                    }`,
                                }}
                              >
                                {statusLabel(quote.status)}
                              </span>
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right", position: "relative" }}>
                              <button
                                type="button"
                                onClick={() => setActiveActionMenuId(isActionOpen ? null : quote.id)}
                                style={{
                                  background: isActionOpen ? "#e2e8f0" : "#f8fafc",
                                  border: "1px solid #cbd5e1",
                                  borderRadius: "6px",
                                  padding: "4px 8px",
                                  cursor: "pointer",
                                  fontSize: "14px",
                                  transition: "all 0.15s ease",
                                }}
                              >
                                ⋮
                              </button>

                              {/* Click-away backdrop to close menu when clicking anywhere */}
                              {isActionOpen && (
                                <>
                                  <div
                                    style={{
                                      position: "fixed",
                                      inset: 0,
                                      zIndex: 998,
                                      background: "transparent",
                                    }}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setActiveActionMenuId(null);
                                    }}
                                  />
                                  <div
                                    style={{
                                      position: "absolute",
                                      right: "0px",
                                      top: "34px",
                                      background: "#ffffff",
                                      borderRadius: "10px",
                                      boxShadow: "0 10px 30px -5px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(0, 0, 0, 0.06)",
                                      zIndex: 999,
                                      width: "155px",
                                      display: "flex",
                                      flexDirection: "column",
                                      padding: "6px",
                                      gap: "2px",
                                      textAlign: "left",
                                      animation: "fadeIn 0.12s ease-out",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setViewTermsTarget(quote);
                                        setActiveActionMenuId(null);
                                      }}
                                      style={{
                                        padding: "8px 12px",
                                        background: "none",
                                        border: "none",
                                        borderRadius: "6px",
                                        textAlign: "left",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        color: "#334155",
                                        fontWeight: 500,
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                      }}
                                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f1f5f9")}
                                      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                                    >
                                      👁️ View Quote
                                    </button>
                                    {quote.status !== "approved" && (
                                      <button
                                        type="button"
                                        onClick={() => handleApproveQuote(quote)}
                                        style={{
                                          padding: "8px 12px",
                                          background: "none",
                                          border: "none",
                                          borderRadius: "6px",
                                          textAlign: "left",
                                          fontSize: "13px",
                                          cursor: "pointer",
                                          color: "#16a34a",
                                          fontWeight: 600,
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "8px",
                                        }}
                                        onMouseEnter={(e) => (e.currentTarget.style.background = "#f0fdf4")}
                                        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                                      >
                                        ✓ Approve
                                      </button>
                                    )}
                                    {quote.status !== "rejected" && (
                                      <button
                                        type="button"
                                        onClick={() => handleRejectQuote(quote)}
                                        style={{
                                          padding: "8px 12px",
                                          background: "none",
                                          border: "none",
                                          borderRadius: "6px",
                                          textAlign: "left",
                                          fontSize: "13px",
                                          cursor: "pointer",
                                          color: "#dc2626",
                                          fontWeight: 500,
                                          display: "flex",
                                          alignItems: "center",
                                          gap: "8px",
                                        }}
                                        onMouseEnter={(e) => (e.currentTarget.style.background = "#fef2f2")}
                                        onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                                      >
                                        ✕ Reject
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        alert(`Create PO initiated for quote ${quote.quote_number}`);
                                        setActiveActionMenuId(null);
                                      }}
                                      style={{
                                        padding: "8px 12px",
                                        background: "none",
                                        border: "none",
                                        borderRadius: "6px",
                                        textAlign: "left",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        color: "#2563eb",
                                        fontWeight: 600,
                                        borderTop: "1px solid #f1f5f9",
                                        marginTop: "4px",
                                        paddingTop: "8px",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                      }}
                                      onMouseEnter={(e) => (e.currentTarget.style.background = "#eff6ff")}
                                      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                                    >
                                      📄 Create PO
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteQuote(quote)}
                                      style={{
                                        padding: "8px 12px",
                                        background: "none",
                                        border: "none",
                                        borderRadius: "6px",
                                        textAlign: "left",
                                        fontSize: "13px",
                                        cursor: "pointer",
                                        color: "#dc2626",
                                        fontWeight: 600,
                                        borderTop: "1px solid #f1f5f9",
                                        marginTop: "2px",
                                        paddingTop: "8px",
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                      }}
                                      onMouseEnter={(e) => (e.currentTarget.style.background = "#fef2f2")}
                                      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                                    >
                                      🗑️ Delete Quote
                                    </button>
                                  </div>
                                </>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div style={{ padding: "40px 20px", textAlign: "center", color: "#94a3b8" }}>
              Please select a product from the left list to view its quotations.
            </div>
          )}
        </div>
      </div>

      {/* ---------------- DRAWERS & MODALS ---------------- */}

      {/* 1. Add Quotation Drawer (Image 4) */}
      {addQuoteOpen && selectedItem && (
        <AddQuotationDrawer
          item={selectedItem}
          onClose={() => setAddQuoteOpen(false)}
          onCreated={() => {
            setAddQuoteOpen(false);
            if (selectedItem.id) void loadQuotations(selectedItem.id);
            void load();
          }}
          onError={onError}
        />
      )}

      {/* 2. Request Quotation Drawer (Image 5) */}
      {rfqOpen && selectedItem && (
        <RequestQuotationDrawer
          item={selectedItem}
          onClose={() => setRfqOpen(false)}
          onDispatched={() => {
            setRfqOpen(false);
            void load();
          }}
          onError={onError}
        />
      )}

      {/* 3. View Terms & Quotation Modal */}
      {viewTermsTarget && (
        <QuotationTermsModal quote={viewTermsTarget} onClose={() => setViewTermsTarget(null)} />
      )}

      {/* 4. Product Info Modal */}
      {productInfoTarget && (
        <ProductInfoModal item={productInfoTarget} onClose={() => setProductInfoTarget(null)} />
      )}

      {/* 5. Add Product Line Item Modal */}
      {addOpen && (
        <AddItemModal
          defaultBuyerId={inquiry?.buyer_id || buyerId}
          defaultConsignmentCodeId={inquiry?.consignment_code_id}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            setAddOpen(false);
            void load();
          }}
          onError={onError}
        />
      )}

      {/* 6. Edit Qty Inline Modal */}
      {editQtyItem && (
        <div style={{ position: "fixed", inset: 0, zIndex: 100020, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.4)" }} onClick={() => setEditQtyItem(null)} />
          <div style={{ position: "relative", width: "320px", background: "#ffffff", borderRadius: "10px", padding: "20px", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
            <h4 style={{ margin: "0 0 12px 0", fontSize: "15px", color: "#0f172a" }}>Edit Product Quantity</h4>
            <input
              type="number"
              min={0.01}
              step="any"
              value={editQtyItem.qty}
              onChange={(e) => setEditQtyItem({ ...editQtyItem, qty: parseFloat(e.target.value) || 0 })}
              style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "14px", marginBottom: "14px" }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}>
              <button type="button" onClick={() => setEditQtyItem(null)} className="btn btn-secondary" style={{ padding: "6px 12px", fontSize: "12.5px" }}>Cancel</button>
              <button
                type="button"
                onClick={() => {
                  const itm = items.find((x) => x.id === editQtyItem.id);
                  if (itm) handleQuantitySave(itm, editQtyItem.qty);
                }}
                className="btn btn-primary"
                style={{ padding: "6px 14px", fontSize: "12.5px" }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 7. Shift Item Modal */}
      {shiftTarget && (
        <ShiftItemModal
          buyerId={buyerId}
          item={shiftTarget}
          onClose={() => setShiftTarget(null)}
          onShifted={() => {
            setShiftTarget(null);
            void load();
          }}
          onError={onError}
        />
      )}

      {/* 8. Procurement Remarks Modal */}
      {remarksTarget && (
        <ProcurementRemarksModal
          inquiryId={inquiryId}
          item={remarksTarget}
          onClose={() => setRemarksTarget(null)}
          onSaved={() => {
            setRemarksTarget(null);
            void load();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Drawers & Sub-Modals for Quotations & RFQs                          */
/* ------------------------------------------------------------------ */

function AddQuotationDrawer({
  item,
  onClose,
  onCreated,
  onError,
}: {
  item: InquiryItem;
  onClose: () => void;
  onCreated: () => void;
  onError: (err: unknown) => void;
}) {
  const [supplierId, setSupplierId] = useState("");
  const [quantity, setQuantity] = useState(String(item.quantity || 100));
  const [unitPrice, setUnitPrice] = useState("");
  const [totalCost, setTotalCost] = useState("");
  const [expDate, setExpDate] = useState("");
  const [terms, setTerms] = useState("");
  const [remark, setRemark] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [productMeta, setProductMeta] = useState<{
    categoryId?: string;
    categoryName?: string;
    subCategoryId?: string;
    subCategoryName?: string;
  } | null>(null);
  const [supplierFilterScope, setSupplierFilterScope] = useState<"sub_category" | "category" | "all">("sub_category");

  useEffect(() => {
    if (!item.product_id) return;
    let isMounted = true;
    (async () => {
      try {
        const { data: prod } = await apiGet<any>(`/masters/products/${item.product_id}`);
        if (!prod || !isMounted) return;

        let catName = "";
        let subCatName = "";

        if (prod.category_id) {
          try {
            const { data: cat } = await apiGet<any>(`/masters/product-categories/${prod.category_id}`);
            catName = cat?.name || "";
          } catch {
            /* ignore */
          }
        }

        if (prod.sub_category_id) {
          try {
            const { data: subCat } = await apiGet<any>(`/masters/product-sub-categories/${prod.sub_category_id}`);
            subCatName = subCat?.name || "";
          } catch {
            /* ignore */
          }
        }

        if (!isMounted) return;
        setProductMeta({
          categoryId: prod.category_id || undefined,
          categoryName: catName,
          subCategoryId: prod.sub_category_id || undefined,
          subCategoryName: subCatName,
        });

        if (prod.sub_category_id) {
          setSupplierFilterScope("sub_category");
        } else if (prod.category_id) {
          setSupplierFilterScope("category");
        } else {
          setSupplierFilterScope("all");
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [item.product_id]);

  // Auto calculate total cost when qty or unit price changes
  const handleUnitPriceChange = (val: string) => {
    setUnitPrice(val);
    const q = parseFloat(quantity);
    const u = parseFloat(val);
    if (!isNaN(q) && !isNaN(u)) {
      setTotalCost((q * u).toFixed(2));
    }
  };

  const fetchSuppliers = useCallback(
    async (term: string) => {
      try {
        let url = `/suppliers?search=${encodeURIComponent(term)}&limit=100&sort_by=company_name&sort_order=asc`;
        if (supplierFilterScope === "sub_category" && productMeta?.subCategoryId) {
          url += `&sub_category_id=${productMeta.subCategoryId}`;
        } else if (supplierFilterScope === "category" && productMeta?.categoryId) {
          url += `&category_id=${productMeta.categoryId}`;
        }
        const res = await apiGet<any>(url);
        const list = Array.isArray(res.data) ? res.data : res.data?.data || [];
        return list.map((s: any) => ({ value: s.id, label: s.company_name || s.name || "Supplier" }));
      } catch {
        return [];
      }
    },
    [supplierFilterScope, productMeta]
  );

  const fetchSupplierLabel = useCallback(async (id: string) => {
    try {
      const res = await apiGet<any>(`/suppliers/${id}`);
      return res.data?.company_name || res.data?.name || id;
    } catch {
      return id;
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!supplierId) errs.supplier = "Supplier is required";
    if (!unitPrice || parseFloat(unitPrice) <= 0) errs.unitPrice = "Valid unit price is required";
    if (!totalCost || parseFloat(totalCost) <= 0) errs.totalCost = "Total cost is required";

    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setSubmitting(true);
    try {
      await apiPost(`/inquiries/items/${item.id}/quotations`, {
        supplier_id: supplierId,
        quantity: parseFloat(quantity) || item.quantity,
        unit_price: parseFloat(unitPrice),
        total_cost: parseFloat(totalCost),
        currency: "CNY",
        expected_receiving_date: expDate || null,
        terms_and_conditions: terms.trim() || null,
        remarks: remark.trim() || null,
      });
      onCreated();
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100010, display: "flex", justifyContent: "flex-end" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(2px)" }} onClick={onClose} />
      <div
        style={{
          position: "relative",
          width: "480px",
          maxWidth: "92vw",
          height: "100%",
          background: "#ffffff",
          boxShadow: "-10px 0 30px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px", borderBottom: "1px solid #e2e8f0" }}>
          <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0f172a" }}>Add Quotation</h3>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        {/* Content */}
        <form onSubmit={handleSubmit} style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", flex: 1 }}>
          {/* Selected Product Card */}
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "6px" }}>Products</label>
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                  {item.product_name || item.product_name_tally}
                </div>
                <div style={{ fontSize: "12px", color: "#64748b" }}>
                  #{item.product_code || "PC10956df"}
                  {productMeta?.subCategoryName && ` • ${productMeta.subCategoryName}`}
                  {!productMeta?.subCategoryName && productMeta?.categoryName && ` • ${productMeta.categoryName}`}
                </div>
              </div>
              <div style={{ fontSize: "13px", fontWeight: 600, color: "#334155" }}>
                Qty: {item.quantity}
              </div>
            </div>
          </div>

          {/* Supplier Dropdown */}
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
              <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155" }}>
                Supplier *
              </label>
            </div>

            {/* Filter Pills: Sub-Category / Category / All Suppliers */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
              {productMeta?.subCategoryId && (
                <button
                  type="button"
                  onClick={() => setSupplierFilterScope("sub_category")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "16px",
                    border: "none",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                    background: supplierFilterScope === "sub_category" ? "#0061f2" : "#f1f5f9",
                    color: supplierFilterScope === "sub_category" ? "#ffffff" : "#475569",
                    boxShadow: supplierFilterScope === "sub_category" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                    transition: "all 0.15s ease",
                  }}
                >
                  🎯 Sub-Category: {productMeta.subCategoryName || "Sub-Category"}
                </button>
              )}

              {productMeta?.categoryId && (
                <button
                  type="button"
                  onClick={() => setSupplierFilterScope("category")}
                  style={{
                    padding: "4px 10px",
                    borderRadius: "16px",
                    border: "none",
                    fontSize: "11.5px",
                    fontWeight: 600,
                    cursor: "pointer",
                    background: supplierFilterScope === "category" ? "#0061f2" : "#f1f5f9",
                    color: supplierFilterScope === "category" ? "#ffffff" : "#475569",
                    boxShadow: supplierFilterScope === "category" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                    transition: "all 0.15s ease",
                  }}
                >
                  📁 Category: {productMeta.categoryName || "Category"}
                </button>
              )}

              <button
                type="button"
                onClick={() => setSupplierFilterScope("all")}
                style={{
                  padding: "4px 10px",
                  borderRadius: "16px",
                  border: "none",
                  fontSize: "11.5px",
                  fontWeight: 600,
                  cursor: "pointer",
                  background: supplierFilterScope === "all" ? "#0061f2" : "#f1f5f9",
                  color: supplierFilterScope === "all" ? "#ffffff" : "#475569",
                  boxShadow: supplierFilterScope === "all" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                  transition: "all 0.15s ease",
                }}
              >
                🌐 All Suppliers
              </button>
            </div>

            <SearchableDropdown
              key={`add-quote-sup-${supplierFilterScope}-${productMeta?.subCategoryId || ""}-${productMeta?.categoryId || ""}`}
              value={supplierId || null}
              onChange={(val) => {
                setSupplierId(val || "");
                setErrors((prev) => ({ ...prev, supplier: "" }));
              }}
              fetchOptions={fetchSuppliers}
              fetchLabelForValue={fetchSupplierLabel}
              placeholder={
                supplierFilterScope === "sub_category" && productMeta?.subCategoryName
                  ? `-- Select ${productMeta.subCategoryName} Supplier --`
                  : supplierFilterScope === "category" && productMeta?.categoryName
                    ? `-- Select ${productMeta.categoryName} Supplier --`
                    : "Search or Select Supplier..."
              }
              hasError={Boolean(errors.supplier)}
            />
            {errors.supplier && <div style={{ color: "#ef4444", fontSize: "11.5px", marginTop: "3px" }}>⚠️ {errors.supplier}</div>}
          </div>

          {/* Quantity, Unit Price, Total Cost */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>Quantity</label>
              <input
                type="number"
                min={1}
                value={quantity}
                onChange={(e) => {
                  setQuantity(e.target.value);
                  const q = parseFloat(e.target.value);
                  const u = parseFloat(unitPrice);
                  if (!isNaN(q) && !isNaN(u)) setTotalCost((q * u).toFixed(2));
                }}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>*Unit Price (¥)</label>
              <input
                type="number"
                step="any"
                placeholder="28"
                value={unitPrice}
                onChange={(e) => handleUnitPriceChange(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: errors.unitPrice ? "1.5px solid #ef4444" : "1px solid #cbd5e1", fontSize: "13px" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>*Total Cost (¥)</label>
              <input
                type="number"
                step="any"
                placeholder="300"
                value={totalCost}
                onChange={(e) => setTotalCost(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: errors.totalCost ? "1.5px solid #ef4444" : "1px solid #cbd5e1", fontSize: "13px", fontWeight: 600 }}
              />
            </div>
          </div>

          {/* Expected Receiving Date */}
          <div>
            <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
              *Expected Receiving
            </label>
            <input
              type="date"
              value={expDate}
              onChange={(e) => setExpDate(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
            />
          </div>

          {/* T&C */}
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>T&C</label>
            <textarea
              rows={2}
              placeholder="Enter terms and conditions..."
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px", resize: "vertical" }}
            />
          </div>

          {/* Remark */}
          <div>
            <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>Remark</label>
            <textarea
              rows={2}
              placeholder="Add any internal procurement remarks..."
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px", resize: "vertical" }}
            />
          </div>

          {/* Submit Button */}
          <div style={{ marginTop: "auto", paddingTop: "16px" }}>
            <button
              type="submit"
              disabled={submitting}
              style={{
                width: "100%",
                padding: "10px",
                background: "#2563eb",
                color: "#ffffff",
                border: "none",
                borderRadius: "8px",
                fontSize: "14px",
                fontWeight: 700,
                cursor: submitting ? "not-allowed" : "pointer",
                boxShadow: "0 2px 6px rgba(37,99,235,0.25)",
              }}
            >
              {submitting ? "Submitting..." : "Submit"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function RequestQuotationDrawer({
  item,
  onClose,
  onDispatched,
  onError,
}: {
  item: InquiryItem;
  onClose: () => void;
  onDispatched: () => void;
  onError: (err: unknown) => void;
}) {
  const [expDate, setExpDate] = useState("");
  const [supplierType, setSupplierType] = useState<"all" | "selected">("selected");
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dispatchedData, setDispatchedData] = useState<any | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [copiedWechatToken, setCopiedWechatToken] = useState<string | null>(null);
  const [sendingEmailToken, setSendingEmailToken] = useState<string | null>(null);
  const [sentEmailSuccess, setSentEmailSuccess] = useState<Record<string, boolean>>({});

  const handleSendAutoEmail = async (sup: any, fullQuoteUrl: string, prodTitle: string) => {
    const emailsList = (sup.emails && Array.isArray(sup.emails) && sup.emails.length > 0)
      ? sup.emails
      : sup.email
        ? [sup.email]
        : [];

    if (emailsList.length === 0) {
      alert(`No email address registered for ${sup.company_name}. Please open Gmail or copy the link.`);
      return;
    }

    setSendingEmailToken(sup.token);
    try {
      await apiPost("/inquiries/rfqs/send-email", {
        to_emails: emailsList,
        contact_name: sup.contact_name || "Valued Partner",
        company_name: sup.company_name,
        product_name: prodTitle,
        product_code: item.product_code || null,
        quantity: item.quantity,
        quote_url: fullQuoteUrl,
        expected_receiving_date: expDate || null,
        notes: note.trim() || null,
      });
      setSentEmailSuccess((prev) => ({ ...prev, [sup.token]: true }));
    } catch (err: any) {
      alert("Failed to send automated email: " + (err?.message || "Please check connection."));
    } finally {
      setSendingEmailToken(null);
    }
  };

  const [productMeta, setProductMeta] = useState<{
    categoryId?: string;
    categoryName?: string;
    subCategoryId?: string;
    subCategoryName?: string;
  } | null>(null);
  const [allMatchingSuppliers, setAllMatchingSuppliers] = useState<Array<{ id: string; name: string }>>([]);
  const [supplierFilterScope, setSupplierFilterScope] = useState<"all_matching" | "sub_category" | "category" | "all">("all_matching");

  useEffect(() => {
    if (!item.product_id) return;
    let isMounted = true;
    (async () => {
      try {
        const { data: prod } = await apiGet<any>(`/masters/products/${item.product_id}`);
        if (!prod || !isMounted) return;

        let catName = "";
        let subCatName = "";

        if (prod.category_id) {
          try {
            const { data: cat } = await apiGet<any>(`/masters/product-categories/${prod.category_id}`);
            catName = cat?.name || "";
          } catch {
            /* ignore */
          }
        }

        if (prod.sub_category_id) {
          try {
            const { data: subCat } = await apiGet<any>(`/masters/product-sub-categories/${prod.sub_category_id}`);
            subCatName = subCat?.name || "";
          } catch {
            /* ignore */
          }
        }

        if (!isMounted) return;
        setProductMeta({
          categoryId: prod.category_id || undefined,
          categoryName: catName,
          subCategoryId: prod.sub_category_id || undefined,
          subCategoryName: subCatName,
        });

        // Automatically fetch all matching suppliers for this product to keep in allMatchingSuppliers
        const matchingList: Array<{ id: string; name: string }> = [];
        const seenIds = new Set<string>();
        try {
          if (prod.sub_category_id) {
            const { data: subSups } = await apiGet<any>(`/suppliers?sub_category_id=${prod.sub_category_id}&limit=100`);
            const subList = Array.isArray(subSups) ? subSups : subSups?.data || [];
            subList.forEach((s: any) => {
              if (!seenIds.has(s.id)) {
                seenIds.add(s.id);
                matchingList.push({ id: s.id, name: s.company_name || s.name || "Supplier" });
              }
            });
          }
          if (prod.category_id) {
            const { data: catSups } = await apiGet<any>(`/suppliers?category_id=${prod.category_id}&limit=100`);
            const catList = Array.isArray(catSups) ? catSups : catSups?.data || [];
            catList.forEach((s: any) => {
              if (!seenIds.has(s.id)) {
                seenIds.add(s.id);
                matchingList.push({ id: s.id, name: s.company_name || s.name || "Supplier" });
              }
            });
          }
          if (matchingList.length === 0) {
            const { data: allSups } = await apiGet<any>(`/suppliers?limit=100`);
            const allList = Array.isArray(allSups) ? allSups : allSups?.data || [];
            allList.forEach((s: any) => {
              if (!seenIds.has(s.id)) {
                seenIds.add(s.id);
                matchingList.push({ id: s.id, name: s.company_name || s.name || "Supplier" });
              }
            });
          }
          if (isMounted) {
            setAllMatchingSuppliers(matchingList);
          }
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      isMounted = false;
    };
  }, [item.product_id]);

  const fetchSupplierOptions = useCallback(
    async (term: string) => {
      try {
        if (supplierFilterScope === "all_matching") {
          const supplierMap = new Map<string, any>();
          if (productMeta?.subCategoryId) {
            const { data: subSups } = await apiGet<any>(`/suppliers?search=${encodeURIComponent(term)}&sub_category_id=${productMeta.subCategoryId}&limit=100`);
            const list = Array.isArray(subSups) ? subSups : subSups?.data || [];
            list.forEach((s: any) => supplierMap.set(s.id, s));
          }
          if (productMeta?.categoryId) {
            const { data: catSups } = await apiGet<any>(`/suppliers?search=${encodeURIComponent(term)}&category_id=${productMeta.categoryId}&limit=100`);
            const list = Array.isArray(catSups) ? catSups : catSups?.data || [];
            list.forEach((s: any) => supplierMap.set(s.id, s));
          }
          if (supplierMap.size === 0) {
            const { data: allSups } = await apiGet<any>(`/suppliers?search=${encodeURIComponent(term)}&limit=100`);
            const list = Array.isArray(allSups) ? allSups : allSups?.data || [];
            list.forEach((s: any) => supplierMap.set(s.id, s));
          }
          return Array.from(supplierMap.values()).map((s: any) => ({
            value: s.id,
            label: s.company_name || s.name || "Supplier",
          }));
        }

        let url = `/suppliers?search=${encodeURIComponent(term)}&limit=100&sort_by=company_name&sort_order=asc`;
        if (supplierFilterScope === "sub_category" && productMeta?.subCategoryId) {
          url += `&sub_category_id=${productMeta.subCategoryId}`;
        } else if (supplierFilterScope === "category" && productMeta?.categoryId) {
          url += `&category_id=${productMeta.categoryId}`;
        }
        const res = await apiGet<any>(url);
        const list = Array.isArray(res.data) ? res.data : res.data?.data || [];
        return list.map((s: any) => ({
          value: s.id,
          label: s.company_name || s.name || "Supplier",
        }));
      } catch {
        return [];
      }
    },
    [supplierFilterScope, productMeta]
  );

  const fetchSupplierLabel = useCallback(async (id: string) => {
    try {
      const res = await apiGet<any>(`/suppliers/${id}`);
      return res.data?.company_name || res.data?.name || id;
    } catch {
      return id;
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (supplierType === "selected" && selectedSupplierIds.length === 0) {
      alert("Please select at least one supplier.");
      return;
    }

    const supplierIdsToSend = supplierType === "all" ? allMatchingSuppliers.map((s) => s.id) : selectedSupplierIds;

    setSubmitting(true);
    try {
      const res = await apiPost<any>(`/inquiries/items/${item.id}/rfqs`, {
        expected_receiving_date: expDate || null,
        supplier_type: supplierType,
        supplier_ids: supplierIdsToSend,
        notes: note.trim() || null,
      });

      if (res.data && res.data.supplier_links && res.data.supplier_links.length > 0) {
        // The backend now automatically dispatches emails in the background
        // to every supplier link that has an email address (see
        // app.inquiries.routes.create_item_rfq), so pre-mark those as
        // already sent -- otherwise this dialog would show "⚡ Send Email"
        // as still available/unsent for suppliers who were already
        // emailed automatically, inviting a confusing duplicate send.
        const initialSent: Record<string, boolean> = {};
        res.data.supplier_links.forEach((l: any) => {
          if ((l.emails && l.emails.length > 0) || l.email) {
            initialSent[l.token] = true;
          }
        });
        setSentEmailSuccess(initialSent);
        setDispatchedData(res.data);
      } else {
        alert("Request for Quotation successfully sent to suppliers!");
        onDispatched();
      }
    } catch (err) {
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const [loadingLastPurchase, setLoadingLastPurchase] = useState(false);

  const handleViewLastPurchase = async () => {
    if (!item.product_id) {
      alert("No product ID available for this item.");
      return;
    }
    setLoadingLastPurchase(true);
    try {
      const res = await apiGet<any>(`/inquiries/products/${item.product_id}/last-purchase`);
      const data = res.data;
      if (data) {
        alert(
          `Last Purchase / Quotation Record:\n\n` +
          `• Product: ${item.product_name || item.product_name_tally || "Product"}\n` +
          `• Supplier: ${data.supplier_name}\n` +
          `• Quantity: ${data.quantity} units\n` +
          `• Unit Price: ¥${data.unit_price}\n` +
          `• Total Cost: ¥${data.total_cost.toLocaleString()} (${data.currency || "CNY"})\n` +
          `• Quote / Order No: ${data.quote_number || "N/A"}\n` +
          `• Date: ${data.date || "N/A"}\n` +
          `• Status: ${data.status}`
        );
      } else {
        alert(`No previous purchase or quotation records found for "${item.product_name || item.product_name_tally || "this product"}" yet.`);
      }
    } catch {
      alert("Could not retrieve previous purchase records for this product.");
    } finally {
      setLoadingLastPurchase(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100010, display: "flex", justifyContent: "flex-end" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(2px)" }} onClick={onClose} />
      <div
        style={{
          position: "relative",
          width: "520px",
          maxWidth: "94vw",
          height: "100%",
          background: "#ffffff",
          boxShadow: "-10px 0 30px rgba(0,0,0,0.15)",
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px", borderBottom: "1px solid #e2e8f0" }}>
          <h3 style={{ margin: 0, fontSize: "17px", fontWeight: 700, color: "#0f172a" }}>
            {dispatchedData ? "⚡ RFQ Share & Dispatch" : "Request For Quotation"}
          </h3>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        {/* If already dispatched, show interactive Share Links modal */}
        {dispatchedData ? (
          <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", flex: 1 }}>
            <div style={{ background: "#ecfdf5", border: "1px solid #a7f3d0", padding: "14px 16px", borderRadius: "10px" }}>
              <div style={{ fontSize: "14px", fontWeight: 700, color: "#065f46", display: "flex", alignItems: "center", gap: "6px" }}>
                <span>✓</span> RFQ Created Successfully!
              </div>
              <div style={{ fontSize: "12.5px", color: "#047857", marginTop: "4px" }}>
                Send the private quotation link to each supplier. When they submit their quote, it will automatically appear in your ERP Quotations Table.
              </div>
            </div>

            {/* Product Summary */}
            <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px" }}>
              <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                {item.product_name || item.product_name_tally}
              </div>
              <div style={{ fontSize: "12px", color: "#64748b" }}>
                Qty: <strong>{item.quantity} units</strong> {expDate && `• Expected By: ${expDate}`}
              </div>
            </div>

            {/* List of Supplier Links */}
            <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <label style={{ fontSize: "12.5px", fontWeight: 700, color: "#334155" }}>
                Supplier Quotation Links ({dispatchedData.supplier_links?.length || 0})
              </label>

              {dispatchedData.supplier_links?.map((sup: any) => {
                const host = window.location.hostname;
                const isLocal = host === "localhost" || host === "127.0.0.1";
                const baseOrigin = isLocal ? `${window.location.protocol}//192.168.1.23:${window.location.port}` : window.location.origin;
                const fullQuoteUrl = `${baseOrigin}${sup.quote_path}`;
                const prodTitle = item.product_name || item.product_name_tally || "Product";
                const waText = `Hello ${sup.contact_name},\n\nWe have an RFQ for ${item.quantity} units of *${prodTitle}* (#${item.product_code || "PC"}).\n\nPlease submit your best quotation with price and lead time using this link:\n\n${fullQuoteUrl}\n\nThank you!\nfrom Yinglima`;
                const waUrl = sup.clean_phone
                  ? `https://api.whatsapp.com/send?phone=${sup.clean_phone}&text=${encodeURIComponent(waText)}`
                  : `https://api.whatsapp.com/send?text=${encodeURIComponent(waText)}`;
                const supEmail = (
                  typeof sup.email === "string" && sup.email
                    ? sup.email
                    : Array.isArray(sup.emails)
                      ? sup.emails.map((e: any) => (typeof e === "string" ? e : e?.email || "")).filter(Boolean).join(", ")
                      : ""
                );
                const emailSubject = `Request for Quotation: ${prodTitle} (${item.quantity} units)`;
                const emailBody = `Dear ${sup.contact_name},\n\nPlease review our inquiry for ${item.quantity} units of ${prodTitle}.\n\nYou can view specifications and submit your quotation using the link below:\n\n${fullQuoteUrl}\n\nBest regards,\nYinglima Procurement Team`;
                const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(supEmail)}&su=${encodeURIComponent(emailSubject)}&body=${encodeURIComponent(emailBody)}`;

                return (
                  <div
                    key={sup.supplier_id}
                    style={{
                      background: "#ffffff",
                      border: "1.5px solid #e2e8f0",
                      borderRadius: "10px",
                      padding: "14px 16px",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.03)",
                      display: "flex",
                      flexDirection: "column",
                      gap: "10px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                        🏢 {sup.company_name}
                      </div>
                      <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                        Contact: {sup.contact_name} {sup.phone ? `• 📞 ${sup.phone}` : ""} {supEmail ? `• ✉️ ${supEmail}` : ""}
                      </div>
                    </div>

                    {/* Action Buttons Row */}
                    <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                      {/* 1-Click Instant Auto-Email Button */}
                      <button
                        type="button"
                        disabled={sendingEmailToken === sup.token}
                        onClick={() => void handleSendAutoEmail(sup, fullQuoteUrl, prodTitle)}
                        style={{
                          padding: "7px 14px",
                          background: sentEmailSuccess[sup.token] ? "#059669" : "#0061f2",
                          color: "#ffffff",
                          border: "none",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 700,
                          cursor: sendingEmailToken === sup.token ? "wait" : "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          boxShadow: "0 2px 5px rgba(0,97,242,0.25)",
                        }}
                      >
                        {sendingEmailToken === sup.token ? (
                          <><span>⏳</span> Sending Email...</>
                        ) : sentEmailSuccess[sup.token] ? (
                          <><span>✓</span> Email Sent!</>
                        ) : (
                          <><span>⚡</span> Auto-Send Email</>
                        )}
                      </button>

                      {/* 1-Click Copy for WeChat Button (English) */}
                      <button
                        type="button"
                        onClick={() => {
                          const wechatMsg = `Dear ${sup.contact_name || sup.company_name},\n\nYinglima Procurement Team invites you to submit your quotation for:\n\n• Product: ${prodTitle}${item.product_code ? ` (#${item.product_code})` : ''}\n• Quantity: ${item.quantity} units\n${expDate ? `• Required Date: ${expDate}\n` : ''}${note.trim() ? `• Notes: ${note.trim()}\n` : ''}\nPlease click the link below to view specifications and submit your quotation:\n👉 ${fullQuoteUrl}\n\nThank you!\n(Yinglima Procurement Team)`;
                          navigator.clipboard.writeText(wechatMsg);
                          setCopiedWechatToken(sup.token);
                          setTimeout(() => setCopiedWechatToken(null), 3000);
                        }}
                        style={{
                          padding: "7px 12px",
                          background: copiedWechatToken === sup.token ? "#dcfce7" : "#07c160",
                          color: copiedWechatToken === sup.token ? "#15803d" : "#ffffff",
                          border: copiedWechatToken === sup.token ? "1px solid #86efac" : "none",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 700,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          boxShadow: "0 2px 4px rgba(7,193,96,0.25)",
                        }}
                        title="Copy pre-formatted inquiry message with quote link to paste into WeChat"
                      >
                        <span>💬</span>
                        {copiedWechatToken === sup.token ? "✓ Message Copied!" : "WeChat Message"}
                      </button>

                      {/* WhatsApp Button */}
                      <a
                        href={waUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: "7px 12px",
                          background: "#25D366",
                          color: "#ffffff",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 700,
                          textDecoration: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                          boxShadow: "0 2px 4px rgba(37,211,102,0.2)",
                        }}
                      >
                        <span>💬</span> Send on WhatsApp
                      </a>

                      {/* Gmail Button */}
                      <a
                        href={gmailUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding: "7px 12px",
                          background: "#fef2f2",
                          color: "#dc2626",
                          border: "1px solid #fecaca",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 600,
                          textDecoration: "none",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                        title="Open in Gmail Web to review or edit before sending"
                      >
                        <span>✉️</span> Gmail Web
                      </a>

                      {/* Copy Link Button */}
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(fullQuoteUrl);
                          setCopiedToken(sup.token);
                          setTimeout(() => setCopiedToken(null), 2500);
                        }}
                        style={{
                          padding: "7px 12px",
                          background: copiedToken === sup.token ? "#dcfce7" : "#f8fafc",
                          color: copiedToken === sup.token ? "#15803d" : "#334155",
                          border: copiedToken === sup.token ? "1px solid #86efac" : "1px solid #cbd5e1",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: 600,
                          cursor: "pointer",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "6px",
                        }}
                      >
                        <span>{copiedToken === sup.token ? "✓" : "📋"}</span>
                        {copiedToken === sup.token ? "✓ Link Copied!" : "Copy Link"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Done & View Quotations Button */}
            <div style={{ marginTop: "auto", paddingTop: "16px" }}>
              <button
                type="button"
                onClick={() => {
                  onDispatched();
                  onClose();
                }}
                style={{
                  width: "100%",
                  padding: "10px",
                  background: "#0061f2",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: "pointer",
                  boxShadow: "0 2px 6px rgba(0,97,242,0.25)",
                }}
              >
                Done &amp; View Quotations Table
              </button>
            </div>
          </div>
        ) : (
          /* Initial RFQ Creation Form */
          <form onSubmit={handleSubmit} style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", flex: 1 }}>
            {/* Selected Product Card */}
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "6px" }}>Product</label>
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: "13.5px", fontWeight: 700, color: "#0f172a" }}>
                    {item.product_name || item.product_name_tally}
                  </div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>
                    #{item.product_code || "PC10956df"}
                    {productMeta?.subCategoryName && ` • ${productMeta.subCategoryName}`}
                    {!productMeta?.subCategoryName && productMeta?.categoryName && ` • ${productMeta.categoryName}`}
                  </div>
                </div>
                <div style={{ fontSize: "13px", fontWeight: 600, color: "#334155" }}>
                  Qty: {item.quantity}
                </div>
              </div>
              <div style={{ textAlign: "right", marginTop: "4px" }}>
                <button
                  type="button"
                  onClick={handleViewLastPurchase}
                  disabled={loadingLastPurchase}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#2563eb",
                    fontSize: "12px",
                    cursor: loadingLastPurchase ? "wait" : "pointer",
                    textDecoration: "underline",
                  }}
                >
                  {loadingLastPurchase ? "Fetching..." : "View Last Purchase"}
                </button>
              </div>
            </div>

            {/* Expected Receiving Date */}
            <div>
              <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                *Expected Receiving
              </label>
              <input
                type="date"
                value={expDate}
                onChange={(e) => setExpDate(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px" }}
              />
            </div>

            {/* Suppliers Type Radio */}
            <div>
              <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "6px" }}>
                *Suppliers Type
              </label>
              <div style={{ display: "flex", gap: "20px" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer", fontWeight: supplierType === "all" ? 600 : 400 }}>
                  <input
                    type="radio"
                    name="supplierType"
                    value="all"
                    checked={supplierType === "all"}
                    onChange={() => setSupplierType("all")}
                  />
                  All Suppliers (Category &amp; Sub-Category)
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer", fontWeight: supplierType === "selected" ? 600 : 400 }}>
                  <input
                    type="radio"
                    name="supplierType"
                    value="selected"
                    checked={supplierType === "selected"}
                    onChange={() => setSupplierType("selected")}
                  />
                  Selected Suppliers
                </label>
              </div>
            </div>

            {/* When "all" is selected: show preview of all matching suppliers */}
            {supplierType === "all" && (
              <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", padding: "12px 14px", borderRadius: "8px" }}>
                <div style={{ fontSize: "13px", fontWeight: 700, color: "#166534", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>🌟</span> All Matching Suppliers ({allMatchingSuppliers.length})
                </div>
                <div style={{ fontSize: "12px", color: "#15803d", marginTop: "3px" }}>
                  Will automatically dispatch quotation request to all {allMatchingSuppliers.length} supplier(s) matching {productMeta?.subCategoryName ? `Sub-Category "${productMeta.subCategoryName}"` : productMeta?.categoryName ? `Category "${productMeta.categoryName}"` : "this product"}.
                </div>
                {allMatchingSuppliers.length > 0 && (
                  <div style={{ marginTop: "8px", display: "flex", flexWrap: "wrap", gap: "5px" }}>
                    {allMatchingSuppliers.map((s) => (
                      <span key={s.id} style={{ background: "#dcfce7", color: "#166534", border: "1px solid #86efac", padding: "3px 8px", borderRadius: "4px", fontSize: "11.5px", fontWeight: 600 }}>
                        🏢 {s.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Multi-Select Suppliers (if selected) */}
            {supplierType === "selected" && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "6px" }}>
                  <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155" }}>
                    *Select Suppliers ({selectedSupplierIds.length} Selected)
                  </label>
                  <div style={{ display: "flex", gap: "10px" }}>
                    <button
                      type="button"
                      onClick={async () => {
                        const matching = await fetchSupplierOptions("");
                        setSelectedSupplierIds((prev) => {
                          const combined = new Set([...prev, ...matching.map((m: any) => m.value)]);
                          return Array.from(combined);
                        });
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#0061f2",
                        fontSize: "11.5px",
                        fontWeight: 700,
                        cursor: "pointer",
                        textDecoration: "underline",
                      }}
                    >
                      + Select All in List
                    </button>
                    {selectedSupplierIds.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSelectedSupplierIds([])}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#ef4444",
                          fontSize: "11.5px",
                          fontWeight: 600,
                          cursor: "pointer",
                          textDecoration: "underline",
                        }}
                      >
                        Clear All
                      </button>
                    )}
                  </div>
                </div>

                {/* Filter Pills: All Matching / Sub-Category / Category / All Suppliers */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px", alignItems: "center" }}>
                  <button
                    type="button"
                    onClick={() => setSupplierFilterScope("all_matching")}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "16px",
                      border: "none",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      cursor: "pointer",
                      background: supplierFilterScope === "all_matching" ? "#0061f2" : "#f1f5f9",
                      color: supplierFilterScope === "all_matching" ? "#ffffff" : "#475569",
                      boxShadow: supplierFilterScope === "all_matching" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                      transition: "all 0.15s ease",
                    }}
                  >
                    🌟 All Matching
                  </button>

                  {productMeta?.subCategoryId && (
                    <button
                      type="button"
                      onClick={() => setSupplierFilterScope("sub_category")}
                      style={{
                        padding: "4px 10px",
                        borderRadius: "16px",
                        border: "none",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        cursor: "pointer",
                        background: supplierFilterScope === "sub_category" ? "#0061f2" : "#f1f5f9",
                        color: supplierFilterScope === "sub_category" ? "#ffffff" : "#475569",
                        boxShadow: supplierFilterScope === "sub_category" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                        transition: "all 0.15s ease",
                      }}
                    >
                      🎯 Sub-Category: {productMeta.subCategoryName || "Sub-Category"}
                    </button>
                  )}

                  {productMeta?.categoryId && (
                    <button
                      type="button"
                      onClick={() => setSupplierFilterScope("category")}
                      style={{
                        padding: "4px 10px",
                        borderRadius: "16px",
                        border: "none",
                        fontSize: "11.5px",
                        fontWeight: 600,
                        cursor: "pointer",
                        background: supplierFilterScope === "category" ? "#0061f2" : "#f1f5f9",
                        color: supplierFilterScope === "category" ? "#ffffff" : "#475569",
                        boxShadow: supplierFilterScope === "category" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                        transition: "all 0.15s ease",
                      }}
                    >
                      📁 Category: {productMeta.categoryName || "Category"}
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setSupplierFilterScope("all")}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "16px",
                      border: "none",
                      fontSize: "11.5px",
                      fontWeight: 600,
                      cursor: "pointer",
                      background: supplierFilterScope === "all" ? "#0061f2" : "#f1f5f9",
                      color: supplierFilterScope === "all" ? "#ffffff" : "#475569",
                      boxShadow: supplierFilterScope === "all" ? "0 2px 4px rgba(0,97,242,0.25)" : "none",
                      transition: "all 0.15s ease",
                    }}
                  >
                    🌐 All Suppliers
                  </button>
                </div>

                <SearchableDropdownMultiPanel
                  key={`rfq-sup-${supplierFilterScope}-${productMeta?.subCategoryId || ""}-${productMeta?.categoryId || ""}`}
                  values={selectedSupplierIds}
                  onChange={setSelectedSupplierIds}
                  placeholder={
                    supplierFilterScope === "all_matching"
                      ? "-- Select or search matching suppliers --"
                      : supplierFilterScope === "sub_category" && productMeta?.subCategoryName
                        ? `-- Select ${productMeta.subCategoryName} Suppliers --`
                        : supplierFilterScope === "category" && productMeta?.categoryName
                          ? `-- Select ${productMeta.categoryName} Suppliers --`
                          : "-- Select Suppliers --"
                  }
                  chipsPlacement="below"
                  fetchOptions={fetchSupplierOptions}
                  fetchLabelForValue={fetchSupplierLabel}
                />
              </div>
            )}

            {/* Note */}
            <div>
              <label style={{ display: "block", fontSize: "12px", fontWeight: 600, color: "#64748b", marginBottom: "4px" }}>Note</label>
              <textarea
                rows={3}
                placeholder="Add notes for suppliers..."
                value={note}
                onChange={(e) => setNote(e.target.value)}
                style={{ width: "100%", padding: "8px 10px", borderRadius: "6px", border: "1px solid #cbd5e1", fontSize: "13px", resize: "vertical" }}
              />
            </div>

            {/* Submit Button */}
            <div style={{ marginTop: "auto", paddingTop: "16px" }}>
              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: "100%",
                  padding: "10px",
                  background: "#2563eb",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "14px",
                  fontWeight: 700,
                  cursor: submitting ? "not-allowed" : "pointer",
                  boxShadow: "0 2px 6px rgba(37,99,235,0.25)",
                }}
              >
                {submitting ? "Dispatching RFQ..." : "Submit & Generate Links"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function QuotationTermsModal({ quote, onClose }: { quote: Quotation; onClose: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100020, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(2px)" }} onClick={onClose} />
      <div style={{ position: "relative", width: "480px", maxWidth: "92vw", background: "#ffffff", borderRadius: "12px", padding: "24px", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", borderBottom: "1px solid #e2e8f0", paddingBottom: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            Quotation Details — {quote.quote_number}
          </h3>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: "12px", fontSize: "13px" }}>
          <div><strong>Supplier:</strong> {quote.supplier_name || "—"}</div>
          <div><strong>Quantity:</strong> {quote.quantity}</div>
          <div><strong>Unit Price:</strong> ¥{quote.unit_price}</div>
          <div><strong>Total Cost:</strong> ¥{quote.total_cost.toLocaleString()} (${(quote.total_cost / 7.25).toFixed(2)})</div>
          <div><strong>Expected Receiving:</strong> {quote.expected_receiving_date || "—"}</div>
          <div>
            <strong>Terms & Conditions:</strong>
            <div style={{ background: "#f8fafc", padding: "10px", borderRadius: "6px", marginTop: "4px", border: "1px solid #e2e8f0", whiteSpace: "pre-wrap" }}>
              {quote.terms_and_conditions || "Standard payment terms apply upon delivery."}
            </div>
          </div>
          {quote.remarks && (
            <div>
              <strong>Remarks:</strong>
              <div style={{ background: "#f8fafc", padding: "10px", borderRadius: "6px", marginTop: "4px", border: "1px solid #e2e8f0", whiteSpace: "pre-wrap" }}>
                {quote.remarks}
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: "20px", textAlign: "right" }}>
          <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: "6px 14px", fontSize: "13px" }}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ProductInfoModal({ item, onClose }: { item: InquiryItem | null; onClose: () => void }) {
  if (!item) return null;
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100020, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(2px)" }} onClick={onClose} />
      <div style={{ position: "relative", width: "500px", maxWidth: "92vw", background: "#ffffff", borderRadius: "12px", padding: "24px", boxShadow: "0 20px 40px rgba(0,0,0,0.2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", borderBottom: "1px solid #e2e8f0", paddingBottom: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "16px", fontWeight: 700, color: "#0f172a" }}>
            📦 Product Info — {item.product_name || item.product_name_tally}
          </h3>
          <button type="button" onClick={onClose} style={{ background: "none", border: "none", fontSize: "18px", cursor: "pointer", color: "#64748b" }}>✕</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", fontSize: "13px" }}>
          <div><strong>Product Code:</strong> {item.product_code || "—"}</div>
          <div><strong>Quantity:</strong> {item.quantity} {item.uom_name || item.uom_code || ""}</div>
          <div><strong>Pkg Qty:</strong> {item.packaging_quantity || 10}</div>
          <div><strong>Pkg Unit Weight:</strong> {item.packaging_gross_weight || 20} KG</div>
          <div><strong>Pkg Unit CBM:</strong> {item.packaging_unit_cbm || 3.5} CBM</div>
          <div><strong>Status:</strong> {statusLabel(item.status)}</div>
          {item.brand_preference && <div style={{ gridColumn: "span 2" }}><strong>Brand Preference:</strong> {item.brand_preference}</div>}
          {item.product_specs_remarks && <div style={{ gridColumn: "span 2" }}><strong>Specs / Remarks:</strong> {item.product_specs_remarks}</div>}
          {item.requires_license && (
            <div style={{ gridColumn: "span 2", color: "#dc2626", fontWeight: 600 }}>
              ⚠️ Requires License/Certificate: {item.license_details || "Yes"}
            </div>
          )}
        </div>

        <div style={{ marginTop: "20px", textAlign: "right" }}>
          <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: "6px 14px", fontSize: "13px" }}>Close</button>
        </div>
      </div>
    </div>
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
  const [form, setForm] = useState({
    ...EMPTY_ITEM_FORM,
    buyer_id: defaultBuyerId || "",
    consignment_code_id: defaultConsignmentCodeId || "",
  });
  const [status, setStatus] = useState<"proposed" | "approved">("proposed");
  const [submitting, setSubmitting] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  // Sync buyer_id if defaultBuyerId changes
  useEffect(() => {
    if (defaultBuyerId && !form.buyer_id) {
      setForm((f) => ({ ...f, buyer_id: defaultBuyerId }));
    }
  }, [defaultBuyerId, form.buyer_id]);

  const codeFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      try {
        const query = defaultBuyerId ? toQueryString({ buyer_id: defaultBuyerId }) : "";
        const { data } = await apiGet<any>(`/inquiries/consignment-codes${query}`, { signal });
        const list = Array.isArray(data) ? data : data?.data || [];
        return list
          .filter((c: any) => (c.code || "").toLowerCase().includes(term.toLowerCase()))
          .map((c: any) => ({ value: c.id, label: c.code }));
      } catch {
        return [];
      }
    },
    [defaultBuyerId]
  );

  const codeLabel = useCallback(
    async (id: string) => {
      try {
        const query = defaultBuyerId ? toQueryString({ buyer_id: defaultBuyerId }) : "";
        const { data } = await apiGet<any>(`/inquiries/consignment-codes${query}`);
        const list = Array.isArray(data) ? data : data?.data || [];
        return list.find((c: any) => c.id === id)?.code || id;
      } catch {
        return id;
      }
    },
    [defaultBuyerId]
  );

  const productFetcher = useCallback(
    async (term: string, signal: AbortSignal): Promise<DropdownOption[]> => {
      try {
        const { data } = await apiGet<any>(
          "/masters/products" + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" }),
          { signal }
        );
        const list = Array.isArray(data) ? data : data?.data || [];
        return list.map((d: any) => ({
          value: d.id,
          label: `${d.product_code || ""} — ${d.product_name || d.product_name_tally || "Product"}`,
        }));
      } catch {
        return [];
      }
    },
    []
  );

  const productLabel = useCallback(async (id: string) => {
    try {
      const { data } = await apiGet<any>(`/masters/products/${id}`);
      return `${data.product_code || ""} — ${data.product_name || data.product_name_tally || id}`;
    } catch {
      return id;
    }
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;

    if (!form.consignment_code_id) {
      setModalError("Consignment Code is required.");
      return;
    }
    if (!form.product_id) {
      setModalError("Product Name is required.");
      return;
    }
    if (!form.quantity || Number(form.quantity) <= 0) {
      setModalError("Quantity must be greater than 0.");
      return;
    }

    const resolvedBuyerId = form.buyer_id || defaultBuyerId;
    if (!resolvedBuyerId) {
      setModalError("Buyer ID is missing. Please re-open the modal or re-select consignment code.");
      return;
    }

    setSubmitting(true);
    setModalError(null);
    try {
      await apiPost("/inquiries/items", {
        buyer_id: resolvedBuyerId,
        consignment_code_id: form.consignment_code_id,
        product_id: form.product_id,
        quantity: Number(form.quantity),
        brand_preference: form.brand_preference || null,
        product_specs_remarks: form.product_specs_remarks || null,
        status,
      });
      onSaved();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || "Failed to add inquiry item. Please check the inputs.";
      setModalError(msg);
      onError(err);
    } finally {
      setSubmitting(false);
    }
  }

  const handleProductSelect = async (v: string | null) => {
    const prodId = v || "";
    setForm((f) => ({ ...f, product_id: prodId }));
    setModalError(null);

    if (prodId) {
      try {
        const { data: prod } = await apiGet<any>(`/masters/products/${prodId}`);
        if (prod) {
          setForm((f) => ({
            ...f,
            product_id: prodId,
            product_specs_remarks: prod.specification || prod.description || f.product_specs_remarks,
            brand_preference: prod.brand?.name || prod.brand_name || f.brand_preference,
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
        {modalError && (
          <div
            style={{
              background: "#fef2f2",
              border: "1px solid #fecaca",
              color: "#dc2626",
              padding: "9px 13px",
              borderRadius: "8px",
              fontSize: "12.5px",
              marginBottom: "14px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <span>⚠️</span>
            <span>{modalError}</span>
          </div>
        )}

        <label style={labelStyle}>Consignment Code *</label>
        <SearchableDropdown
          value={form.consignment_code_id}
          onChange={(v) => {
            setForm((f) => ({ ...f, consignment_code_id: v || "" }));
            setModalError(null);
          }}
          placeholder="e.g. FB1"
          fetchOptions={codeFetcher}
          fetchLabelForValue={codeLabel}
        />

        <label style={{ ...labelStyle, marginTop: 12 }}>Product Name *</label>
        <SearchableDropdown
          value={form.product_id}
          onChange={(v) => handleProductSelect(v)}
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
            onChange={(v) => {
              setForm((f) => ({ ...f, quantity: v }));
              setModalError(null);
            }}
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

  const stampedDateStr = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  const stampedUserName = String(profile?.full_name || profile?.username || "Rahul Patel");

  useEffect(() => {
    (async () => {
      try {
        const [compRes, uomRes] = await Promise.all([
          apiGet<any>("/buyers?limit=1000"),
          apiGet<any[]>("/masters/uom"),
        ]);
        const buyersList = Array.isArray(compRes.data) ? compRes.data : compRes.data?.data || [];
        const formattedBuyers = buyersList.map((b: any) => ({
          ...b,
          name: b.company_name || b.name || "Unnamed Buyer",
        }));
        setCompanies(formattedBuyers);
        setUoms(uomRes.data);
      } catch (err) {
        onError(err);
      }
    })();
  }, [onError]);

  const [allConsignmentCodes, setAllConsignmentCodes] = useState<ConsignmentCode[]>([]);

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
              return {
                id: item.id,
                product_id: item.product_id,
                product_name: item.product_name || item.product_name_tally || "",
                uom_name: item.uom_name || "",
                quantity: String(item.quantity || ""),
                brand_preference: item.brand_preference || "",
                product_specs_remarks: item.product_specs_remarks || "",
                requires_license: Boolean(item.requires_license),
                license_details: item.license_details || null,
              };
            });
            setItems(mappedRows);
          }
        }
      } catch {
      }
    })();
  }, [selectedBuyerId, selectedCodeId]);

  const [selectedBuyer, setSelectedBuyer] = useState<any | null>(null);

  useEffect(() => {
    if (!selectedBuyerId) {
      setSelectedBuyer(null);
      return;
    }
    const found = companies.find((c) => c.id === selectedBuyerId);
    if (found) {
      setSelectedBuyer(found);
      return;
    }
    (async () => {
      try {
        const { data } = await apiGet<any>(`/buyers/${selectedBuyerId}`);
        if (data) {
          const formatted = {
            ...data,
            name: data.company_name || data.name || "Unnamed Buyer",
          };
          setSelectedBuyer(formatted);
          setCompanies((prev) => [formatted, ...prev.filter((p) => p.id !== data.id)]);
        }
      } catch {
        /* ignore */
      }
    })();
  }, [selectedBuyerId, companies]);

  const recommendedCode = useMemo(() => {
    if (!selectedBuyer) return "";
    const name = String(selectedBuyer.name || selectedBuyer.company_name || "").trim();
    const code = selectedBuyer.code;

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
        const words = name.replace(/[^a-zA-Z0-9\s]/g, "").trim().split(/\s+/).filter(Boolean);
        const alphaWords = words.filter((w) => /^[a-zA-Z]/.test(w));
        if (alphaWords.length >= 2) {
          prefix = alphaWords.map((w) => w[0]).join("").toUpperCase();
        } else if (alphaWords.length === 1 && alphaWords[0].length >= 3) {
          prefix = alphaWords[0].slice(0, 3).toUpperCase();
        } else if (words.length >= 1) {
          prefix = words[0].slice(0, 2).toUpperCase();
        } else {
          prefix = "CS";
        }
      }
    }

    if (!prefix) prefix = "CS";

    const matchingCodes = allConsignmentCodes.filter((c) => c.code && c.code.toUpperCase().startsWith(prefix));
    let maxNum = 0;
    matchingCodes.forEach((c) => {
      const num = parseInt(c.code.toUpperCase().replace(prefix, ""), 10);
      if (!isNaN(num) && num > maxNum) maxNum = num;
    });
    return `${prefix}${maxNum + 1}`;
  }, [selectedBuyer, allConsignmentCodes]);

  useEffect(() => {
    if (recommendedCode) {
      setCustomNewCode((prev) => (isCreatingNewCode && (!prev || prev === "") ? recommendedCode : prev || recommendedCode));
    }
  }, [recommendedCode, isCreatingNewCode]);

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

  const handleProductSelect = async (index: number, productId: string, directProduct?: any) => {
    if (!productId && !directProduct) {
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

    if (directProduct) {
      const uomObj = uoms.find((u) => u.id === directProduct.uom_id);
      const licReq = directProduct.license_certificate_required;
      const updated = [...items];
      updated[index] = {
        ...updated[index],
        product_id: directProduct.id,
        product_name: directProduct.product_name_tally || directProduct.product_name,
        uom_name: uomObj ? `${uomObj.name} (${uomObj.code})` : (directProduct.uom?.name || "NOS"),
        brand_preference: updated[index].brand_preference || directProduct.brand_name || directProduct.brand?.name || "",
        product_specs_remarks: directProduct.specification || directProduct.description || "",
        requires_license: Boolean(licReq && licReq.trim()),
        license_details: licReq || null,
      };
      setItems(updated);
      return;
    }

    let pickedProduct: any = null;
    try {
      const { data } = await apiGet<any>(`/masters/products/${productId}`);
      pickedProduct = data;
    } catch {
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

      if (isCreatingNewCode || !finalCodeId || finalCodeId === "__NEW__") {
        const codeToCreate = (customNewCode.trim() || recommendedCode || "").toUpperCase();
        if (!codeToCreate) {
          alert("Please enter a Consignment Code (e.g. INM1, FB1, T1).");
          setSaving(false);
          return;
        }
        const createRes = await apiPost<ConsignmentCode>("/inquiries/consignment-codes", {
          code: codeToCreate,
          label: `${selectedBuyer?.name || ""} Consignment ${codeToCreate}`,
          buyer_id: selectedBuyerId,
          branch_id: null,
        });
        finalCodeId = createRes.data.id;
      } else {
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
        }
      }

      const bulkPayload = {
        buyer_id: selectedBuyerId,
        consignment_code_id: finalCodeId,
        items: validItems.map((item) => ({
          product_id: item.product_id,
          quantity: parseFloat(item.quantity),
          brand_preference: item.brand_preference.trim() || null,
          product_specs_remarks: item.product_specs_remarks.trim() || null,
          status: submitStatus,
        })),
      };

      await apiPost("/inquiries/items/bulk", bulkPayload);

      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 100000, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ position: "absolute", inset: 0, background: "rgba(15,23,42,0.45)", backdropFilter: "blur(3px)" }} onClick={onClose} />

        <div
          style={{
            position: "relative",
            width: "680px",
            maxWidth: "96vw",
            height: "100%",
            background: "#ffffff",
            boxShadow: "-8px 0 24px rgba(0,0,0,0.15)",
            display: "flex",
            flexDirection: "column",
            zIndex: 1,
            animation: "slideLeft 0.25s ease-out",
          }}
        >
          <div style={{ padding: "20px 24px", borderBottom: "1px solid #e2e8f0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, fontSize: "18px", fontWeight: 800, color: "#0f172a", display: "flex", alignItems: "center", gap: "8px" }}>
                ⚡ Create Quick Inquiry
              </h3>
              <p style={{ margin: "4px 0 0", fontSize: "12px", color: "#64748b" }}>
                Quickly add products &amp; generate consignment requirements.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{ background: "none", border: "none", fontSize: "20px", cursor: "pointer", color: "#64748b", padding: "4px 8px" }}
            >
              ✕
            </button>
          </div>

          <div style={{ flex: 1, overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: "20px" }}>
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
                          onChange={(e) => handleUpdateItemField(idx, "brand_preference", autoTitleCase(e.target.value))}
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
                          onChange={(e) => handleUpdateItemField(idx, "product_specs_remarks", autoTitleCase(e.target.value))}
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
    </>
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