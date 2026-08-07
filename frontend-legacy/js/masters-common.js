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
    const canExport = Auth.hasPermission(`${config.permissionPrefix}.export`);
    const canImport = Auth.hasPermission(`${config.permissionPrefix}.import`);

    const newBtn = document.getElementById("newBtn");
    if (newBtn && !canCreate) newBtn.style.display = "none";

    const importBtn = document.getElementById("importInput");
    if (importBtn && !canImport) {
      const wrapper = document.getElementById("importBtnWrapper");
      if (wrapper) wrapper.style.display = "none";
    }

    let currentPage = 1;
    let pageSize = 20;

    function getModalBanner() {
      let mb = document.getElementById("modalBanner");
      if (!mb && entityForm) {
        mb = entityForm.querySelector(".modal-banner");
        if (!mb) {
          mb = document.createElement("div");
          mb.id = "modalBanner";
          mb.className = "modal-banner";
          mb.style.marginBottom = "16px";
          entityForm.prepend(mb);
        }
      }
      return mb;
    }

    function openModal(item) {
      entityForm.reset();
      const mb = getModalBanner();
      if (mb) mb.innerHTML = "";
      document.getElementById("entityId").value = item ? item.id : "";
      document.getElementById("modalTitle").textContent = item
        ? `Edit ${config.entityName}`
        : `New ${config.entityName}`;
      if (config.fillForm) config.fillForm(item);
      openModalShell(modalBackdrop);
    }

    function closeModal() {
      const mb = getModalBanner();
      if (mb) mb.innerHTML = "";
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

    document.addEventListener("change", (e) => {
      if (e.target && (e.target.classList.contains("select-all-checkbox") || e.target.id === "selectAll")) {
        const isChecked = e.target.checked;
        const table = e.target.closest("table");
        if (table) {
          table.querySelectorAll(".row-checkbox").forEach((cb) => {
            cb.checked = isChecked;
          });
        }
      }
    });

    async function loadTable() {
      const colCount = config.columns.length + 3; // +1 for checkbox, +1 for Sr. No., +1 for actions
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
        if (config.resolveNames && data.length) {
          await config.resolveNames(data);
        }
        if (!data.length) {
          tableBody.innerHTML = `<tr><td colspan="${colCount}" class="muted">No records found.</td></tr>`;
        } else {
          tableBody.innerHTML = data
            .map((item, index) => {
              const srNo = (currentPage - 1) * pageSize + index + 1;
              const cells = config.columns.map((col) => `<td>${col.render(item, srNo)}</td>`).join("");
              return `
              <tr>
                <td class="cell-checkbox"><input type="checkbox" class="row-checkbox" value="${item.id}" /></td>
                <td class="cell-srno">${srNo}</td>
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
      renderFlexiblePagination(pagination, p, {
        pageSize: pageSize,
        onPageChange: (newPage) => {
          currentPage = newPage;
          loadTable();
        },
        onPageSizeChange: (newSize) => {
          pageSize = newSize;
          currentPage = 1;
          loadTable();
        },
      });
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
        const mb = getModalBanner();
        showError(mb || banner, err);
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

    // --- Sample Template Download ---
    const sampleTemplateBtn = document.getElementById("sampleTemplateBtn");
    if (sampleTemplateBtn) {
      sampleTemplateBtn.addEventListener("click", () => {
        const headers = config.importHeaders ? config.importHeaders.map(h => typeof h === "string" ? h : h.key || h.label).join(",") : "code,name,status";
        const sampleVals = config.importHeaders ? config.importHeaders.map(h => {
          const k = (typeof h === "string" ? h : h.key || h.label).toLowerCase();
          if (k.includes("code")) return "SAMPLE-001";
          if (k.includes("name")) return "Sample Name";
          if (k.includes("status")) return "active";
          if (k.includes("quantity") || k.includes("weight") || k.includes("price") || k.includes("cost")) return "10";
          return "Sample Data";
        }).join(",") : "SMP-01,Sample Entity,active";

        const csvContent = "data:text/csv;charset=utf-8," + encodeURIComponent(headers + "\n" + sampleVals);
        const link = document.createElement("a");
        link.setAttribute("href", csvContent);
        link.setAttribute("download", `Sample_${(config.entityName || "import").replace(/\s+/g, "_")}_Template.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
      });
    }

    // --- Export ---
    const exportCsvBtn = document.getElementById("exportCsvBtn");
    const exportXlsxBtn = document.getElementById("exportXlsxBtn");
    const exportDropdownWrapper = document.getElementById("exportDropdownWrapper") || document.getElementById("exportBtnWrapper") || (exportCsvBtn ? exportCsvBtn.closest(".dropdown") : null);
    if (exportDropdownWrapper && !canExport) {
      exportDropdownWrapper.style.display = "none";
    }
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

  // --- Shared Right-Side Offcanvas Detail Drawer ---
  let activeDrawerItem = null;

  function ensureDrawerMarkup() {
    let backdrop = document.getElementById("masterDetailDrawerBackdrop");
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "side-drawer-backdrop";
      backdrop.id = "masterDetailDrawerBackdrop";
      backdrop.innerHTML = `
        <div class="side-drawer-card">
          <div style="padding: 18px 24px; border-bottom: 1px solid var(--color-border); display: flex; align-items: center; justify-content: space-between; background: #fff;">
            <div>
              <h3 id="masterDrawerTitle" style="font-size: 17.5px; font-weight: 700; color: var(--color-heading); margin: 0;">Detail</h3>
              <div id="masterDrawerSubtitle" style="font-size: 12.5px; color: var(--color-muted); margin-top: 2px;"></div>
            </div>
            <div style="display: flex; align-items: center; gap: 12px;">
              <button class="btn btn-primary" id="masterDrawerEditBtn" style="padding: 7px 14px; font-size: 13px; font-weight: 600;">✏️ Edit</button>
              <button class="modal-close" id="masterDrawerCloseBtn" style="width: 32px; height: 32px; font-size: 20px;">&times;</button>
            </div>
          </div>
          <div id="masterDrawerBody" style="padding: 24px; flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;"></div>
        </div>
      `;
      document.body.appendChild(backdrop);

      const closeDrawer = () => backdrop.classList.remove("open");
      document.getElementById("masterDrawerCloseBtn").addEventListener("click", closeDrawer);
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeDrawer();
      });

      document.getElementById("masterDrawerEditBtn").addEventListener("click", () => {
        closeDrawer();
        if (activeDrawerItem) {
          const editBtn = document.querySelector(`[data-edit="${activeDrawerItem.id}"]`);
          if (editBtn) editBtn.click();
        }
      });
    }
    return backdrop;
  }

  async function openDetailDrawer(apiBase, itemId, titleKey, fields) {
    ensureDrawerMarkup();
    try {
      const res = await apiGet(`${apiBase}/${itemId}`);
      const item = res.data;
      if (!item) return;
      activeDrawerItem = item;

      document.getElementById("masterDrawerTitle").textContent = `${item[titleKey] || item.name || item.code || "Detail"}`;
      document.getElementById("masterDrawerSubtitle").textContent = item.code ? `Code: ${item.code}` : "";

      const fieldsHtml = fields.map(f => {
        const val = f.render ? f.render(item) : escapeHtml(item[f.key] != null && item[f.key] !== "" ? item[f.key] : "—");
        return `
          <div style="${f.fullWidth ? 'grid-column: span 2;' : ''}">
            <span style="font-size: 12px; font-weight: 600; color: #64748b; display: block; margin-bottom: 3px;">${escapeHtml(f.label)}</span>
            <strong style="font-size: 14px; color: #0f172a; word-break: break-word;">${val}</strong>
          </div>
        `;
      }).join("");

      const bodyHtml = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px;">
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px 20px;">
            ${fieldsHtml}
          </div>
        </div>
      `;

      document.getElementById("masterDrawerBody").innerHTML = bodyHtml;
      document.getElementById("masterDetailDrawerBackdrop").classList.add("open");
    } catch (err) {
      alert("Failed to load details: " + err.message);
    }
  }

  return { init, badge, fieldValue, setFieldValue, openDetailDrawer };
})();

