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
  "Product Categories": "Machines",
  "Key Strength Sub-Categories": "Band Sealer",
  "Products Supplied": "FR900 Continuous Band Sealer",
  "Secondary Products": "Vacuum packaging machines, sealing spare parts",
  "Country": "China",
  "country_code": "China",
  "State / Province": "Zhejiang",
  "state_name": "Zhejiang",
  "City": "Wenzhou",
  "city_name": "Wenzhou",
  "Brand Description": "Manufacturer of industrial packaging and sealing machinery",
  "brand_description": "Manufacturer of industrial packaging and sealing machinery",
  "Supplier Type": "Manufacturer",
  "supplier_type": "manufacturer",
  "Current Status": "Existing",
  "current_status": "existing",
  "Supplier Grade": "Grade A",
  "supplier_grade": "A",
  "Potential": "Yes",
  "potential": "yes",
  "Potential Reason": "Direct factory pricing and rapid spare parts availability",
  "potential_reason": "Direct factory pricing and rapid spare parts availability",
  "Contact Person": "Zhang Wei",
  "contact_full_name": "Zhang Wei",
  "Designation": "Sales Director",
  "contact_designation": "Sales Director",
  "Calling Number": "+86 577 8888 1234",
  "contact_calling_number": "+86 577 8888 1234",
  "WhatsApp Number": "+86 138 0000 1234",
  "contact_whatsapp_number": "+86 138 0000 1234",
  "WeChat Number": "yinglima_sales",
  "contact_wechat_number": "yinglima_sales",
  "Emails": "sales@yinglima.com",
  "email": "sales@yinglima.com",
  "Tax ID / GST Number": "91330300MA2XXXXX",
  "tax_id_number": "91330300MA2XXXXX",
  "Address": "No. 88 Industrial Avenue, Ouhai District",
  "address": "No. 88 Industrial Avenue, Ouhai District",
  "Town": "Ouhai",
  "town": "Ouhai",
  "Primary Website": "https://www.yinglima.com",
  "primary_website": "https://www.yinglima.com",
  "Secondary Website": "https://yinglima.en.alibaba.com",
  "secondary_website": "https://yinglima.en.alibaba.com",
  "Visited Factory/Office": "Yes",
  "visited_factory_office": "true",
  "Visit Remarks": "Visited factory in October 2025; excellent quality control lines.",
  "visit_remarks": "Visited factory in October 2025; excellent quality control lines.",
  "Overall Remarks": "Top-tier supplier for sealing equipment.",
  "overall_remarks": "Top-tier supplier for sealing equipment.",
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
