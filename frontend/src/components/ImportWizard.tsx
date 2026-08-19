/**
 * ImportWizard -- shared column-mapping import flow for every page that
 * imports CSV/Excel data (all Master Data pages + Suppliers).
 *
 * Flow (matches the familiar Bitrix24 / typical ERP import pattern):
 *   1. User picks a file (.csv or .xlsx).
 *   2. The header row and every data row are parsed entirely in the browser
 *      (no upload yet) using PapaParse (CSV) or SheetJS (XLSX).
 *   3. A modal shows every target field this module accepts, each with a
 *      <select> pre-filled with our best-guess match against the uploaded
 *      sheet's own column names (case/spacing/punctuation-insensitive, plus
 *      common synonyms). The user can override any mapping.
 *   4. A live preview table shows the first few rows re-mapped into target
 *      columns, so correctness can be eyeballed before committing.
 *   5. On "Import", every row from the *entire* file is remapped into the
 *      target header order, encoded back into a CSV blob client-side, and
 *      POSTed to the existing `${apiBase}/import` endpoint -- so the backend's
 *      row validators (which already key off these exact header names) need no
 *      changes. Uploads go in fixed-size chunks so progress stays accurate.
 *   6. While the request is in flight a spinner + "Importing..." state shows;
 *      when it resolves the created/failed/duplicate summary renders.
 *
 * Ported from import-wizard.js. The two parser libraries were previously
 * injected from a CDN on first use; they are now npm dependencies loaded via
 * dynamic import(), which keeps them out of the initial bundle exactly as the
 * lazy CDN load did, but without the third-party runtime dependency.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, isAbortError, errorMessage } from "@/lib/api";
import { Auth } from "@/lib/auth";
import { useBodyScrollLock } from "@/lib/hooks";
import type {
  ColumnMapping,
  ImportDuplicate,
  ImportHeader,
  ImportSummary,
  InFileDuplicate,
  SheetRow,
} from "@/types";

export type { ColumnMapping, ImportDuplicate, ImportHeader, ImportSummary, InFileDuplicate, SheetRow };

/* ------------------------------------------------------------------ */
/* Header name normalization + fuzzy auto-match                        */
/* ------------------------------------------------------------------ */

function normalize(str: unknown): string {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Common synonym groups so e.g. a sheet column called "Item Code" auto-maps to
 * our target field "product_code", "SKU" maps too, etc. Each target field key
 * maps to extra normalized phrases (beyond its own label/key) that should also
 * count as a match.
 */
const SYNONYMS: Record<string, string[]> = {
  product_code: ["sku", "item code", "item no", "part number", "part no"],
  product_name: ["item name", "title", "product title"],
  company_name: ["supplier name", "vendor name", "name of company", "business name"],
  category_code: ["category", "product category"],
  sub_category_code: ["subcategory", "sub category", "sub cat"],
  brand_code: ["brand", "manufacturer"],
  hsn_code: ["hsn", "hsn/sac", "hsn code", "tax code"],
  uom_code: ["uom", "unit", "unit of measurement", "measure"],
  secondary_uom_code: ["secondary uom", "alt unit", "alternate unit"],
  country_code: ["country", "iso code"],
  state_name: ["state", "province"],
  city_name: ["city"],
  gst_percent: ["gst", "tax percent", "gst rate", "tax rate"],
  contact_calling_number: ["phone", "phone number", "mobile", "contact number", "tel"],
  contact_whatsapp_number: ["whatsapp", "whatsapp number"],
  contact_wechat_number: ["wechat", "wechat id"],
  contact_full_name: ["contact name", "contact person", "poc"],
  contact_designation: ["designation", "job title", "title"],
  email: ["email address", "e mail", "mail"],
  tax_id_number: ["tax id", "gstin", "vat number", "tax number"],
  primary_website: ["website", "url", "web site"],
  standard_cost: ["cost", "unit cost", "purchase price"],
  standard_price: ["price", "selling price", "unit price", "mrp"],
  minimum_order_quantity: ["moq", "min order qty", "min qty"],
  reorder_level: ["reorder point", "reorder qty"],
};

/**
 * Given one target field { key, label } and the list of actual sheet column
 * names, return the best-guess sheet column name, or null.
 */
function bestMatch(target: ImportHeader, sheetColumns: string[]): string | null {
  const candidates = new Set([normalize(target.key), normalize(target.label)]);
  (SYNONYMS[target.key] || []).forEach((s) => candidates.add(normalize(s)));

  // 1. exact normalized match
  for (const col of sheetColumns) {
    if (candidates.has(normalize(col))) return col;
  }
  // 2. substring match either direction
  for (const col of sheetColumns) {
    const normCol = normalize(col);
    for (const cand of candidates) {
      if (!cand) continue;
      if (normCol.includes(cand) || cand.includes(normCol)) return col;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* File parsing                                                       */
/* ------------------------------------------------------------------ */

async function parseCsvFile(file: File): Promise<SheetRow[]> {
  const { default: Papa } = await import("papaparse");
  return new Promise((resolve, reject) => {
    Papa.parse<SheetRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results.data),
      error: (err) => reject(err),
    });
  });
}

async function parseXlsxFile(file: File): Promise<SheetRow[]> {
  const XLSX = await import("xlsx");
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json<SheetRow>(sheet, { defval: "" });
}

async function parseFile(file: File): Promise<SheetRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsvFile(file);
  if (lower.endsWith(".xlsx")) return parseXlsxFile(file);
  throw new Error("Unsupported file type. Please upload a .csv or .xlsx file.");
}

