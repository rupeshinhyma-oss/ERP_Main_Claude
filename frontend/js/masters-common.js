/**
 * Shared helpers for Master Data admin pages (countries, states, cities,
 * currencies, UOM, HSN, brands, categories, sub-categories, products).
 *
 * Each master page defines a small config object and calls
 * MasterPage.init(config) to wire up: table rendering, search/filter,
 * pagination, create/edit modal, activate/deactivate, delete, and
 * CSV/Excel import/export -- without re-implementing this per page.
 */

const MasterPage = (() => {
  function badge(status) {
    const cls = status === "active" ? "badge-active" : "badge-inactive";
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  }

  function fieldValue(id) {
    const el = document.getElementById(id);
    if (!el) return undefined;
    if (el.type === "checkbox") return el.checked;
    return el.value;
  }

  // Modal scroll-lock helpers (lockBodyScroll/unlockBodyScroll/
  // openModalShell/closeModalShell) now live in api.js, shared by every
  // page -- re-exported here for backwards compatibility with any code
  // still calling MasterPage.openModalShell(...) etc.

  function setFieldValue(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") {
      el.checked = Boolean(value);
    } else {
      el.value = value === null || value === undefined ? "" : value;
    }
  }

  /**
   * config = {
   *   apiBase: "/masters/countries",
   *   permissionPrefix: "country",
   *   entityName: "country",
   *   searchPlaceholder: "Search code or name...",
   *   columns: [{ header, render(item) }],
   *   formFields: [id, ...] (ids of inputs inside #entityForm to read/write),
   *   toPayload(): reads the form -> returns create/update payload,
   *   fillForm(item): populates the form from an item (or clears if null),
   *   loadLookups(): optional async, populate any <select> dropdowns,
   * }
   */
  async function init(config) {
    const banner = document.getElementById("banner");
    const tableBody = document.getElementById("tableBody");
    const pagination = document.getElementById("pagination");
    const modalBackdrop = document.getElementById("modalBackdrop");
    const entityForm = document.getElementById("entityForm");
    const searchInput = document.getElementById("searchInput");
    const statusFilter = document.getElementById("statusFilter");
    const importSummaryEl = document.getElementById("importSummary");

    const canCreate = Auth.hasPermission(`${config.permissionPrefix}.create`);
    const canUpdate = Auth.hasPermission(`${config.permissionPrefix}.update`);
    const canDelete = Auth.hasPermission(`${config.permissionPrefix}.delete`);

    const newBtn = document.getElementById("newBtn");
    if (newBtn && !canCreate) newBtn.style.display = "none";

    const importBtn = document.getElementById("importInput");
    if (importBtn && !canCreate) {
      const wrapper = document.getElementById("importBtnWrapper");
      if (wrapper) wrapper.style.display = "none";
    }

    let currentPage = 1;
    const pageSize = 20;

    function openModal(item) {
      entityForm.reset();
      document.getElementById("entityId").value = item ? item.id : "";
      document.getElementById("modalTitle").textContent = item
        ? `Edit ${config.entityName}`
        : `New ${config.entityName}`;
      if (config.fillForm) config.fillForm(item);
      openModalShell(modalBackdrop);
    }

    function closeModal() {
      closeModalShell(modalBackdrop);
    }

    if (newBtn) newBtn.addEventListener("click", () => openModal(null));
    const cancelBtn = document.getElementById("cancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
    const modalCloseBtn = document.getElementById("modalCloseBtn");
    if (modalCloseBtn) modalCloseBtn.addEventListener("click", closeModal);
    if (modalBackdrop) {
      modalBackdrop.addEventListener("click", (e) => {
        if (e.target === modalBackdrop) closeModal();
      });
    }

    async function loadTable() {
      const colCount = config.columns.length + 1;
      tableBody.innerHTML = `<tr><td colspan="${colCount}" class="muted">Loading...</td></tr>`;
      const params = {
        page: currentPage,
        page_size: pageSize,
        sort_order: "asc",
      };
      if (searchInput) params.search = searchInput.value.trim();
      if (statusFilter) params.status = statusFilter.value;
      if (config.extraFilters) Object.assign(params, config.extraFilters());

      try {
        const { data, meta } = await apiGet(config.apiBase + toQueryString(params));
        // Batch-resolve any related-entity names (e.g. Category/Brand/UOM
        // names for a page of Products) needed to render this page's
        // columns -- bounded by page size, not by the size of the related
        // tables, so this stays cheap regardless of how large Products/
        // Categories/etc. grow.
        if (config.resolveNames && data.length) {
          await config.resolveNames(data);
        }
        if (!data.length) {
          tableBody.innerHTML = `<tr><td colspan="${colCount}" class="muted">No records found.</td></tr>`;
        } else {
          tableBody.innerHTML = data
            .map((item) => {
              const cells = config.columns.map((col) => `<td>${col.render(item)}</td>`).join("");
              return `
              <tr>
                ${cells}
                <td class="actions">
                  ${canUpdate ? `<button class="btn btn-small" data-edit="${item.id}">Edit</button>` : ""}
                  ${
                    canUpdate
                      ? item.status === "active"
                        ? `<button class="btn btn-small" data-deactivate="${item.id}">Deactivate</button>`
                        : `<button class="btn btn-small" data-activate="${item.id}">Activate</button>`
                      : ""
                  }
                  ${canDelete ? `<button class="btn btn-small btn-danger" data-delete="${item.id}">Delete</button>` : ""}
                </td>
              </tr>`;
            })
            .join("");
        }
        renderPagination(meta.pagination);
      } catch (err) {
        tableBody.innerHTML = "";
        showError(banner, err);
      }
    }

    function renderPagination(p) {
      pagination.innerHTML = `
        <span class="muted">Page ${p.current_page} of ${p.total_pages || 1} &middot; ${p.total_records} total</span>
        <div>
          <button class="btn btn-small" id="prevPage" ${!p.has_previous ? "disabled" : ""}>Previous</button>
          <button class="btn btn-small" id="nextPage" ${!p.has_next ? "disabled" : ""}>Next</button>
        </div>
      `;
      const prev = document.getElementById("prevPage");
      const next = document.getElementById("nextPage");
      if (prev) prev.addEventListener("click", () => { currentPage--; loadTable(); });
      if (next) next.addEventListener("click", () => { currentPage++; loadTable(); });
    }

    entityForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      banner.innerHTML = "";
      const id = document.getElementById("entityId").value;
      const payload = config.toPayload();
      try {
        if (id) {
          await apiPatch(`${config.apiBase}/${id}`, payload);
        } else {
          await apiPost(config.apiBase, payload);
        }
        closeModal();
        await loadTable();
      } catch (err) {
        showError(banner, err);
      }
    });

    tableBody.addEventListener("click", async (e) => {
      const editId = e.target.getAttribute("data-edit");
      const deleteId = e.target.getAttribute("data-delete");
      const activateId = e.target.getAttribute("data-activate");
      const deactivateId = e.target.getAttribute("data-deactivate");
      try {
        if (editId) {
          const { data } = await apiGet(`${config.apiBase}/${editId}`);
          openModal(data);
        } else if (deleteId) {
          if (!confirm(`Delete this ${config.entityName}? This cannot be undone.`)) return;
          await apiDelete(`${config.apiBase}/${deleteId}`);
          await loadTable();
        } else if (activateId) {
          await apiPost(`${config.apiBase}/${activateId}/activate`);
          await loadTable();
        } else if (deactivateId) {
          await apiPost(`${config.apiBase}/${deactivateId}/deactivate`);
          await loadTable();
        }
      } catch (err) {
        showError(banner, err);
      }
    });

    let searchDebounce;
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => { currentPage = 1; loadTable(); }, 300);
      });
    }
    if (statusFilter) {
      statusFilter.addEventListener("change", () => { currentPage = 1; loadTable(); });
    }

    // --- Export ---
    const exportCsvBtn = document.getElementById("exportCsvBtn");
    const exportXlsxBtn = document.getElementById("exportXlsxBtn");
    async function doExport(format) {
      try {
        const token = Auth.getAccessToken();
        const res = await fetch(`${API_ORIGIN}/api/v1${config.apiBase}/export?format=${format}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Export failed.");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${config.entityName.replace(/\s+/g, "_")}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        showError(banner, err);
      }
    }
    if (exportCsvBtn) exportCsvBtn.addEventListener("click", () => doExport("csv"));
    if (exportXlsxBtn) exportXlsxBtn.addEventListener("click", () => doExport("xlsx"));

    // --- Import ---
    const importInput = document.getElementById("importInput");
    if (importInput) {
      importInput.addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append("file", file);
        try {
          const token = Auth.getAccessToken();
          const res = await fetch(`${API_ORIGIN}/api/v1${config.apiBase}/import`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` },
            body: formData,
          });
          const body = await res.json();
          if (!res.ok || body.success === false) {
            throw new Error(body.message || "Import failed.");
          }
          const s = body.data;
          if (importSummaryEl) {
            const errorLines = (s.errors || [])
              .map((er) => `Row ${er.row}: ${escapeHtml(er.error)}`)
              .join("<br>");
            importSummaryEl.innerHTML = `
              <div class="import-summary">
                <div class="import-stats">
                  <div class="import-stat"><b>${s.total_rows}</b><span class="muted">Total rows</span></div>
                  <div class="import-stat"><b style="color:var(--color-success)">${s.created}</b><span class="muted">Created</span></div>
                  <div class="import-stat"><b style="color:var(--color-danger)">${s.failed}</b><span class="muted">Failed</span></div>
                </div>
                ${errorLines ? `<div class="import-errors">${errorLines}</div>` : ""}
              </div>`;
          }
          await loadTable();
        } catch (err) {
          showError(banner, err);
        } finally {
          importInput.value = "";
        }
      });
    }

    if (config.loadLookups) await config.loadLookups();
    await loadTable();

    return { loadTable, openModal, closeModal };
  }

  return { init, badge, fieldValue, setFieldValue };
})();