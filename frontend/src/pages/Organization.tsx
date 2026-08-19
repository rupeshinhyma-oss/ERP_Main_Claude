/**
 * Organization Settings. Ported from organization.html.
 *
 * Shows a read-only detail card by default and swaps to the form on Edit. If no
 * organization record exists yet the API answers 404 and the page opens straight
 * into the form -- there is nothing to "view" until one is created, and the same
 * form then POSTs instead of PATCHing.
 *
 * Saving invalidates the cached brand name so a rename shows up immediately in
 * the sidebar here, and on every other open tab's next navigation.
 */

import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Breadcrumb } from "@/components/Breadcrumb";
import { Banner, Can } from "@/components/ui";
import { SelectField, TextAreaField, TextField } from "@/components/fields";
import { apiGet, apiPatch, apiPost, ApiError } from "@/lib/api";
import { invalidateBrandNameCache, setBrandName } from "@/lib/brand";
import type { Organization, OrganizationFieldId } from "@/types";

const FIELD_IDS: OrganizationFieldId[] = [
  "company_name",
  "legal_name",
  "email",
  "phone",
  "website",
  "gst_number",
  "pan_number",
  "timezone",
  "currency",
  "status",
  "address",
  "city",
  "state",
  "country",
  "postal_code",
  "business_hours",
];

type OrgForm = Record<OrganizationFieldId, string>;

const EMPTY_FORM = FIELD_IDS.reduce((acc, id) => {
  acc[id] = id === "status" ? "ACTIVE" : "";
  return acc;
}, {} as OrgForm);

function DetailItem({
  label,
  value,
  fullWidth,
}: {
  label: string;
  value?: string | null;
  fullWidth?: boolean;
}) {
  return (
    <div style={fullWidth ? { gridColumn: "1 / -1" } : undefined}>
      <div className="label">{label}</div>
      <div className="value">{value || "—"}</div>
    </div>
  );
}