/* ------------------------------------------------------------------ */
/* Remap parsed rows into target headers, build a CSV blob            */
/* ------------------------------------------------------------------ */

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildRemappedCsv(
  rows: SheetRow[],
  mapping: ColumnMapping,
  importHeaders: ImportHeader[]
): Blob {
  const headerLine = importHeaders.map((h) => csvEscape(h.key)).join(",");
  const lines = [headerLine];
  for (const row of rows) {
    const cells = importHeaders.map((h) => {
      const sourceCol = mapping[h.key];
      if (!sourceCol) return "";
      return csvEscape(row[sourceCol]);
    });
    lines.push(cells.join(","));
  }
  return new Blob([lines.join("\n")], { type: "text/csv" });
}

/* ------------------------------------------------------------------ */
/* Chunked upload with live "X of Y rows" progress                    */
/* ------------------------------------------------------------------ */

/** Rows per request -- frequent enough for live progress, large enough to stay fast. */
const CHUNK_SIZE = 250;

async function uploadChunk(
  rowsChunk: SheetRow[],
  mapping: ColumnMapping,
  apiBase: string,
  importHeaders: ImportHeader[],
  signal: AbortSignal
): Promise<ImportSummary> {
  const csvBlob = buildRemappedCsv(rowsChunk, mapping, importHeaders);
  const formData = new FormData();
  formData.append("file", csvBlob, "import.csv");

  const token = Auth.getAccessToken();
  const res = await fetch(`${API_BASE}${apiBase}/import`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
    signal,
  });
  const body = await res.json();
  if (!res.ok || body.success === false) {
    throw new Error(body.message || "Import failed.");
  }
  return body.data as ImportSummary;
}

function mergeSummaries(
  target: ImportSummary,
  chunkSummary: ImportSummary,
  /**
   * Maps a row's 1-indexed position *within this chunk's uploaded CSV*
   * (2 = first data row, matching the backend's convention where row 1 is
   * the header) to its true 1-indexed row number in the *original uploaded
   * file*. Needed because deduping removes rows before chunking, so chunk
   * position no longer lines up with original file position via a simple
   * offset.
   */
  chunkRowToOriginalRow: (chunkRow: number) => number
): void {
  target.total_rows += chunkSummary.total_rows || 0;
  target.created += chunkSummary.created || 0;
  target.failed += chunkSummary.failed || 0;
  target.duplicate_count += chunkSummary.duplicate_count || 0;
  // Row numbers inside each chunk's summary are 1-indexed *within that chunk's
  // own CSV* (row 1 = header, row 2 = first data row) -- map them back to the
  // row's true position in the original uploaded file so error/duplicate
  // messages point at the right row.
  for (const err of chunkSummary.errors || []) {
    target.errors.push({ ...err, row: chunkRowToOriginalRow(err.row) });
  }
  for (const dup of chunkSummary.duplicates || []) {
    target.duplicates.push({ ...dup, row: chunkRowToOriginalRow(dup.row) });
  }
}

/* ------------------------------------------------------------------ */
/* Duplicate detection UI helpers                                     */
/* ------------------------------------------------------------------ */

/**
 * Pick the best human-readable label for one row's data, trying common
 * "name-like" fields in priority order. Returns null if nothing recognizable is
 * found (e.g. a module with unusual field names), so callers can fall back to
 * the row number.
 */
function labelForRow(rowData?: Record<string, unknown>): string | null {
  if (!rowData) return null;
  const candidates = [
    "company_name",
    "product_name",
    "name",
    "title",
    "display_name",
    "person_name",
    "code",
    "product_code",
    "employee_code",
  ];
  for (const key of candidates) {
    if (rowData[key]) return String(rowData[key]);
  }
  return null;
}

/**
 * Find an identifying code for a row if the module exposes one (some modules
 * key duplicates by a serial/code rather than a name) -- used to phrase
 * "<code> in your file matches <code> in the system" when both sides have one.
 */
