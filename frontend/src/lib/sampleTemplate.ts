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

/** Same keyword heuristic as the source: guess a plausible filler value from the field's key/label. */
function sampleValueFor(header: ImportHeader): string {
  const k = (header.key || header.label || "").toLowerCase();
  if (k.includes("code")) return "SAMPLE-001";
  if (k.includes("name")) return "Sample Name";
  if (k.includes("status")) return "active";
  if (
    k.includes("quantity") ||
    k.includes("weight") ||
    k.includes("price") ||
    k.includes("cost") ||
    k.includes("percent")
  ) {
    return "10";
  }
  return "Sample Data";
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
