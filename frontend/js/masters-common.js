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
      const colCount = config.columns.length + 2; // +1 for Sr. No., +1 for actions
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
          // Sr. No. is a running number across the whole result set, not just
          // this page -- so page 2 continues at 21, 22, 23... rather than
          // restarting at 1. Computed client-side from the current page and
          // page size; nothing to store or keep in sync server-side.
          const startingSrNo = (currentPage - 1) * pageSize + 1;
          tableBody.innerHTML = data
            .map((item, index) => {
              const srNo = startingSrNo + index;
              const cells = config.columns.map((col) => `<td>${col.render(item)}</td>`).join("");
              return `
              <tr>
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
      const totalPages = p.total_pages || 1;
      const current = p.current_page;
      
      const range = [];
      const delta = 2;
      for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= current - delta && i <= current + delta)) {
          range.push(i);
        }
      }

      let pageNumButtons = "";
      let last = 0;
      for (let i of range) {
        if (last) {
          if (i - last === 2) {
            pageNumButtons += `<button class="btn btn-small" data-page="${last + 1}">${last + 1}</button>`;
          } else if (i - last > 2) {
            pageNumButtons += `<span class="muted" style="padding: 0 4px; font-weight: bold; align-self: center;">...</span>`;
          }
        }
        const isCurrent = i === current;
        const btnClass = isCurrent ? "btn btn-small btn-primary" : "btn btn-small";
        pageNumButtons += `<button class="${btnClass}" data-page="${i}">${i}</button>`;
        last = i;
      }

      pagination.innerHTML = `
        <span class="pagination-info">Page <b>${current}</b> of <b>${totalPages}</b> &middot; <b>${p.total_records}</b> total</span>
        <div class="pagination-controls">
          <button class="btn btn-small" id="prevPage" ${!p.has_previous ? "disabled" : ""}>Previous</button>
          ${pageNumButtons}
          <button class="btn btn-small" id="nextPage" ${!p.has_next ? "disabled" : ""}>Next</button>
        </div>
      `;
      const prev = document.getElementById("prevPage");
      const next = document.getElementById("nextPage");
      if (prev) prev.addEventListener("click", () => { currentPage--; loadTable(); });
      if (next) next.addEventListener("click", () => { currentPage++; loadTable(); });

      pagination.querySelectorAll("button[data-page]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const targetPage = parseInt(e.target.getAttribute("data-page"), 10);
          if (targetPage && targetPage !== currentPage) {
            currentPage = targetPage;
            loadTable();
          }
        });
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
    let pendingSrNoJump = null; // Sr. No. to scroll-to-and-highlight once the target page loads

    // If the person types a bare number into search, treat it as "take me to
    // Sr. No. N" instead of a text search: jump straight to the page that
    // row lives on (computed from page size), then highlight it once loaded.
    // Falls back to a normal text search for anything that isn't a plain integer.
    function isSrNoQuery(value) {
      return /^\d+$/.test(value.trim());
    }

    if (searchInput) {
      searchInput.addEventListener("input", () => {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          const raw = searchInput.value.trim();
          if (raw && isSrNoQuery(raw)) {
            const srNo = parseInt(raw, 10);
            if (srNo >= 1) {
              currentPage = Math.ceil(srNo / pageSize);
              pendingSrNoJump = srNo;
              loadTableForSrNoJump();
              return;
            }
          }
          pendingSrNoJump = null;
          currentPage = 1;
          loadTable();
        }, 300);
      });
    }

    // Loads the table without sending the numeric value as a "search" query
    // param (the backend's search is text-based; a bare Sr. No. isn't a
    // field it knows about) -- it's a pure client-side pagination jump.
    async function loadTableForSrNoJump() {
      const savedValue = searchInput.value;
      searchInput.value = "";
      await loadTable();
      searchInput.value = savedValue;
      if (pendingSrNoJump !== null) {
        const rows = tableBody.querySelectorAll("tr");
        for (const row of rows) {
          const srNoCell = row.querySelector(".cell-srno");
          if (srNoCell && parseInt(srNoCell.textContent, 10) === pendingSrNoJump) {
            row.classList.add("row-highlight");
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            break;
          }
        }
        pendingSrNoJump = null;
      }
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

<<<<<<< HEAD
    // --- Sample CSV Templates ---
    const SAMPLE_TEMPLATES = {
      "product": {
        filename: "sample_products_import.csv",
        content: "product_code,product_name,category_code,sub_category_code,brand_code,hsn_code,uom_code,length,width,height,weight,status,specification\nPROD-001,FR900 Continuous Band Sealer,MAC,SUB-BAND,BR-INH,84223000,PCS,50,30,40,25.5,active,Continuous band sealer for foil and plastic bags\nPROD-002,Citric Acid Anhydrous,ING,SUB-CITRIC,BR-FBQ,29181400,KG,0,0,0,25.0,active,Food grade citric acid 99.5%\n"
      },
      "state": {
        filename: "sample_states_import.csv",
        content: "name,code,country_code,status\nMaharashtra,MH,IND,active\nGujarat,GJ,IND,active\nKampala District,KAMP,UG,active\n"
      },
      "city": {
        filename: "sample_cities_import.csv",
        content: "name,code,state_name,country_code,status\nMumbai,MUM,Maharashtra,IND,active\nPanaji,PAN,Goa,IND,active\n"
      },
      "country": {
        filename: "sample_countries_import.csv",
        content: "name,code,phone_code,currency,status\nIndia,IND,91,INR,active\nUganda,UG,256,UGX,active\n"
      },
      "HSN code": {
        filename: "sample_hsn_codes_import.csv",
        content: "code,description,gst_percent,refund_vat_percent,status\n84223000,Packaging & Sealing Machinery,18.0,13.0,active\n29181400,Citric Acid Anhydrous,18.0,9.0,active\n"
      },
      "brand": {
        filename: "sample_brands_import.csv",
        content: "name,code,description,status\nInhyma,BR-INH,Official Inhyma Brand,active\nYinglima,BR-YLM,Yinglima Machinery Brand,active\n"
      },
      "product category": {
        filename: "sample_categories_import.csv",
        content: "name,code,description,status\nMachines & Spares,MAC,Packaging machines & spare parts,active\nFood Ingredients,ING,Raw food grade ingredients,active\n"
      },
      "sub-category": {
        filename: "sample_subcategories_import.csv",
        content: "name,code,category_code,description,status\nBand Sealer,SUB-BAND,MAC,Continuous band sealing machines,active\nCitric Acid,SUB-CITRIC,ING,Acidifiers and preservatives,active\n"
      },
      "unit of measurement": {
        filename: "sample_uom_import.csv",
        content: "code,name,status\nPCS,Pieces,active\nKG,Kilogram,active\nSET,Set,active\n"
      }
    };

    // Auto-inject "Download Sample" button right next to Import button!
    const wrapper = document.getElementById("importBtnWrapper");
    if (wrapper) {
      let sampleBtn = document.getElementById("downloadSampleBtn");
      if (!sampleBtn) {
        sampleBtn = document.createElement("button");
        sampleBtn.id = "downloadSampleBtn";
        sampleBtn.className = "btn";
        sampleBtn.type = "button";
        sampleBtn.innerHTML = "📥 Sample Template";
        sampleBtn.title = "Download a pre-formatted CSV template with example data";
        wrapper.parentNode.insertBefore(sampleBtn, wrapper);
      }
      sampleBtn.addEventListener("click", () => {
        const key = (config.entityName || "").toLowerCase();
        const tpl = SAMPLE_TEMPLATES[key] || {
          filename: `sample_${key.replace(/\s+/g, "_")}_import.csv`,
          content: "code,name,status\nEXAMPLE-01,Sample Item 1,active\n"
        };
        const blob = new Blob([tpl.content], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = tpl.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      });
    }

    // --- Import ---
=======
    // --- Import (column-mapping wizard: pick file -> map columns -> import) ---
>>>>>>> origin/main
    const importInput = document.getElementById("importInput");
    if (importInput && config.importHeaders) {
      ImportWizard.attach({
        triggerInputEl: importInput,
        apiBase: config.apiBase,
        entityName: config.entityName,
        importHeaders: config.importHeaders,
        summaryEl: importSummaryEl,
        onComplete: async () => {
          await loadTable();
        },
      });
    }

    if (config.loadLookups) await config.loadLookups();
    await loadTable();

    return { loadTable, openModal, closeModal };
  }

  return { init, badge, fieldValue, setFieldValue };
})();