function idLabelForRow(rowData?: Record<string, unknown> | null): string | null {
  if (!rowData) return null;
  const candidates = ["product_code", "code", "employee_code"];
  for (const key of candidates) {
    if (rowData[key]) return String(rowData[key]);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* In-file duplicate detection (client-side, pre-chunking)             */
/* ------------------------------------------------------------------ */

/**
 * Candidate identity fields, in priority order, used to decide whether two
 * rows in the *same uploaded file* represent the same record. Composite keys
 * (e.g. a city's name + country + state) are built from every candidate that
 * is both a target field the current module accepts (present in
 * `importHeaders`) and actually mapped to a source column -- so this stays
 * generic across every master page without per-module configuration here.
 *
 * Order matters: a code-like field alone is usually enough to identify a
 * record, so it's checked first; name-like fields are combined with whatever
 * "scoping" fields (country/state/category) are present so that e.g. two
 * different countries' "Central" state don't collide.
 */
const IDENTITY_FIELD_GROUPS: string[][] = [
  ["product_code"],
  ["code", "category_code"], // sub-categories: code is only unique within a category
  ["code"],
  ["company_name", "country_code", "state_name", "city_name"], // suppliers
  ["name", "country_code", "state_name"], // cities
  ["name", "country_code"], // states
  ["name"],
];

/**
 * Pick the best identity field group for this module: the first group in
 * priority order where every field is both a valid target header and mapped
 * to a source column. Falls back to null (no in-file dedup) if nothing
 * usable is found, rather than guessing with partial/unmapped fields.
 */
function pickIdentityFields(importHeaders: ImportHeader[], mapping: ColumnMapping): string[] | null {
  const validKeys = new Set(importHeaders.map((h) => h.key));
  for (const group of IDENTITY_FIELD_GROUPS) {
    if (group.every((k) => validKeys.has(k) && !!mapping[k])) {
      return group;
    }
  }
  return null;
}

/** Normalize a cell value for duplicate comparison: trim + case-insensitive. */
function normalizeKeyValue(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

interface DedupeResult {
  keptRows: SheetRow[];
  /** Parallel to `keptRows`: the original index (in the pre-dedupe row list) of each kept row. */
  keptOriginalIndexes: number[];
  duplicates: InFileDuplicate[];
}

/**
 * Scan every parsed row (before chunking) and drop rows whose identity
 * (per `pickIdentityFields`) matches an earlier row already kept. Rows
 * missing any identity field value are never deduped -- they pass through
 * untouched, same as the backend's behavior for consistency.
 *
 * This has to run client-side, before the file is split into upload chunks:
 * large files are uploaded in separate requests (see `CHUNK_SIZE` below), so
 * two duplicate rows could otherwise land in different chunks and both get
 * created, since each chunk is validated independently on the server.
 */
function dedupeRowsInFile(
  rows: SheetRow[],
  mapping: ColumnMapping,
  identityFields: string[] | null
): DedupeResult {
  if (!identityFields) {
    return { keptRows: rows, keptOriginalIndexes: rows.map((_, i) => i), duplicates: [] };
  }

  const seen = new Map<string, number>(); // composite key -> 1-indexed file row of first occurrence (header = row 1)
  const keptRows: SheetRow[] = [];
  const keptOriginalIndexes: number[] = [];
  const duplicates: InFileDuplicate[] = [];

  rows.forEach((row, index) => {
    const fileRow = index + 2; // row 1 is the header
    const values = identityFields.map((field) => {
      const sourceCol = mapping[field];
      return sourceCol ? normalizeKeyValue(row[sourceCol]) : "";
    });

    if (values.some((v) => v === "")) {
      // Missing an identity field -- don't dedupe this row, let normal
      // validation catch it (it may be a genuine validation error, or a
      // module where the field is optional).
      keptRows.push(row);
      keptOriginalIndexes.push(index);
      return;
    }

    const key = values.join("\u0001");
    const firstRow = seen.get(key);
    if (firstRow !== undefined) {
      duplicates.push({ row: fileRow, row_data: row, matchedRow: firstRow });
      return;
    }
    seen.set(key, fileRow);
    keptRows.push(row);
    keptOriginalIndexes.push(index);
  });

  return { keptRows, keptOriginalIndexes, duplicates };
}

interface DiffRow {
  key: string;
  aStr: string;
  bStr: string;
  differs: boolean;
}

const CANONICAL_FIELD_LABELS: Record<string, string> = {
  productnametally: "Product Name (As per Tally)",
  productname: "Product Name",
  productnameinvoice: "Product Name (Invoice)",
  productcode: "Product Code",
  brand: "Brand",
  category: "Category",
  subcategory: "Sub Category",
  hsn: "HSN Code",
  hsncode: "HSN Code",
  uom: "UOM",
  secondaryuom: "Secondary UOM",
  packqty: "Packaging Quantity",
  packagingquantity: "Packaging Quantity",
  packnetweight: "Packaging Net Weight (kg)",
  packagingnetweight: "Packaging Net Weight (kg)",
  packgrossweight: "Packaging Gross Weight (kg)",
  packaginggrossweight: "Packaging Gross Weight (kg)",
  lengthcm: "Length (cm)",
  length: "Length (cm)",
  widthcm: "Width (cm)",
  width: "Width (cm)",
  heightcm: "Height (cm)",
  height: "Height (cm)",
  packunitcbm: "Packaging Unit CBM",
  packagingunitcbm: "Packaging Unit CBM",
  refundvat: "Refund VAT %",
  refundvatpercent: "Refund VAT %",
  compliancelicense: "Compliance & License Requirements",
  licensecertificaterequired: "Compliance & License Requirements",
  specification: "Specification",
  description: "Description",
  color: "Color",
  material: "Material",
  status: "Status",
  isactive: "Status",
  companyname: "Company Name",
  country: "Country",
  countrycode: "Country",
  state: "State / Province",
  statename: "State / Province",
  city: "City",
  cityname: "City",
  town: "Town",
  address: "Address",
  taxidnumber: "Tax ID Number",
  website: "Website",
  primarywebsite: "Primary Website",
  secondarywebsite: "Secondary Website",
  personname: "Contact Name",
  fullname: "Contact Name",
  contactfullname: "Contact Name",
  designation: "Designation",
  contactdesignation: "Designation",
  callingnumber: "Calling Number",
  contactcallingnumber: "Calling Number",
  whatsappnumber: "WhatsApp Number",
  contactwhatsappnumber: "WhatsApp Number",
  wechatnumber: "WeChat Number",
  contactwechatnumber: "WeChat Number",
  email: "Email",
  emails: "Email(s)",
  potential: "Potential",
  potentialreason: "Potential Reason",
  buyergrade: "Buyer Grade",
  suppliergrade: "Supplier Grade",
  currentstatus: "Current Status",
};

function normalizeKey(k: string): string {
  return k
    .toLowerCase()
    .replace(/[\s\-_()./&%?]/g, "")
    .replace(/^(pack|packaging)/, "pack")
    .replace(/^contact/, "")
    .replace(/id$/, "");
}

function prettifyRawKey(k: string): string {
  return k
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Active" : "Inactive";
  if (Array.isArray(v)) {
    if (!v.length) return "—";
    return v.join(", ");
  }
  const s = String(v).trim();
  return s ? s : "—";
}

function fieldDiffRows(
  importedRow: Record<string, unknown>,
  existingRow: Record<string, unknown>
): DiffRow[] {
  // Skip internal or technical metadata columns that clutter duplicate comparisons
  const skipNormalized = new Set([
    "id",
    "createdat",
    "updatedat",
    "deletedat",
    "version",
    "organizationidsjson",
    "branchidsjson",
    "imagesjson",
    "imageurl",
    "categorylinks",
    "subcategorylinks",
    "productlinks",
    "subcategories",
  ]);

  const unifiedFields = new Map<string, { label: string; aVal: unknown; bVal: unknown }>();

  // Process importedRow (uploaded file headers)
  for (const [key, val] of Object.entries(importedRow || {})) {
    const norm = normalizeKey(key);
    if (skipNormalized.has(norm)) continue;
    const label = CANONICAL_FIELD_LABELS[norm] || prettifyRawKey(key);
    const existing = unifiedFields.get(norm);
    if (existing) {
      existing.aVal = val;
    } else {
      unifiedFields.set(norm, { label, aVal: val, bVal: undefined });
    }
  }

  // Process existingRow (database columns)
  for (const [key, val] of Object.entries(existingRow || {})) {
    const norm = normalizeKey(key);
    if (skipNormalized.has(norm)) continue;
    const label = CANONICAL_FIELD_LABELS[norm] || prettifyRawKey(key);
    const existing = unifiedFields.get(norm);
    if (existing) {
      existing.bVal = val;
    } else {
      unifiedFields.set(norm, { label, aVal: undefined, bVal: val });
    }
  }

  const rows: DiffRow[] = [];
  for (const [, field] of unifiedFields) {
    const aStr = formatVal(field.aVal);
    const bStr = formatVal(field.bVal);
    // Don't show rows where both sides are blank
    if (aStr === "—" && bStr === "—") continue;
    const differs = aStr.toLowerCase() !== bStr.toLowerCase();
    rows.push({
      key: field.label,
      aStr,
      bStr,
      differs,
    });
  }

  // Differing fields first
  rows.sort((a, b) => Number(b.differs) - Number(a.differs));
  return rows;
}

function DuplicateCompareModal({
  duplicate,
  onClose,
}: {
  duplicate: ImportDuplicate;
  onClose: () => void;
}) {
  useBodyScrollLock(true);

  const importedRow = duplicate.row_data || {};
  const existingRow = duplicate.existing || null;
  const importedLabel = labelForRow(importedRow) || `Row ${duplicate.row}`;
  const existingLabel = existingRow ? labelForRow(existingRow) || "Existing record" : null;
  const importedIdLabel = idLabelForRow(importedRow);
  const existingIdLabel = existingRow ? idLabelForRow(existingRow) : null;
  const diffRows = existingRow ? fieldDiffRows(importedRow, existingRow) : [];

  return (
    <div
      className="modal-backdrop iw-compare-backdrop"
      style={{ display: "flex" }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card iw-compare-card">
        <div className="modal-header">
          <h2>Duplicate Comparison</h2>
          <button type="button" className="modal-close" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="iw-compare-match-note">
          {importedIdLabel && existingIdLabel ? (
            <>
              Row {duplicate.row} in your file (<b>{importedIdLabel}</b>) matches an existing
              record with the same identifier (<b>{existingIdLabel}</b>) already in the system.
            </>
          ) : (
            <>
              Row {duplicate.row} in your file matches an existing record already in the
              system.
            </>
          )}
        </div>

        {existingRow ? (
          <div className="table-scroll iw-compare-scroll">
            <table className="iw-compare-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Your file ({importedLabel})</th>
                  <th>Already in system ({existingLabel})</th>
                </tr>
              </thead>
              <tbody>
                {diffRows.map((r) => (
                  <tr key={r.key} className={r.differs ? "iw-diff-row" : ""}>
                    <td className="iw-diff-key">{r.key}</td>
                    <td>{r.aStr}</td>
                    <td>{r.bStr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="muted" style={{ padding: "var(--space-3) 0" }}>
            The existing record's details weren't available to compare, but this row was
            skipped because it duplicates something already in the system.
          </div>
        )}

        <div className="form-actions">
          <div style={{ flex: 1 }} />
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Import summary panel                                               */
/* ------------------------------------------------------------------ */

export function ImportSummaryPanel({
  summary,
  error,
}: {
  summary?: ImportSummary | null;
  error?: string | null;
}) {
  const [compareDuplicate, setCompareDuplicate] = useState<ImportDuplicate | null>(null);

  if (error) {
    return (
      <div className="import-summary">
        <span style={{ color: "var(--color-danger)" }}>{error}</span>
      </div>
    );
  }

  if (!summary) return null;

  const duplicates = summary.duplicates || [];
  const inFileDuplicates = summary.in_file_duplicates || [];
  const errors = summary.errors || [];

  return (
    <>
      <div className="import-summary">
        <div className="import-stats">
          <div className="import-stat">
            <b>{summary.total_rows}</b>
            <span className="muted">Total rows</span>
          </div>
          <div className="import-stat">
            <b style={{ color: "var(--color-success)" }}>{summary.created}</b>
            <span className="muted">Created</span>
          </div>
          <div className="import-stat">
            <b style={{ color: "var(--color-danger)" }}>{summary.failed}</b>
            <span className="muted">Failed</span>
          </div>
          {summary.duplicate_count ? (
            <div className="import-stat">
              <b style={{ color: "var(--color-danger)" }}>{summary.duplicate_count}</b>
              <span className="muted">Duplicates</span>
            </div>
          ) : null}
          {inFileDuplicates.length > 0 ? (
            <div className="import-stat">
              <b style={{ color: "var(--color-warning)" }}>{inFileDuplicates.length}</b>
              <span className="muted">Duplicate rows in file</span>
            </div>
          ) : null}
        </div>

        {/* Rows that duplicate an earlier row in the *same uploaded file* --
            distinct from `duplicates` above (which collided with a record
            already in the database). These were never sent to the server at
            all, so they're a warning about the file itself, not a rejection. */}
        {inFileDuplicates.length > 0 && (
          <div className="import-duplicates-banner import-infile-duplicates-banner">
            <div className="import-duplicates-header">
              ⚠ {inFileDuplicates.length} row{inFileDuplicates.length > 1 ? "s" : ""} in your file
              duplicated an earlier row in the same file, so{" "}
              {inFileDuplicates.length > 1 ? "they were" : "it was"} ignored and not imported.
            </div>
            <div className="import-duplicates-list">
              {inFileDuplicates.map((dup, index) => (
                <div className="iw-dup-chip iw-dup-chip-static" key={`infile-${dup.row}-${index}`}>
                  <span className="iw-dup-name">
                    {labelForRow(dup.row_data) || `Row ${dup.row}`}
                  </span>
                  <span className="iw-dup-hint">
                    Row {dup.row}
                    {dup.matchedRow ? ` \u00b7 same as row ${dup.matchedRow}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Generic validation failures stay plain text lines; duplicates get
            their own red banner with per-row compare buttons, since "this row
            is invalid" and "this row already exists" call for different
            follow-up actions. */}
        {duplicates.length > 0 && (
          <div className="import-duplicates-banner">
            <div className="import-duplicates-header">
              ⚠ {duplicates.length} record{duplicates.length > 1 ? "s" : ""} already existed
              and {duplicates.length > 1 ? "were" : "was"} skipped during import
            </div>
            <div className="import-duplicates-list">
              {duplicates.map((dup, index) => (
                <button
                  type="button"
                  className="iw-dup-chip"
                  key={`${dup.row}-${index}`}
                  onClick={() => setCompareDuplicate(dup)}
                >
                  <span className="iw-dup-name">
                    {labelForRow(dup.row_data) || `Row ${dup.row}`}
                  </span>
                  <span className="iw-dup-hint">Row {dup.row} &middot; compare →</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {errors.length > 0 && (
          <div className="import-errors">
            {errors.map((er, i) => (
              <div key={`${er.row}-${i}`}>
                Row {er.row}: {er.error}
              </div>
            ))}
          </div>
        )}
      </div>

      {compareDuplicate && (
        <DuplicateCompareModal
          duplicate={compareDuplicate}
          onClose={() => setCompareDuplicate(null)}
        />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* The wizard modal                                                   */
/* ------------------------------------------------------------------ */

interface WizardModalProps {
  file: File;
  rows: SheetRow[];
  sheetColumns: string[];
  apiBase: string;
  entityName: string;
  importHeaders: ImportHeader[];
  onClose: () => void;
  onComplete: (summary: ImportSummary | null) => void;
  onError: (message: string) => void;
}

function WizardModal({
  file,
  rows,
  sheetColumns,
  apiBase,
  entityName,
  importHeaders,
  onClose,
  onComplete,
  onError,
}: WizardModalProps) {
  useBodyScrollLock(true);

  const [mapping, setMapping] = useState<ColumnMapping>(() => {
    const initial: ColumnMapping = {};
    for (const h of importHeaders) {
      initial[h.key] = bestMatch(h, sheetColumns);
    }
    return initial;
  });
  const [importing, setImporting] = useState(false);
  const [progressText, setProgressText] = useState("Importing...");
  const [progressPercent, setProgressPercent] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      if (abortRef.current) abortRef.current.abort();
    },
    []
  );

  const missingRequired = useMemo(
    () => importHeaders.filter((h) => h.required && !mapping[h.key]),
    [importHeaders, mapping]
  );
  const canImport = missingRequired.length === 0;

  const previewRows = rows.slice(0, 5);
  const rowLabel = `${rows.length} row${rows.length === 1 ? "" : "s"}`;

  /**
   * Uploads rows in fixed-size chunks (sequentially, so progress reporting
   * stays accurate and the backend never receives more than CHUNK_SIZE rows per
   * request). Returns one aggregated summary identical in shape to what a
   * single-shot import would have returned -- duplicates/errors from every
   * chunk are preserved with corrected row numbers.
   *
   * Before chunking, rows are deduped against each other using whatever
   * identity fields this module has mapped (see `pickIdentityFields`): a
   * later row that exactly matches an earlier row already seen in this file
   * is skipped and reported as an in-file duplicate rather than uploaded.
   * This has to happen before the file is split into chunks -- two
   * duplicate rows landing in different chunks would otherwise both be
   * validated (and created) independently by the server, since each chunk
   * request is unaware of the others.
   */
  const runChunkedImport = useCallback(
    async (signal: AbortSignal): Promise<ImportSummary> => {
      const identityFields = pickIdentityFields(importHeaders, mapping);
      const { keptRows, keptOriginalIndexes, duplicates: inFileDuplicates } = dedupeRowsInFile(
        rows,
        mapping,
        identityFields
      );

      const aggregated: ImportSummary = {
        total_rows: rows.length,
        created: 0,
        failed: inFileDuplicates.length,
        duplicate_count: 0,
        errors: [],
        duplicates: [],
        in_file_duplicate_count: inFileDuplicates.length,
        in_file_duplicates: inFileDuplicates,
      };

      const total = keptRows.length;
      if (total === 0) {
        setProgressPercent(100);
        setProgressText("Done!");
        return aggregated;
      }

      // Maps a chunk-local row number (2 = first data row in that chunk's
      // CSV) back to the true row number in the original uploaded file, via
      // the kept row's original index (offset by the chunk's start position
      // in the deduped array, then looked up in keptOriginalIndexes).
      function makeRowMapper(chunkStart: number) {
        return (chunkRow: number): number => {
          const keptIndex = chunkStart + (chunkRow - 2); // chunkRow 2 -> first row of this chunk
          const originalIndex = keptOriginalIndexes[keptIndex];
          // originalIndex is 0-indexed into `rows`; file row numbers start at 2 (row 1 = header).
          return originalIndex !== undefined ? originalIndex + 2 : chunkRow;
        };
      }

      if (total <= CHUNK_SIZE) {
        setProgressText(`Uploading ${total} row${total === 1 ? "" : "s"}...`);
        setProgressPercent(40);
        const chunkSummary = await uploadChunk(keptRows, mapping, apiBase, importHeaders, signal);
        setProgressPercent(100);
        setProgressText(`Imported ${total} of ${total} row${total === 1 ? "" : "s"}`);
        mergeSummaries(aggregated, chunkSummary, makeRowMapper(0));
        return aggregated;
      }

      let uploaded = 0;
      for (let start = 0; start < total; start += CHUNK_SIZE) {
        const chunk = keptRows.slice(start, start + CHUNK_SIZE);
        const chunkSummary = await uploadChunk(chunk, mapping, apiBase, importHeaders, signal);
        mergeSummaries(aggregated, chunkSummary, makeRowMapper(start));
        uploaded += chunk.length;

        const percent = Math.round((uploaded / total) * 100);
        setProgressPercent(percent);
        setProgressText(`Imported ${uploaded} of ${total} rows (${percent}%)`);
      }

      return aggregated;
    },
    [rows, mapping, apiBase, importHeaders]
  );

  async function handleImport() {
    if (!canImport) return;
    setImporting(true);
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const summary = await runChunkedImport(controller.signal);
      setProgressText("Done!");
      onClose();
      onComplete(summary);
    } catch (err) {
      if (isAbortError(err)) {
        // Cancelled mid-import: chunks already created remain created, so the
        // caller still refreshes its table to reflect them.
        onComplete(null);
        return;
      }
      setImporting(false);
      setProgressPercent(0);
      onError(errorMessage(err) || "Import failed.");
    }
  }

  /**
   * Cancel always works, even mid-import: abort the in-flight request, then
   * close. Whatever chunks already completed have already been created
   * server-side -- cancelling stops further chunks from being sent, it does not
   * roll back completed ones.
   */
  function handleCancel() {
    if (abortRef.current) abortRef.current.abort();
    onClose();
    if (importing) onComplete(null);
  }

  return (
    <div
      className={`modal-backdrop import-wizard-backdrop ${importing ? "iw-locked" : ""}`.trim()}
      style={{ display: "flex" }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !importing) onClose();
      }}
    >
      <div
        className="modal-card import-wizard-card"
        style={{
          maxWidth: "880px",
          width: "90vw",
          display: "flex",
          flexDirection: "column",
          height: "100vh",
          maxHeight: "100vh",
          overflow: "hidden",
        }}
      >
        <div className="modal-header" style={{ flexShrink: 0 }}>
          <h2>Import {entityName} &mdash; Map Columns</h2>
          <button
            type="button"
            className="modal-close"
            disabled={importing}
            onClick={() => {
              if (!importing) onClose();
            }}
          >
            &times;
          </button>
        </div>

        {/* Scrollable Center Body */}
        <div
          className="iw-modal-body"
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "20px 24px",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            gap: "16px",
          }}
        >
          <div className="iw-file-info" style={{ margin: 0 }}>
            <span className="iw-file-name">📄 {file.name}</span>
            <span className="muted">{rowLabel} detected</span>
          </div>

          <div className="iw-mapping-section" style={{ margin: 0 }}>
            <div className="section-title">Match your columns</div>
            <div className="muted" style={{ marginBottom: "var(--space-2)" }}>
              We've auto-matched what we could recognize. Review each field below and adjust any
              dropdown that isn't right.
            </div>
            <div className="iw-mapping-table">
              {importHeaders.map((h) => (
                <div className="iw-mapping-row" key={h.key}>
                  <div className="iw-target-field">
                    <span className="iw-target-label">{h.label}</span>
                    {h.required && <span className="iw-required">*</span>}
                    <span className="iw-target-key">{h.key}</span>
                  </div>
                  <div className="iw-arrow">→</div>
                  <select
                    className="iw-source-select"
                    value={mapping[h.key] || ""}
                    disabled={importing}
                    onChange={(e) =>
                      setMapping((prev) => ({ ...prev, [h.key]: e.target.value || null }))
                    }
                  >
                    <option value="">— Don't import —</option>
                    {sheetColumns.map((col) => (
                      <option key={col} value={col}>
                        {col}
                      </option>
                    ))}
                  </select>
                  <span
                    className={`iw-match-badge ${
                      mapping[h.key] ? "iw-match-auto" : "iw-match-none"
                    }`}
                  >
                    {mapping[h.key] ? "Matched" : h.required ? "Required" : "Optional"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="iw-preview-section" style={{ margin: 0 }}>
            <div className="section-title">Preview (first 5 rows)</div>
            <div className="table-scroll iw-preview-scroll">
              <table className="iw-preview-table">
                <thead>
                  <tr>
                    {importHeaders.map((h) => (
                      <th key={h.key}>{h.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewRows.length === 0 ? (
                    <tr>
                      <td colSpan={importHeaders.length} className="muted">
                        No rows to preview.
                      </td>
                    </tr>
                  ) : (
                    previewRows.map((row, i) => (
                      <tr key={i}>
                        {importHeaders.map((h) => {
                          const sourceCol = mapping[h.key];
                          const val = sourceCol ? row[sourceCol] : "";
                          return (
                            <td key={h.key}>
                              {val === undefined || val === null || val === "" ? (
                                <span className="muted">—</span>
                              ) : (
                                String(val)
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {importing && (
            <div className="iw-progress" style={{ display: "flex" }}>
              <div className="iw-progress-row">
                <div className="iw-spinner" />
                <span>{progressText}</span>
              </div>
              <div className="iw-progress-track">
                <div className="iw-progress-bar" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}
        </div>

        {/* Fixed Sticky Footer */}
        <div
          className="form-actions iw-actions"
          style={{
            flexShrink: 0,
            padding: "16px 24px",
            background: "#ffffff",
            borderTop: "1px solid #e2e8f0",
            display: "flex",
            alignItems: "center",
            gap: "12px",
            margin: 0,
          }}
        >
          <span className="muted">
            {missingRequired.length > 0 && (
              <span style={{ color: "var(--color-danger)" }}>
                ⚠ Required field{missingRequired.length > 1 ? "s" : ""} not mapped:{" "}
                {missingRequired.map((h) => h.label).join(", ")}
              </span>
            )}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="btn" onClick={handleCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canImport || importing}
            onClick={handleImport}
          >
            {importing ? "Importing..." : `Import ${rowLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Public: the Import button + wizard                                 */
/* ------------------------------------------------------------------ */

export interface ImportButtonProps {
  apiBase: string;
  entityName: string;
  importHeaders: ImportHeader[];
  onComplete: (summary: ImportSummary | null) => void;
  onSummary: (summary: ImportSummary | null) => void;
  onError: (message: string | null) => void;
}

/**
 * The "Import" file-picker button plus the mapping wizard it opens.
 *
 * Mirrors `<div class="btn file-btn"><input type="file" …></div>` from the
 * original pages: a styled button with a transparent file input laid over it.
 */
export function ImportButton({
  apiBase,
  entityName,
  importHeaders,
  onComplete,
  onSummary,
  onError,
}: ImportButtonProps) {
  const [pending, setPending] = useState<{
    file: File;
    rows: SheetRow[];
    sheetColumns: string[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Allow re-selecting the same file later.
    if (inputRef.current) inputRef.current.value = "";

    onError(null);
    try {
      const rows = await parseFile(file);
      if (!rows.length) {
        throw new Error("The file appears to be empty or has no data rows.");
      }
      setPending({ file, rows, sheetColumns: Object.keys(rows[0]) });
    } catch (err) {
      onError(errorMessage(err) || "Could not read that file.");
    }
  }

  return (
    <>
      <div className="btn file-btn">
        Import
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          onChange={handleFileChange}
        />
      </div>
      {pending && (
        <WizardModal
          file={pending.file}
          rows={pending.rows}
          sheetColumns={pending.sheetColumns}
          apiBase={apiBase}
          entityName={entityName}
          importHeaders={importHeaders}
          onClose={() => setPending(null)}
          onComplete={(summary) => {
            onSummary(summary);
            onComplete(summary);
          }}
          onError={onError}
        />
      )}
    </>
  );
}

export interface ImpExpDropdownProps {
  apiBase: string;
  entityName: string;
  importHeaders: ImportHeader[];
  onComplete: (summary: ImportSummary | null) => void;
  onSummary: (summary: ImportSummary | null) => void;
  onError: (message: string | null) => void;
  onExportCsv: () => void;
}

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

function downloadSampleCsv(entityName: string, headers: ImportHeader[]) {
  const headerKeys = headers.map((h) => h.key || h.label);
  const sampleRow = headers.map((h) => {
    const key = h.key || h.label || "";
    let val = REALISTIC_SAMPLES[key] || (h.label ? REALISTIC_SAMPLES[h.label] : "");
    if (!val) {
      const k = key.toLowerCase();
      if (k.includes("code")) val = "SAMPLE-001";
      else if (k.includes("name")) val = "Sample Name";
      else if (k.includes("status")) val = "active";
      else if (k.includes("quantity") || k.includes("qty")) val = "1";
      else if (k.includes("weight")) val = "10.0";
      else if (k.includes("price") || k.includes("cost")) val = "100.00";
      else val = "Sample Value";
    }
    return `"${val.replace(/"/g, '""')}"`;
  });

  const csvContent = "\uFEFF" + headerKeys.join(",") + "\n" + sampleRow.join(",") + "\n";
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  const capEntity = entityName.charAt(0).toUpperCase() + entityName.slice(1);
  link.setAttribute("download", `Sample_${capEntity.replace(/\s+/g, "_")}_Template.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function ImpExpDropdown({
  apiBase,
  entityName,
  importHeaders,
  onComplete,
  onSummary,
  onError,
  onExportCsv,
}: ImpExpDropdownProps) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<{
    file: File;
    rows: SheetRow[];
    sheetColumns: string[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (inputRef.current) inputRef.current.value = "";
    setOpen(false);

    onError(null);
    try {
      const rows = await parseFile(file);
      if (!rows.length) {
        throw new Error("The file appears to be empty or has no data rows.");
      }
      setPending({ file, rows, sheetColumns: Object.keys(rows[0]) });
    } catch (err) {
      onError(errorMessage(err) || "Could not read that file.");
    }
  }

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className="btn btn-imp-exp"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "#f59e0b",
          color: "#ffffff",
          padding: "8px 16px",
          borderRadius: "6px",
          border: "none",
          fontWeight: 700,
          fontSize: "13px",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        Imp / Exp ▾
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "4px",
            background: "#ffffff",
            borderRadius: "6px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            border: "1px solid #e2e8f0",
            zIndex: 1000,
            minWidth: "160px",
            overflow: "hidden",
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              downloadSampleCsv(entityName, importHeaders);
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "10px 14px",
              fontSize: "13.5px",
              color: "#334155",
              fontWeight: 600,
              background: "none",
              border: "none",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            📄 SAMPLE FILE
          </button>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              padding: "10px 14px",
              fontSize: "13.5px",
              color: "#334155",
              fontWeight: 600,
              cursor: "pointer",
              margin: 0,
              borderTop: "1px solid #f1f5f9",
            }}
          >
            📥 IMPORT
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.xlsx"
              onChange={handleFileChange}
              style={{ display: "none" }}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onExportCsv();
            }}
            style={{
              width: "100%",
              textAlign: "left",
              padding: "10px 14px",
              fontSize: "13.5px",
              color: "#334155",
              fontWeight: 600,
              background: "none",
              border: "none",
              borderTop: "1px solid #f1f5f9",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            📤 EXPORT
          </button>
        </div>
      )}

      {pending && (
        <WizardModal
          file={pending.file}
          rows={pending.rows}
          sheetColumns={pending.sheetColumns}
          apiBase={apiBase}
          entityName={entityName}
          importHeaders={importHeaders}
          onClose={() => setPending(null)}
          onComplete={(summary) => {
            onSummary(summary);
            onComplete(summary);
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

export interface BulkActionsDropdownProps {
  selectedCount: number;
  onBulkActivate?: () => void;
  onBulkDeactivate?: () => void;
  onBulkDelete?: () => void;
}

export function BulkActionsDropdown({
  selectedCount,
  onBulkActivate,
  onBulkDeactivate,
  onBulkDelete,
}: BulkActionsDropdownProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const hasSelection = selectedCount > 0;

  return (
    <div ref={menuRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className="btn btn-bulk-actions"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "#10b981",
          color: "#ffffff",
          padding: "8px 16px",
          borderRadius: "6px",
          border: "none",
          fontWeight: 700,
          fontSize: "13px",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        Bulk Actions {hasSelection ? `(${selectedCount})` : ""} ▾
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "4px",
            background: "#ffffff",
            borderRadius: "6px",
            boxShadow: "0 10px 25px rgba(0,0,0,0.15)",
            border: "1px solid #e2e8f0",
            zIndex: 1000,
            minWidth: "180px",
            overflow: "hidden",
          }}
        >
          {!hasSelection ? (
            <div style={{ padding: "10px 14px", fontSize: "12.5px", color: "#64748b", fontStyle: "italic" }}>
              Select 1 or more items from list first
            </div>
          ) : (
            <>
              {onBulkActivate && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onBulkActivate();
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    fontSize: "13.5px",
                    color: "#059669",
                    fontWeight: 600,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  ▶️ Bulk Activate ({selectedCount})
                </button>
              )}
              {onBulkDeactivate && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onBulkDeactivate();
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    fontSize: "13.5px",
                    color: "#d97706",
                    fontWeight: 600,
                    background: "none",
                    border: "none",
                    borderTop: "1px solid #f1f5f9",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  ⏸️ Bulk Inactive ({selectedCount})
                </button>
              )}
              {onBulkDelete && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onBulkDelete();
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 14px",
                    fontSize: "13.5px",
                    color: "#dc2626",
                    fontWeight: 600,
                    background: "none",
                    border: "none",
                    borderTop: "1px solid #f1f5f9",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  🗑️ Bulk Delete ({selectedCount})
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
