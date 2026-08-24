import React, { useEffect, useState } from "react";
import { useParams } from "react-router-dom";

interface RFQDetails {
  item_id: string;
  rfq_id: string;
  supplier_id: string;
  supplier_name: string;
  buyer_company_name: string;
  product_name: string;
  product_code: string;
  quantity: number;
  uom_name: string;
  brand_preference?: string | null;
  product_specs_remarks?: string | null;
  procurement_remarks?: string | null;
  expected_receiving_date?: string | null;
  rfq_notes?: string | null;
  packaging_quantity?: number | null;
  packaging_gross_weight?: number | null;
  packaging_unit_cbm?: number | null;
  already_submitted: boolean;
  submitted_quote?: {
    quote_number: string;
    unit_price: number;
    total_cost: number;
    currency: string;
    expected_receiving_date?: string | null;
    terms_and_conditions?: string | null;
    remarks?: string | null;
    created_at?: string | null;
  } | null;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  CNY: "¥",
  USD: "$",
  INR: "₹",
  EUR: "€",
  GBP: "£",
  AED: "AED ",
};

function getCurrencySymbol(curr: string = "CNY") {
  return CURRENCY_SYMBOLS[curr.toUpperCase()] || curr;
}

export default function PublicSupplierQuotePage() {
  const { token } = useParams<{ token: string }>();

  const [rfq, setRfq] = useState<RFQDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [unitPrice, setUnitPrice] = useState("");
  const [currency, setCurrency] = useState("CNY");
  const [leadTime, setLeadTime] = useState("");
  const [terms, setTerms] = useState("");
  const [remarks, setRemarks] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submittedData, setSubmittedData] = useState<any | null>(null);

  useEffect(() => {
    if (!token) {
      setError("Invalid or missing quotation link.");
      setLoading(false);
      return;
    }

    let isMounted = true;
    const apiUrl = import.meta.env.VITE_API_BASE_URL || "/api/v1";

    fetch(`${apiUrl}/public/rfq/${token}`)
      .then((res) => {
        if (!res.ok) {
          throw new Error(res.status === 410 ? "This RFQ link has expired." : "RFQ link not found or invalid.");
        }
        return res.json();
      })
      .then((json) => {
        if (!isMounted) return;
        if (json && json.data) {
          setRfq(json.data);
          if (json.data.already_submitted && json.data.submitted_quote) {
            setSubmittedData(json.data.submitted_quote);
          }
        } else {
          throw new Error("Could not parse RFQ details.");
        }
      })
      .catch((err) => {
        if (isMounted) setError(err.message || "Failed to load RFQ.");
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [token]);

  const qty = rfq?.quantity || 1;
  const numUnitPrice = parseFloat(unitPrice) || 0;
  const totalCost = (numUnitPrice * qty).toFixed(2);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unitPrice || parseFloat(unitPrice) <= 0) {
      alert("Please enter a valid Unit Price.");
      return;
    }

    setSubmitting(true);
    const apiUrl = import.meta.env.VITE_API_BASE_URL || "/api/v1";

    try {
      const res = await fetch(`${apiUrl}/public/rfq/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          unit_price: parseFloat(unitPrice),
          quantity: qty,
          currency: currency,
          expected_receiving_date: leadTime.trim() || null,
          terms_and_conditions: terms.trim() || null,
          remarks: remarks.trim() || null,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.message || json.detail || "Failed to submit quotation.");
      }

      setSubmittedData(json.data);
    } catch (err: any) {
      alert(err.message || "Failed to submit quotation. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", fontFamily: "Inter, -apple-system, sans-serif" }}>
        <div style={{ textAlign: "center", padding: "30px" }}>
          <div style={{ width: "40px", height: "40px", border: "4px solid #e2e8f0", borderTopColor: "#0061f2", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 16px" }} />
          <div style={{ fontSize: "15px", fontWeight: 600, color: "#334155" }}>Loading Request for Quotation...</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (error || !rfq) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#f8fafc", padding: "20px", fontFamily: "Inter, -apple-system, sans-serif" }}>
        <div style={{ maxWidth: "460px", width: "100%", background: "#ffffff", padding: "32px 24px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 10px 25px rgba(0,0,0,0.05)", textAlign: "center" }}>
          <div style={{ fontSize: "40px", marginBottom: "12px" }}>⚠️</div>
          <h2 style={{ fontSize: "18px", fontWeight: 700, color: "#0f172a", margin: "0 0 8px" }}>Link Unavailable</h2>
          <p style={{ fontSize: "14px", color: "#64748b", margin: 0 }}>{error || "This quotation link is invalid or has expired."}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f1f5f9", padding: "24px 16px", fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", color: "#0f172a" }}>
      <div style={{ maxWidth: "640px", margin: "0 auto" }}>
        {/* Brand Header */}
        <div style={{ background: "#ffffff", padding: "20px 24px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", marginBottom: "16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: "18px", fontWeight: 800, color: "#0061f2", display: "flex", alignItems: "center", gap: "6px" }}>
              <span>⚡</span> Yinglima ERP
            </div>
            <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Request For Quotation (RFQ) Portal</div>
          </div>
          <div style={{ textAlign: "right" }}>
            <span style={{ fontSize: "11px", fontWeight: 700, padding: "4px 8px", borderRadius: "12px", background: "#eff6ff", color: "#1d4ed8", border: "1px solid #bfdbfe" }}>
              Secure Supplier Portal
            </span>
          </div>
        </div>

        {/* Welcome Card */}
        <div style={{ background: "linear-gradient(135deg, #0061f2 0%, #1e40af 100%)", color: "#ffffff", padding: "20px 24px", borderRadius: "12px", marginBottom: "16px", boxShadow: "0 4px 12px rgba(0,97,242,0.25)" }}>
          <div style={{ fontSize: "13px", fontWeight: 500, opacity: 0.9 }}>Quotation Requested For:</div>
          <div style={{ fontSize: "18px", fontWeight: 800, marginTop: "2px" }}>{rfq.supplier_name}</div>
          <div style={{ fontSize: "12.5px", opacity: 0.85, marginTop: "6px" }}>
            Please review the product specifications below and submit your best commercial quote.
          </div>
        </div>

        {/* Submitted Confirmation Card */}
        {submittedData ? (
          <div style={{ background: "#ffffff", padding: "32px 24px", borderRadius: "12px", border: "1px solid #86efac", boxShadow: "0 4px 16px rgba(34,197,94,0.12)", textAlign: "center" }}>
            <div style={{ width: "56px", height: "56px", borderRadius: "50%", background: "#dcfce7", color: "#16a34a", fontSize: "28px", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
              ✓
            </div>
            <h2 style={{ fontSize: "20px", fontWeight: 800, color: "#15803d", margin: "0 0 8px" }}>Quotation Submitted!</h2>
            <p style={{ fontSize: "13.5px", color: "#475569", margin: "0 0 20px" }}>
              Thank you! Your quotation has been transmitted to our procurement team.
            </p>

            <div style={{ background: "#f8fafc", padding: "16px", borderRadius: "8px", border: "1px solid #e2e8f0", textAlign: "left", fontSize: "13px", display: "flex", flexDirection: "column", gap: "8px" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Quote Number:</span>
                <strong style={{ color: "#0f172a" }}>{submittedData.quote_number}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Product:</span>
                <strong style={{ color: "#0f172a" }}>{rfq.product_name}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Quantity:</span>
                <strong style={{ color: "#0f172a" }}>{rfq.quantity} {rfq.uom_name}</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Unit Price:</span>
                <strong style={{ color: "#0061f2", fontSize: "15px" }}>{getCurrencySymbol(submittedData.currency)}{submittedData.unit_price} ({submittedData.currency || "CNY"})</strong>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#64748b" }}>Total Cost:</span>
                <strong style={{ color: "#0f172a", fontSize: "15px" }}>{getCurrencySymbol(submittedData.currency)}{submittedData.total_cost?.toLocaleString()} ({submittedData.currency || "CNY"})</strong>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Product Specifications Card */}
            <div style={{ background: "#ffffff", padding: "20px 24px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", marginBottom: "16px" }}>
              <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#334155", margin: "0 0 12px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                📦 Product Requirement
              </h3>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px" }}>
                <div>
                  <div style={{ fontSize: "16px", fontWeight: 800, color: "#0f172a" }}>{rfq.product_name}</div>
                  <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>Code: #{rfq.product_code}</div>
                </div>
                <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", padding: "6px 12px", borderRadius: "8px", textAlign: "right" }}>
                  <div style={{ fontSize: "11px", color: "#1e40af", fontWeight: 600 }}>Required Qty</div>
                  <div style={{ fontSize: "16px", fontWeight: 800, color: "#1d4ed8" }}>
                    {rfq.quantity} <span style={{ fontSize: "12px" }}>{rfq.uom_name}</span>
                  </div>
                </div>
              </div>

              {rfq.product_specs_remarks && (
                <div style={{ marginTop: "12px", background: "#f8fafc", padding: "10px 14px", borderRadius: "6px", border: "1px solid #e2e8f0", fontSize: "12.5px" }}>
                  <span style={{ fontWeight: 700, color: "#475569" }}>Specifications: </span>
                  <span style={{ color: "#334155" }}>{rfq.product_specs_remarks}</span>
                </div>
              )}

              {rfq.rfq_notes && (
                <div style={{ marginTop: "8px", background: "#fffbeb", padding: "10px 14px", borderRadius: "6px", border: "1px solid #fef3c7", fontSize: "12.5px" }}>
                  <span style={{ fontWeight: 700, color: "#b45309" }}>Buyer Notes: </span>
                  <span style={{ color: "#92400e" }}>{rfq.rfq_notes}</span>
                </div>
              )}

              {rfq.expected_receiving_date && (
                <div style={{ marginTop: "8px", fontSize: "12px", color: "#64748b" }}>
                  📅 Desired Delivery Date: <strong style={{ color: "#0f172a" }}>{rfq.expected_receiving_date}</strong>
                </div>
              )}
            </div>

            {/* Supplier Price Submission Form */}
            <form onSubmit={handleSubmit} style={{ background: "#ffffff", padding: "20px 24px", borderRadius: "12px", border: "1px solid #e2e8f0", boxShadow: "0 2px 8px rgba(0,0,0,0.03)", display: "flex", flexDirection: "column", gap: "16px" }}>
              <h3 style={{ fontSize: "15px", fontWeight: 700, color: "#334155", margin: "0 0 4px", borderBottom: "1px solid #f1f5f9", paddingBottom: "8px" }}>
                💰 Your Quotation Details
              </h3>

              {/* Price & Currency */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    *Unit Price
                  </label>
                  <div style={{ position: "relative" }}>
                    <span style={{ position: "absolute", left: "10px", top: "50%", transform: "translateY(-50%)", color: "#64748b", fontWeight: 700, fontSize: "14px" }}>
                      {getCurrencySymbol(currency)}
                    </span>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      required
                      placeholder="e.g. 450.00"
                      value={unitPrice}
                      onChange={(e) => setUnitPrice(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "10px 10px 10px 32px",
                        borderRadius: "8px",
                        border: "1.5px solid #0061f2",
                        fontSize: "15px",
                        fontWeight: 700,
                        color: "#0f172a",
                        outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                    Currency
                  </label>
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      border: "1px solid #cbd5e1",
                      fontSize: "14px",
                      fontWeight: 600,
                      color: "#334155",
                      background: "#f8fafc",
                      boxSizing: "border-box",
                    }}
                  >
                    <option value="CNY">CNY (¥)</option>
                    <option value="USD">USD ($)</option>
                    <option value="INR">INR (₹)</option>
                    <option value="EUR">EUR (€)</option>
                    <option value="GBP">GBP (£)</option>
                    <option value="AED">AED (AED)</option>
                  </select>
                </div>
              </div>

              {/* Total Cost Display */}
              <div style={{ background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "8px", padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: "12px", color: "#64748b" }}>Total Cost ({qty} units)</div>
                  <div style={{ fontSize: "11px", color: "#94a3b8" }}>Auto-calculated</div>
                </div>
                <div style={{ fontSize: "18px", fontWeight: 800, color: "#0061f2" }}>
                  {getCurrencySymbol(currency)}{Number(totalCost).toLocaleString()} <span style={{ fontSize: "12px", fontWeight: 600 }}>{currency}</span>
                </div>
              </div>

              {/* Lead Time / Delivery Date */}
              <div>
                <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  📅 Expected Delivery Date (Select from Calendar)
                </label>
                <input
                  type="date"
                  min={new Date().toISOString().split("T")[0]}
                  value={leadTime}
                  onChange={(e) => setLeadTime(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid #cbd5e1",
                    fontSize: "14px",
                    fontWeight: 600,
                    color: "#0f172a",
                    background: "#ffffff",
                    boxSizing: "border-box",
                    cursor: "pointer",
                  }}
                />
              </div>

              {/* Terms & Conditions */}
              <div>
                <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  Terms &amp; Conditions (Payment, Warranty, MOQ)
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. 30% T/T Advance, 70% before shipment. 1 Year Warranty included."
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: "8px",
                    border: "1px solid #cbd5e1",
                    fontSize: "13px",
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {/* Remarks / Notes */}
              <div>
                <label style={{ display: "block", fontSize: "12.5px", fontWeight: 700, color: "#334155", marginBottom: "4px" }}>
                  Additional Remarks / Packaging Notes
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Wooden box export packaging included. Ready stock."
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "9px 12px",
                    borderRadius: "8px",
                    border: "1px solid #cbd5e1",
                    fontSize: "13px",
                    resize: "vertical",
                    boxSizing: "border-box",
                  }}
                />
              </div>

              {/* Submit Button */}
              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: "100%",
                  padding: "12px",
                  background: "#0061f2",
                  color: "#ffffff",
                  border: "none",
                  borderRadius: "8px",
                  fontSize: "15px",
                  fontWeight: 700,
                  cursor: submitting ? "wait" : "pointer",
                  boxShadow: "0 4px 12px rgba(0,97,242,0.25)",
                  transition: "all 0.15s ease",
                  marginTop: "8px",
                }}
              >
                {submitting ? "Submitting Quotation..." : "🚀 Submit Official Quotation"}
              </button>
            </form>
          </>
        )}

        {/* Footer */}
        <div style={{ textAlign: "center", fontSize: "11.5px", color: "#94a3b8", marginTop: "24px" }}>
          Powered by Yinglima Enterprise Resource Planning • Secure Supplier Network
        </div>
      </div>
    </div>
  );
}
