/**
 * ImportWizard -- shared column-mapping import flow for every page that
 * imports CSV/Excel data (all Master Data pages + Suppliers).
 *
 * Flow (matches the familiar Bitrix24 / typical ERP import pattern):
 *   1. User picks a file (.csv or .xlsx).
 *   2. We parse just the header row + a few preview rows entirely in the
 *      browser (no upload yet) using PapaParse (CSV) or SheetJS (XLSX).
 *   3. A modal opens showing every target field this module accepts, each
 *      with a <select> pre-filled with our best-guess match against the
 *      uploaded sheet's own column names (case/spacing/punctuation-insensitive,
 *      plus common synonyms). The user can override any mapping from a
 *      dropdown of the sheet's actual columns.
 *   4. A live preview table shows the first few rows re-mapped into target
 *      columns, so the user can eyeball correctness before committing.
 *   5. On "Import", we remap every row from the *entire* file (not just the
 *      preview) into the target header order, encode it back into a CSV
 *      blob client-side, and POST that single clean file to the existing
 *      `${apiBase}/import` endpoint -- so the backend's row validators
 *      (which already key off these exact header names) need no changes.
 *   6. While the request is in flight we show a spinner + "Importing..."
 *      state; when it resolves we render the existing created/failed/error
 *      summary UI, exactly as before.
 *
 * Usage:
 *   ImportWizard.attach({
 *     triggerInputEl: document.getElementById("importInput"),
 *     apiBase: "/masters/products",
 *     entityName: "product",
 *     importHeaders: [ { key: "product_code", label: "Product Code", required: true }, ... ],
 *     onComplete: (summary) => { ... refresh table, show summary ... },
 *   });
 */

