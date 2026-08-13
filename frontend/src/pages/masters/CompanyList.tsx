import { MasterPage, type FormState } from "@/components/MasterPage";
import { StatusBadge } from "@/components/ui";
import { StatusSelectField, TextField } from "@/components/fields";
import type { MasterRecord, CompanyBranch } from "@/types";

interface MasterCompanyItem extends MasterRecord {
  name: string;
  code: string;
  description?: string;
  branches?: CompanyBranch[] | null;
  status: string;
}

const EMPTY: FormState = {
  name: "",
  code: "",
  description: "",
  branches_json: "[]",
  status: "active",
};

export function CompanyListPage() {
  return (
    <MasterPage<MasterCompanyItem>
      activeKey="masters-company-list"
      apiBase="/masters/company-list"
      permissionPrefix="company"
      entityName="organization"
      heading="Organization List"
      subtitle="Manage group operating entities, companies (e.g. Inhyma, FNB Solution), and their branches."
      breadcrumbTrail={["Master Data", "Organization List"]}
      newButtonLabel="+ ADD NEW ORGANIZATION"
      searchPlaceholder="Search organization name or Sr. No..."
      hideQuickAdd={true}
      columnHeaders={["ORGANIZATION NAME", "OPERATING BRANCHES", "STATUS"]}
      columns={[
        { header: "ORGANIZATION NAME", render: (c) => <span className="cell-primary">{c.name}</span> },
        {
          header: "OPERATING BRANCHES",
          render: (c) => (
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              {Array.isArray(c.branches) && c.branches.length > 0 ? (
                c.branches.map((b, i) => (
                  <span
                    key={b.id || i}
                    style={{
                      background: "#e0f2fe",
                      color: "#0369a1",
                      border: "1px solid #bae6fd",
                      borderRadius: "4px",
                      padding: "2px 8px",
                      fontSize: "12px",
                      fontWeight: 600,
                    }}
                  >
                    🏢 {b.name} {b.code_prefix ? `(${b.code_prefix})` : ""}
                  </span>
                ))
              ) : (
                <span style={{ color: "#94a3b8", fontSize: "12px", fontStyle: "italic" }}>No branches</span>
              )}
            </div>
          ),
        },
        { header: "STATUS", render: (c) => <StatusBadge status={c.status} /> },
      ]}
      importHeaders={[
        { key: "name", label: "Organization Name", required: true },
        { key: "status", label: "Status (active/inactive)" },
      ]}
      emptyForm={EMPTY}
      fillForm={(item) => ({
        name: item?.name ?? "",
        code: item?.code ?? "",
        description: item?.description ?? "",
        branches_json: JSON.stringify(Array.isArray(item?.branches) ? item.branches : []),
        status: item?.status ?? "active",
      })}
      toPayload={(f) => {
        if (!f.name.trim()) throw new Error("Organization Name is required.");
        let branchesList: CompanyBranch[] = [];
        try {
          branchesList = JSON.parse(f.branches_json || "[]");
        } catch {
          branchesList = [];
        }
        return {
          name: f.name.trim(),
          code: f.code.trim(),
          description: f.description.trim(),
          branches: branchesList,
          status: f.status,
        };
      }}
      renderFields={(f, set) => {
        let branches: CompanyBranch[] = [];
        try {
          branches = JSON.parse(f.branches_json || "[]");
        } catch {
          branches = [];
        }

        const handleAddBranch = () => {
          const newBranch: CompanyBranch = {
            id: `br_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            name: "",
            code_prefix: "",
            status: "active",
          };
          set("branches_json", JSON.stringify([...branches, newBranch]));
        };

        const handleUpdateBranch = (index: number, field: keyof CompanyBranch, val: string) => {
          const updated = [...branches];
          updated[index] = { ...updated[index], [field]: val };
          set("branches_json", JSON.stringify(updated));
        };

        const handleRemoveBranch = (index: number) => {
          set("branches_json", JSON.stringify(branches.filter((_, i) => i !== index)));
        };

        return (
          <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
            <div className="form-grid">
              <TextField
                id="name"
                label="Organization Name *"
                required
                maxLength={150}
                placeholder="e.g. Inhyma"
                value={f.name}
                onChange={(v) => set("name", v)}
              />
              <StatusSelectField value={f.status} onChange={(v) => set("status", v)} />
            </div>

            {/* Operating Branches & Code Prefixes Section */}
            <div
              style={{
                background: "#f8fafc",
                padding: "20px",
                borderRadius: "10px",
                border: "1px solid #cbd5e1",
                boxShadow: "0 4px 6px -1px rgba(0, 0, 0, 0.05)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                  <div
                    style={{
                      width: "36px",
                      height: "36px",
                      borderRadius: "8px",
                      background: "linear-gradient(135deg, #0284c7 0%, #0369a1 100%)",
                      color: "#ffffff",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "18px",
                      boxShadow: "0 2px 4px rgba(2, 132, 199, 0.25)",
                    }}
                  >
                    🏢
                  </div>
                  <div>
                    <h4 style={{ margin: 0, fontSize: "14.5px", fontWeight: 700, color: "#0f172a" }}>
                      Operating Branches &amp; Consignment Code Prefixes
                    </h4>
                    <div style={{ fontSize: "12px", color: "#64748b", marginTop: "2px" }}>
                      Define locations (e.g. Gujarat, Mumbai) &amp; prefixes (e.g. ING, INM) used for automated consignment codes.
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleAddBranch}
                  style={{
                    background: "linear-gradient(135deg, #0061f2 0%, #0284c7 100%)",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "6px",
                    padding: "7px 16px",
                    fontSize: "12.5px",
                    fontWeight: 700,
                    cursor: "pointer",
                    boxShadow: "0 2px 5px rgba(0, 97, 242, 0.2)",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                  }}
                >
                  <span>+</span> Add Branch
                </button>
              </div>

              {branches.length === 0 ? (
                <div style={{ fontStyle: "italic", fontSize: "13px", color: "#94a3b8", textAlign: "center", padding: "20px", background: "#ffffff", borderRadius: "8px", border: "1px dashed #cbd5e0" }}>
                  No branches added yet. Click "+ Add Branch" above to define operating locations (e.g. Mumbai, Gujarat).
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {/* Table Sub-Header */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "30px 1fr 140px 42px",
                      gap: "12px",
                      padding: "0 8px 4px 8px",
                      fontSize: "11px",
                      fontWeight: 700,
                      color: "#64748b",
                      letterSpacing: "0.5px",
                      textTransform: "uppercase",
                    }}
                  >
                    <span>#</span>
                    <span>Location / Branch Name</span>
                    <span>Code Prefix</span>
                    <span style={{ textAlign: "center" }}>Action</span>
                  </div>

                  {branches.map((br, idx) => (
                    <div
                      key={br.id || idx}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "30px 1fr 140px 42px",
                        gap: "12px",
                        alignItems: "center",
                        background: "#ffffff",
                        padding: "12px 14px",
                        borderRadius: "8px",
                        border: "1px solid #e2e8f0",
                        borderLeft: "4px solid #0284c7",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                      }}
                    >
                      <span
                        style={{
                          fontSize: "12px",
                          fontWeight: 700,
                          color: "#0369a1",
                          background: "#e0f2fe",
                          borderRadius: "4px",
                          width: "22px",
                          height: "22px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {idx + 1}
                      </span>

                      <div>
                        <input
                          type="text"
                          placeholder="e.g. Inhyma Mumbai or Gujarat"
                          value={br.name}
                          onChange={(e) => handleUpdateBranch(idx, "name", e.target.value)}
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            borderRadius: "6px",
                            border: "1px solid #cbd5e0",
                            fontSize: "13.5px",
                            fontWeight: 500,
                            color: "#1e293b",
                            background: "#ffffff",
                          }}
                        />
                      </div>

                      <div>
                        <input
                          type="text"
                          placeholder="e.g. INM"
                          value={br.code_prefix}
                          onChange={(e) => handleUpdateBranch(idx, "code_prefix", e.target.value.toUpperCase())}
                          style={{
                            width: "100%",
                            padding: "8px 12px",
                            borderRadius: "6px",
                            border: "1px solid #bae6fd",
                            fontSize: "13.5px",
                            fontWeight: 700,
                            color: "#0369a1",
                            background: "#f0f9ff",
                            letterSpacing: "0.5px",
                          }}
                        />
                      </div>

                      <button
                        type="button"
                        onClick={() => handleRemoveBranch(idx)}
                        style={{
                          background: "#fef2f2",
                          color: "#dc2626",
                          border: "1px solid #fecaca",
                          borderRadius: "6px",
                          height: "36px",
                          width: "36px",
                          cursor: "pointer",
                          fontWeight: 700,
                          fontSize: "14px",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                        title="Delete branch"
                      >
                        🗑️
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      }}
      detailFields={(c) => [
        { label: "Organization Name", value: c.name, fullWidth: true },
        {
          label: "Operating Branches",
          value: (
            <div>
              {Array.isArray(c.branches) && c.branches.length > 0
                ? c.branches.map((b) => `${b.name} (${b.code_prefix})`).join(", ")
                : "None"}
            </div>
          ),
          fullWidth: true,
        },
        { label: "Current Status", value: <StatusBadge status={c.status} /> },
      ]}
    />
  );
}