function OrganizationDetailSkeleton() {
  return (
    <div className="card">
      <div className="detail-grid">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i}>
            <div className="label"><div className="skeleton-line" style={{ width: "80px", height: "12px", marginBottom: "4px" }} /></div>
            <div className="value"><div className="skeleton-line" style={{ width: "140px", height: "16px" }} /></div>
          </div>
        ))}
      </div>
      <div className="section-title">Address</div>
      <div className="detail-grid">
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="label"><div className="skeleton-line" style={{ width: "60px", height: "12px", marginBottom: "4px" }} /></div>
          <div className="value"><div className="skeleton-line" style={{ width: "80%", height: "16px" }} /></div>
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i}>
            <div className="label"><div className="skeleton-line" style={{ width: "60px", height: "12px", marginBottom: "4px" }} /></div>
            <div className="value"><div className="skeleton-line" style={{ width: "110px", height: "16px" }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OrganizationPage() {
  const [org, setOrg] = useState<Organization | null>(null);
  const [form, setForm] = useState<OrgForm>(EMPTY_FORM);
  const [mode, setMode] = useState<"create" | "update">("create");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const setField = (id: OrganizationFieldId, value: string) =>
    setForm((prev) => ({ ...prev, [id]: value }));

  function fillForm(source: Organization): OrgForm {
    return FIELD_IDS.reduce((acc, id) => {
      acc[id] = (source[id] as string | null | undefined) ?? "";
      return acc;
    }, {} as OrgForm);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await apiGet<Organization>("/organizations");
        if (cancelled) return;
        setOrg(data);
        setForm(fillForm(data));
        setMode("update");
        setEditing(false);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          // No profile exists yet -- go straight to the form.
          setMode("create");
          setEditing(true);
        } else {
          setError(err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function readForm(): Record<string, string | null> {
    const payload: Record<string, string | null> = {};
    for (const id of FIELD_IDS) {
      const value = (form[id] || "").trim();
      payload[id] = value === "" ? null : value;
    }
    if (!payload.timezone) payload.timezone = "UTC";
    if (!payload.currency) payload.currency = "USD";
    return payload;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    const payload = readForm();

    try {
      let data: Organization;
      if (mode === "create") {
        ({ data } = await apiPost<Organization>("/organizations", payload));
        setMode("update");
      } else {
        ({ data } = await apiPatch<Organization>("/organizations", payload));
      }
      setOrg(data);
      setForm(fillForm(data));

      invalidateBrandNameCache();
      if (data?.company_name) {
        setBrandName(data.company_name);
      }
      setSuccess("Saved.");
      setEditing(false);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  const statusLabel =
    org?.status === "ACTIVE" ? "Active" : org?.status === "INACTIVE" ? "Inactive" : "—";

  return (
    <AppShell activeKey="organization">
      <main className="page">
        <Breadcrumb trail={["Settings", "Organization"]} />
        <div className="page-header">
          <div>
            <h1>Organization Settings</h1>
            <div className="page-subtitle">
              Your company's profile, used throughout the ERP and shown as the sidebar's brand
              name.
            </div>
          </div>
          {!editing && (
            <div className="page-header-actions">
              <Can permission="organization.manage">
                <button className="btn btn-primary" onClick={() => setEditing(true)}>
                  Edit
                </button>
              </Can>
            </div>
          )}
        </div>
        <Banner error={error} success={success} />

        {!editing && !org && <OrganizationDetailSkeleton />}

        {!editing && org && (
          <div className="card">
            <div className="detail-grid">
              <DetailItem label="Company Name" value={org.company_name} />
              <DetailItem label="Legal Name" value={org.legal_name} />
              <DetailItem label="Email" value={org.email} />
              <DetailItem label="Phone" value={org.phone} />
              <DetailItem label="Website" value={org.website} />
              <DetailItem label="GST Number" value={org.gst_number} />
              <DetailItem label="PAN Number" value={org.pan_number} />
              <DetailItem label="Timezone" value={org.timezone} />
              <DetailItem label="Currency" value={org.currency} />
              <DetailItem label="Status" value={statusLabel} />
            </div>
            <div className="section-title">Address</div>
            <div className="detail-grid">
              <DetailItem label="Address" value={org.address} fullWidth />
              <DetailItem label="City" value={org.city} />
              <DetailItem label="State" value={org.state} />
              <DetailItem label="Country" value={org.country} />
              <DetailItem label="Postal Code" value={org.postal_code} />
            </div>
            <div className="section-title">Other</div>
            <div className="detail-grid">
              <DetailItem label="Business Hours" value={org.business_hours} />
            </div>
          </div>
        )}

        {editing && (
          <div className="card">
            <form onSubmit={handleSubmit}>
              <div className="form-grid">
                <TextField id="company_name" label="Company name *" required maxLength={200} value={form.company_name} onChange={(v) => setField("company_name", v)} />
                <TextField id="legal_name" label="Legal name" maxLength={200} value={form.legal_name} onChange={(v) => setField("legal_name", v)} />
                <TextField id="email" label="Email" type="email" value={form.email} onChange={(v) => setField("email", v)} />
                <TextField id="phone" label="Phone" maxLength={30} value={form.phone} onChange={(v) => setField("phone", v)} />
                <TextField id="website" label="Website" maxLength={255} value={form.website} onChange={(v) => setField("website", v)} />
                <TextField id="gst_number" label="GST number" maxLength={50} value={form.gst_number} onChange={(v) => setField("gst_number", v)} />
                <TextField id="pan_number" label="PAN number" maxLength={50} value={form.pan_number} onChange={(v) => setField("pan_number", v)} />
                <TextField id="timezone" label="Timezone" maxLength={50} placeholder="UTC" value={form.timezone} onChange={(v) => setField("timezone", v)} />
                <TextField id="currency" label="Currency" maxLength={10} placeholder="USD" value={form.currency} onChange={(v) => setField("currency", v)} />
                <SelectField id="status" label="Status" value={form.status} onChange={(v) => setField("status", v)}>
                  <option value="ACTIVE">Active</option>
                  <option value="INACTIVE">Inactive</option>
                </SelectField>
              </div>

              <TextAreaField id="address" label="Address" value={form.address} onChange={(v) => setField("address", v)} />
              <div className="form-grid">
                <TextField id="city" label="City" maxLength={100} value={form.city} onChange={(v) => setField("city", v)} />
                <TextField id="state" label="State" maxLength={100} value={form.state} onChange={(v) => setField("state", v)} />
                <TextField id="country" label="Country" maxLength={100} value={form.country} onChange={(v) => setField("country", v)} />
                <TextField id="postal_code" label="Postal code" maxLength={20} value={form.postal_code} onChange={(v) => setField("postal_code", v)} />
              </div>
              <TextField id="business_hours" label="Business hours" maxLength={255} placeholder="Mon–Fri, 9am–6pm" value={form.business_hours} onChange={(v) => setField("business_hours", v)} />

              <div className="form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  Save
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setSuccess(null);
                    if (org) setForm(fillForm(org));
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}
      </main>
    </AppShell>
  );
}