const ImportWizard = (() => {
  const CDN_PAPAPARSE = "https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js";
  const CDN_SHEETJS = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

  let libsLoadingPromise = null;

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing) {
        if (existing.dataset.loaded === "true") return resolve();
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
        return;
      }
      const script = document.createElement("script");
      script.src = src;
      script.async = true;
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      });
      script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
      document.head.appendChild(script);
    });
  }

  function ensureParsingLibs() {
    if (!libsLoadingPromise) {
      libsLoadingPromise = Promise.all([loadScriptOnce(CDN_PAPAPARSE), loadScriptOnce(CDN_SHEETJS)]);
    }
    return libsLoadingPromise;
  }

  // --- Header name normalization + fuzzy auto-match ------------------------

  function normalize(str) {
    return String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  // Common synonym groups so e.g. a sheet column called "Item Code" auto-maps
  // to our target field "product_code", "SKU" maps too, etc. Each target
  // field key maps to extra normalized phrases (beyond its own label/key)
  // that should also count as a match.
  const SYNONYMS = {
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
   * Given one target field { key, label } and the list of actual sheet
   * column names, return the best-guess sheet column name, or null.
   */
  function bestMatch(target, sheetColumns) {
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

  // --- File parsing (headers + preview rows now, full rows on demand) -----

  function parseCsvFile(file) {
    return new Promise((resolve, reject) => {
      window.Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => resolve(results.data),
        error: (err) => reject(err),
      });
    });
  }

  function parseXlsxFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = window.XLSX.read(e.target.result, { type: "array" });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: "" });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error("Failed to read file."));
      reader.readAsArrayBuffer(file);
    });
  }

  async function parseFile(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".csv")) return parseCsvFile(file);
    if (lower.endsWith(".xlsx")) return parseXlsxFile(file);
    throw new Error("Unsupported file type. Please upload a .csv or .xlsx file.");
  }

  // --- Remap parsed rows into target headers, build a CSV blob ------------

  function csvEscape(value) {
    const str = value === null || value === undefined ? "" : String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function buildRemappedCsv(rows, mapping, importHeaders) {
    // mapping: { targetKey -> sourceColumnName | null }
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

  // --- Modal markup ---------------------------------------------------------

  function renderModal({ fileName, sheetColumns, importHeaders, mapping, rows, entityName }) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop import-wizard-backdrop";
    backdrop.innerHTML = `
      <div class="modal-card import-wizard-card">
        <div class="modal-header">
          <h2>Import ${escapeHtml(entityName)} &mdash; Map Columns</h2>
          <button type="button" class="modal-close" id="iwCloseBtn">&times;</button>
        </div>

        <div class="iw-file-info">
          <span class="iw-file-name">📄 ${escapeHtml(fileName)}</span>
          <span class="muted">${rows.length} row${rows.length === 1 ? "" : "s"} detected</span>
        </div>

        <div class="iw-mapping-section">
          <div class="section-title">Match your columns</div>
          <div class="muted" style="margin-bottom: var(--space-2);">
            We've auto-matched what we could recognize. Review each field below and adjust any dropdown that isn't right.
          </div>
          <div class="iw-mapping-table" id="iwMappingTable"></div>
        </div>

        <div class="iw-preview-section">
          <div class="section-title">Preview (first 5 rows)</div>
          <div class="table-scroll iw-preview-scroll">
            <table class="iw-preview-table" id="iwPreviewTable"></table>
          </div>
        </div>

        <div class="iw-progress" id="iwProgress" style="display:none;">
          <div class="iw-progress-row">
            <div class="iw-spinner"></div>
            <span id="iwProgressText">Importing...</span>
          </div>
          <div class="iw-progress-track">
            <div class="iw-progress-bar" id="iwProgressBar" style="width: 0%;"></div>
          </div>
        </div>

        <div class="form-actions iw-actions">
          <span class="muted" id="iwUnmappedWarning"></span>
          <div style="flex:1"></div>
          <button type="button" class="btn" id="iwCancelBtn">Cancel</button>
          <button type="button" class="btn btn-primary" id="iwImportBtn">Import ${rows.length} row${rows.length === 1 ? "" : "s"}</button>
        </div>
      </div>
    `;
    return backdrop;
  }

  function renderMappingRows(container, importHeaders, sheetColumns, mapping, onChange) {
    container.innerHTML = importHeaders
      .map((h) => {
        const options = [`<option value="">— Don't import —</option>`]
          .concat(
            sheetColumns.map(
              (col) =>
                `<option value="${escapeHtml(col)}" ${mapping[h.key] === col ? "selected" : ""}>${escapeHtml(col)}</option>`
            )
          )
          .join("");
        return `
          <div class="iw-mapping-row">
            <div class="iw-target-field">
              <span class="iw-target-label">${escapeHtml(h.label)}</span>
              ${h.required ? '<span class="iw-required">*</span>' : ""}
              <span class="iw-target-key">${escapeHtml(h.key)}</span>
            </div>
            <div class="iw-arrow">→</div>
            <select class="iw-source-select" data-target-key="${escapeHtml(h.key)}">
              ${options}
            </select>
            <span class="iw-match-badge ${mapping[h.key] ? "iw-match-auto" : "iw-match-none"}">
              ${mapping[h.key] ? "Matched" : h.required ? "Required" : "Optional"}
            </span>
          </div>`;
      })
      .join("");

    container.querySelectorAll(".iw-source-select").forEach((select) => {
      select.addEventListener("change", () => {
        const key = select.getAttribute("data-target-key");
        mapping[key] = select.value || null;
        onChange();
      });
    });
  }

  function renderPreviewTable(table, importHeaders, mapping, rows) {
    const previewRows = rows.slice(0, 5);
    const headerCells = importHeaders.map((h) => `<th>${escapeHtml(h.label)}</th>`).join("");
    const bodyRows = previewRows
      .map((row) => {
        const cells = importHeaders
          .map((h) => {
            const sourceCol = mapping[h.key];
            const val = sourceCol ? row[sourceCol] : "";
            return `<td>${val === undefined || val === null || val === "" ? '<span class="muted">—</span>' : escapeHtml(String(val))}</td>`;
          })
          .join("");
        return `<tr>${cells}</tr>`;
      })
      .join("");
    table.innerHTML = `<thead><tr>${headerCells}</tr></thead><tbody>${bodyRows || `<tr><td colspan="${importHeaders.length}" class="muted">No rows to preview.</td></tr>`}</tbody>`;
  }

  function updateUnmappedWarning(el, importHeaders, mapping) {
    const missingRequired = importHeaders.filter((h) => h.required && !mapping[h.key]);
    if (missingRequired.length) {
      el.innerHTML = `<span style="color: var(--color-danger)">⚠ Required field${missingRequired.length > 1 ? "s" : ""} not mapped: ${missingRequired
        .map((h) => escapeHtml(h.label))
        .join(", ")}</span>`;
      return false;
    }
    el.innerHTML = "";
    return true;
  }

  // --- Duplicate detection UI: red banner + click-to-compare popup --------

  /**
   * Pick the best human-readable label for one row's data, trying common
   * "name-like" fields in priority order. Falls back to the row number if
   * nothing recognizable is found (e.g. a module with unusual field names).
   */
  function labelForRow(rowData) {
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
   * Find a "Sr. No." / identifying number for a row's data if the module
   * exposes one (some modules key duplicates by a serial/code rather than
   * a name) -- used to phrase "Sr. No. X in your file matches Sr. No. Y in
   * the system" when both sides have one.
   */
  function idLabelForRow(rowData) {
    if (!rowData) return null;
    const candidates = ["product_code", "code", "employee_code"];
    for (const key of candidates) {
      if (rowData[key]) return String(rowData[key]);
    }
    return null;
  }

  function fieldDiffRows(importedRow, existingRow) {
    const keys = new Set([...Object.keys(importedRow || {}), ...Object.keys(existingRow || {})]);
    // Skip internal/bookkeeping columns that aren't meaningful to compare visually.
    const skip = new Set(["id", "created_at", "updated_at", "deleted_at"]);
    const rows = [];
    for (const key of keys) {
      if (skip.has(key)) continue;
      const a = importedRow ? importedRow[key] : undefined;
      const b = existingRow ? existingRow[key] : undefined;
      const aStr = a === undefined || a === null || a === "" ? "—" : String(a);
      const bStr = b === undefined || b === null || b === "" ? "—" : String(b);
      rows.push({ key, aStr, bStr, differs: aStr !== bStr });
    }
    // Differing fields first so the person sees what's actually different
    // without scrolling through a long list of identical values.
    rows.sort((a, b) => Number(b.differs) - Number(a.differs));
    return rows;
  }

  function openDuplicateCompareModal(duplicate) {
    const importedRow = duplicate.row_data || {};
    const existingRow = duplicate.existing || null;
    const importedLabel = labelForRow(importedRow) || `Row ${duplicate.row}`;
    const existingLabel = existingRow ? labelForRow(existingRow) || "Existing record" : null;
    const importedIdLabel = idLabelForRow(importedRow);
    const existingIdLabel = existingRow ? idLabelForRow(existingRow) : null;

    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop iw-compare-backdrop";

    const matchLine =
      importedIdLabel && existingIdLabel
        ? `<div class="iw-compare-match-note">Row ${duplicate.row} in your file (<b>${escapeHtml(importedIdLabel)}</b>) matches an existing record with the same identifier (<b>${escapeHtml(existingIdLabel)}</b>) already in the system.</div>`
        : `<div class="iw-compare-match-note">Row ${duplicate.row} in your file matches an existing record already in the system.</div>`;

    const diffRows = existingRow ? fieldDiffRows(importedRow, existingRow) : [];

    backdrop.innerHTML = `
      <div class="modal-card iw-compare-card">
        <div class="modal-header">
          <h2>Duplicate Comparison</h2>
          <button type="button" class="modal-close" id="iwCompareCloseBtn">&times;</button>
        </div>
        ${matchLine}
        ${existingRow
        ? `
          <div class="table-scroll iw-compare-scroll">
            <table class="iw-compare-table">
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Your file (${escapeHtml(importedLabel)})</th>
                  <th>Already in system (${escapeHtml(existingLabel)})</th>
                </tr>
              </thead>
              <tbody>
                ${diffRows
          .map(
            (r) => `
                  <tr class="${r.differs ? "iw-diff-row" : ""}">
                    <td class="iw-diff-key">${escapeHtml(r.key)}</td>
                    <td>${escapeHtml(r.aStr)}</td>
                    <td>${escapeHtml(r.bStr)}</td>
                  </tr>`
          )
          .join("")}
              </tbody>
            </table>
          </div>`
        : `<div class="muted" style="padding: var(--space-3) 0;">The existing record's details weren't available to compare, but this row was skipped because it duplicates something already in the system.</div>`
      }
        <div class="form-actions">
          <div style="flex:1"></div>
          <button type="button" class="btn btn-primary" id="iwCompareOkBtn">Close</button>
        </div>
      </div>`;

    document.body.appendChild(backdrop);
    lockBodyScroll();

    function close() {
      unlockBodyScroll();
      backdrop.remove();
    }
    backdrop.querySelector("#iwCompareCloseBtn").addEventListener("click", close);
    backdrop.querySelector("#iwCompareOkBtn").addEventListener("click", close);
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
  }

  function renderDuplicateBanner(summary) {
    const duplicates = summary.duplicates || [];
    if (!duplicates.length) return "";

    const items = duplicates
      .map((dup, index) => {
        const label = labelForRow(dup.row_data) || `Row ${dup.row}`;
        return `<button type="button" class="iw-dup-chip" data-dup-index="${index}">
          <span class="iw-dup-name">${escapeHtml(label)}</span>
          <span class="iw-dup-hint">Row ${dup.row} &middot; compare →</span>
        </button>`;
      })
      .join("");

    return `
      <div class="import-duplicates-banner">
        <div class="import-duplicates-header">
          ⚠ ${duplicates.length} record${duplicates.length > 1 ? "s" : ""} already existed and ${duplicates.length > 1 ? "were" : "was"} skipped during import
        </div>
        <div class="import-duplicates-list">${items}</div>
      </div>`;
  }

  function wireDuplicateBanner(container, summary) {
    const duplicates = summary.duplicates || [];
    if (!duplicates.length) return;
    container.querySelectorAll("[data-dup-index]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const index = parseInt(btn.getAttribute("data-dup-index"), 10);
        openDuplicateCompareModal(duplicates[index]);
      });
    });
  }

  function renderSummary(container, summary) {
    // Generic (non-duplicate) validation failures still show as plain text
    // lines; duplicates get their own red banner with per-row compare
    // buttons instead, since "this row is invalid" and "this row already
    // exists" call for different follow-up actions from the person.
    const errorLines = (summary.errors || []).map((er) => `Row ${er.row}: ${escapeHtml(er.error)}`).join("<br>");

    container.innerHTML = `
      <div class="import-summary">
        <div class="import-stats">
          <div class="import-stat"><b>${summary.total_rows}</b><span class="muted">Total rows</span></div>
          <div class="import-stat"><b style="color:var(--color-success)">${summary.created}</b><span class="muted">Created</span></div>
          <div class="import-stat"><b style="color:var(--color-danger)">${summary.failed}</b><span class="muted">Failed</span></div>
          ${summary.duplicate_count
        ? `<div class="import-stat"><b style="color:var(--color-danger)">${summary.duplicate_count}</b><span class="muted">Duplicates</span></div>`
        : ""
      }
        </div>
        ${renderDuplicateBanner(summary)}
        ${errorLines ? `<div class="import-errors">${errorLines}</div>` : ""}
      </div>`;

    wireDuplicateBanner(container, summary);
  }

  // --- Chunked upload with live "X of Y rows" progress --------------------

  const CHUNK_SIZE = 250; // rows per request -- small enough for frequent progress updates, large enough to stay fast

  async function uploadChunk(rowsChunk, mapping, config, signal) {
    const csvBlob = buildRemappedCsv(rowsChunk, mapping, config.importHeaders);
    const formData = new FormData();
    formData.append("file", csvBlob, "import.csv");

    const token = Auth.getAccessToken();
    const res = await fetch(`${API_ORIGIN}/api/v1${config.apiBase}/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
      signal,
    });
    const body = await res.json();
    if (!res.ok || body.success === false) {
      throw new Error(body.message || "Import failed.");
    }
    return body.data;
  }

  function mergeSummaries(target, chunkSummary, rowOffset) {
    target.total_rows += chunkSummary.total_rows || 0;
    target.created += chunkSummary.created || 0;
    target.failed += chunkSummary.failed || 0;
    target.duplicate_count += chunkSummary.duplicate_count || 0;
    // Row numbers inside each chunk's summary are 1-indexed *within that
    // chunk's own CSV* (row 1 = header, row 2 = first data row) -- offset
    // them back to the row's true position in the original uploaded file
    // so error/duplicate messages point at the right row for the person.
    for (const err of chunkSummary.errors || []) {
      target.errors.push({ ...err, row: err.row + rowOffset });
    }
    for (const dup of chunkSummary.duplicates || []) {
      target.duplicates.push({ ...dup, row: dup.row + rowOffset });
    }
  }

  /**
   * Uploads `rows` in fixed-size chunks (sequentially, so progress reporting
   * stays accurate and the backend never receives more than CHUNK_SIZE rows
   * per request), updating the progress bar and "X of Y rows" text after
   * each chunk. Returns one aggregated summary identical in shape to what a
   * single-shot import would have returned -- no data loss across chunks,
   * duplicates/errors from every chunk are preserved with corrected row
   * numbers.
   */
  async function runChunkedImport({ rows, mapping, config, progressBarEl, progressTextEl, signal }) {
    const total = rows.length;
    const aggregated = {
      total_rows: 0,
      created: 0,
      failed: 0,
      duplicate_count: 0,
      errors: [],
      duplicates: [],
    };

    if (total <= CHUNK_SIZE) {
      progressTextEl.textContent = `Uploading ${total} row${total === 1 ? "" : "s"}...`;
      if (progressBarEl) progressBarEl.style.width = "40%";
      const chunkSummary = await uploadChunk(rows, mapping, config, signal);
      if (progressBarEl) progressBarEl.style.width = "100%";
      progressTextEl.textContent = `Imported ${total} of ${total} row${total === 1 ? "" : "s"}`;
      mergeSummaries(aggregated, chunkSummary, 0);
      return aggregated;
    }

    let uploaded = 0;
    for (let start = 0; start < total; start += CHUNK_SIZE) {
      const chunk = rows.slice(start, start + CHUNK_SIZE);
      const chunkSummary = await uploadChunk(chunk, mapping, config, signal);
      mergeSummaries(aggregated, chunkSummary, start);
      uploaded += chunk.length;

      const percent = Math.round((uploaded / total) * 100);
      if (progressBarEl) progressBarEl.style.width = `${percent}%`;
      progressTextEl.textContent = `Imported ${uploaded} of ${total} rows (${percent}%)`;
    }

    return aggregated;
  }

  // --- Public: attach() ------------------------------------------------------

  /**
   * config = {
   *   triggerInputEl: <input type="file"> element that starts the flow,
   *   apiBase: "/masters/products",
   *   entityName: "product",
   *   importHeaders: [{ key, label, required }, ...],
   *   summaryEl: optional element to render the created/failed summary into
   *              (defaults to #importSummary if present),
   *   onComplete: optional callback(summary) called after a successful import
   *               (e.g. to refresh the table),
   * }
   */
  function attach(config) {
    const { triggerInputEl } = config;
    if (!triggerInputEl) return;

    const summaryEl = config.summaryEl || document.getElementById("importSummary");

    triggerInputEl.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      triggerInputEl.value = ""; // allow re-selecting the same file later

      try {
        await ensureParsingLibs();
        const rows = await parseFile(file);
        if (!rows.length) {
          throw new Error("The file appears to be empty or has no data rows.");
        }
        const sheetColumns = Object.keys(rows[0]);

        const mapping = {};
        for (const h of config.importHeaders) {
          mapping[h.key] = bestMatch(h, sheetColumns);
        }

        openMappingModal({ file, rows, sheetColumns, mapping, config, summaryEl });
      } catch (err) {
        if (summaryEl) {
          summaryEl.innerHTML = `<div class="import-summary"><span style="color: var(--color-danger)">${escapeHtml(err.message || "Could not read that file.")}</span></div>`;
        } else {
          alert(err.message || "Could not read that file.");
        }
      }
    });
  }

  function openMappingModal({ file, rows, sheetColumns, mapping, config, summaryEl }) {
    const backdrop = renderModal({
      fileName: file.name,
      sheetColumns,
      importHeaders: config.importHeaders,
      mapping,
      rows,
      entityName: config.entityName,
    });
    document.body.appendChild(backdrop);
    lockBodyScroll();

    const mappingTable = backdrop.querySelector("#iwMappingTable");
    const previewTable = backdrop.querySelector("#iwPreviewTable");
    const unmappedWarningEl = backdrop.querySelector("#iwUnmappedWarning");
    const importBtn = backdrop.querySelector("#iwImportBtn");
    const cancelBtn = backdrop.querySelector("#iwCancelBtn");
    const closeBtn = backdrop.querySelector("#iwCloseBtn");
    const progressEl = backdrop.querySelector("#iwProgress");
    const progressTextEl = backdrop.querySelector("#iwProgressText");
    const progressBarEl = backdrop.querySelector("#iwProgressBar");

    let locked = false; // true while an import is in flight
    let abortController = null; // lets Cancel actually stop in-flight chunk uploads, not just hide the modal

    // While importing, everything is locked down except Cancel: no editing
    // the column mapping, no closing via the X or backdrop click, no
    // double-submitting Import. Cancel stays the one live way out, and
    // clicking it aborts whatever chunk request is currently in flight
    // rather than leaving it to finish silently in the background.
    function setLocked(isLocked) {
      locked = isLocked;
      importBtn.disabled = isLocked || importBtn.disabled;
      closeBtn.disabled = isLocked;
      mappingTable.querySelectorAll(".iw-source-select").forEach((select) => {
        select.disabled = isLocked;
      });
      backdrop.classList.toggle("iw-locked", isLocked);
      // Cancel is deliberately left enabled in every branch above.
    }

    function refresh() {
      renderMappingRows(mappingTable, config.importHeaders, sheetColumns, mapping, refresh);
      renderPreviewTable(previewTable, config.importHeaders, mapping, rows);
      const ok = updateUnmappedWarning(unmappedWarningEl, config.importHeaders, mapping);
      importBtn.disabled = !ok;
    }
    refresh();

    function close() {
      if (abortController) abortController.abort();
      unlockBodyScroll();
      backdrop.remove();
    }

    closeBtn.addEventListener("click", () => {
      if (locked) return; // disabled attribute already blocks this, kept as a defensive guard
      close();
    });
    cancelBtn.addEventListener("click", () => {
      // Cancel always works, even mid-import: abort the in-flight request,
      // then close. Whatever chunks already completed before Cancel was
      // pressed have already been created server-side -- cancelling stops
      // further chunks from being sent, it does not roll back completed ones.
      close();
    });
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop && !locked) close();
    });

    importBtn.addEventListener("click", async () => {
      const ok = updateUnmappedWarning(unmappedWarningEl, config.importHeaders, mapping);
      if (!ok) return;

      setLocked(true);
      importBtn.disabled = true;
      importBtn.textContent = "Importing...";
      progressEl.style.display = "flex";
      abortController = new AbortController();

      try {
        const aggregatedSummary = await runChunkedImport({
          rows,
          mapping,
          config,
          progressBarEl,
          progressTextEl,
          signal: abortController.signal,
        });

        progressTextEl.textContent = "Done!";
        close();

        if (summaryEl) renderSummary(summaryEl, aggregatedSummary);
        if (config.onComplete) await config.onComplete(aggregatedSummary);
      } catch (err) {
        if (isAbortError(err)) {
          // Cancelled mid-import: the modal is already closed by close(),
          // nothing further to show -- any chunks already created remain
          // created, so refresh the underlying table to reflect them.
          if (config.onComplete) await config.onComplete(null);
          return;
        }
        setLocked(false);
        progressEl.style.display = "none";
        importBtn.disabled = false;
        importBtn.textContent = `Import ${rows.length} row${rows.length === 1 ? "" : "s"}`;
        if (summaryEl) {
          summaryEl.innerHTML = `<div class="import-summary"><span style="color: var(--color-danger)">${escapeHtml(err.message || "Import failed.")}</span></div>`;
        } else {
          alert(err.message || "Import failed.");
        }
      }
    });
  }

  return { attach };
})();