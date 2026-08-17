/**
 * "📥 Sample Template" download button.
 *
 * Ported from the generic sample-template logic in masters-common.js: builds
 * a one-row example CSV directly from a page's own `importHeaders` (the same
 * list the column-mapping import wizard uses), so the sample always matches
 * whatever fields that page's import actually accepts -- add or rename an
 * import field and the sample stays correct automatically, no separate
 * hand-maintained CSV to fall out of sync.
 *
 * A hardcoded sample CSV for Suppliers existed too in the shipped app, but
 * its column list (company_name, legal_name, contact_person, email, phone,
 * city, country_code, status) doesn't match what Suppliers' own import
 * wizard actually accepts (company_name, supplier_type, brand_description,
 * country_code, state_name, city_name, ...) -- a leftover from an earlier
 * shape of the form. Using the header-driven generator for every page,
 * Suppliers included, avoids shipping a sample that would fail its own import.
 */

import type { ImportHeader } from "@/types";

const REALISTIC_SAMPLES: Record<string, string> = {
  "Product Name (As Per Tally)": "FR900 Continuous Band Sealer",
  "product_name": "FR900 Continuous Band Sealer",
  "Product Code": "INH-00101",
  "product_code": "INH-00101",
  "Supplier Company Name": "Inhyma",
  "supplier_name": "Inhyma",
  "Brand": "Yinglima",
  "brand_code": "Yinglima",
  "brand_name": "Yinglima",
  "Category": "Machines",
  "category_code": "Machines",
  "category_name": "Machines",
  "Sub Category": "Band Sealer",
  "Sub-Category": "Band Sealer",
  "sub_category_code": "Band Sealer",
  "sub_category_name": "Band Sealer",
  "HSN Code": "84229090",
  "hsn_code": "84229090",
  "UOM": "PCS",
  "uom_code": "PCS",
  "uom_name": "PCS",
  "Pack. Qty": "1",
  "Packaging Quantity": "1",
  "packaging_quantity": "1",
  "Pack. Net Weight": "25.5",
  "Packaging Net Weight (kg)": "25.5",
  "packaging_net_weight": "25.5",
  "Pack. Gross Weight": "28.0",
  "Packaging Gross Weight (kg)": "28.0",
  "packaging_gross_weight": "28.0",
  "weight": "28.0",
  "Length (cm)": "85",
  "length_cm": "85",
  "length": "85",
  "Width (cm)": "42",
  "width_cm": "42",
  "width": "42",
  "Height (cm)": "36",
  "height_cm": "36",
  "height": "36",
  "Pack. Unit CBM": "0.128520",
  "Packaging Unit CBM": "0.128520",
  "packaging_unit_cbm": "0.128520",
  "Refund VAT %": "13",
  "refund_vat_percent": "13",
  "Compliance & License Requirements": "Import Certificate",
  "license_certificate_required": "Import Certificate",
  "Specification": "Standard 220V Motor, 50Hz, Teflon Sealing Belt",
  "specification": "Standard 220V Motor, 50Hz, Teflon Sealing Belt",
  "Description": "High speed continuous band sealer",
  "description": "High speed continuous band sealer",
  "Status": "active",
  "Status (active/inactive)": "active",
  "status": "active",
  "Company Name": "Yinglima Packaging Machinery Co., Ltd.",
  "company_name": "Yinglima Packaging Machinery Co., Ltd.",
  "Country": "China",
  "State": "Zhejiang",
  "City": "Wenzhou",
};

/** Lookup realistic sample value or deduce clean fallback. */
function sampleValueFor(header: ImportHeader): string {
  const key = header.key || header.label || "";
  if (REALISTIC_SAMPLES[key]) return REALISTIC_SAMPLES[key];
  if (header.label && REALISTIC_SAMPLES[header.label]) return REALISTIC_SAMPLES[header.label];

  const k = key.toLowerCase();
  if (k.includes("code")) return "SAMPLE-001";
  if (k.includes("name")) return "Sample Name";
  if (k.includes("status")) return "active";
  if (k.includes("quantity") || k.includes("qty")) return "1";
  if (k.includes("weight")) return "10.0";
  if (k.includes("price") || k.includes("cost")) return "100.00";
  if (k.includes("percent") || k.includes("vat") || k.includes("gst")) return "18";
  return "Sample Value";
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function downloadSampleTemplate(importHeaders: ImportHeader[], entityName: string): void {
  const headerLine = importHeaders.map((h) => csvEscape(h.key)).join(",");
  const sampleLine = importHeaders.map((h) => csvEscape(sampleValueFor(h))).join(",");
  const csvContent = `${headerLine}\n${sampleLine}\n`;

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `Sample_${entityName.replace(/\s+/g, "_")}_Template.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
