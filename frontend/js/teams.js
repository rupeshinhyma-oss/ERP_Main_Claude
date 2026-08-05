/**
 * Teams page controller.
 *
 * Merges the previously-separate Departments/Designations/Employees pages
 * into one page with a sub-tab bar (Employees is the default landing tab,
 * since "Add Member" -- the page's primary action -- creates an
 * Employee+User). Departments and Designations keep their existing
 * inline create/edit form pattern; Employees stays a list-only view
 * (full employee detail/edit remains on employee-detail.html /
 * employee-form.html, unchanged, reachable via the "View" link per row).
 *
 * The "Add Member" flow calls POST /api/v1/members (see
 * app.members.routes on the backend), which creates a login-capable User
 * + linked Employee + default 'employee' role in one call, and returns a
 * server-generated temporary password exactly once. No password is ever
 * entered by the admin -- see the module docstring in
 * app/members/service.py for why.
 */

const TeamsPage = (() => {
  let departmentsCache = [];
  let designationsCache = [];
  let employeesCache = [];

  // ------------------------------------------------------------------
  // Sub-tab switching
  // ------------------------------------------------------------------

  function switchTab(tab) {
    document.querySelectorAll(".subtab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-tab") === tab);
    });
    document.querySelectorAll(".subtab-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `panel-${tab}`);
    });
  }

  function initSubTabs() {
    document.querySelectorAll(".subtab-btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
    });
  }

  // ------------------------------------------------------------------
  // Shared lookups (departments + designations, used across all 3 tabs)
  // ------------------------------------------------------------------

  async function loadSharedLookups() {
    try {
      const [deptRes, desigRes, empRes] = await Promise.all([
        apiGet("/departments" + toQueryString({ page: 1, page_size: 100, sort_order: "asc" })),
        apiGet("/designations" + toQueryString({ page: 1, page_size: 100, sort_order: "asc" })),
        apiGet("/employees" + toQueryString({ page: 1, page_size: 100, sort_order: "asc" })),
      ]);
      departmentsCache = deptRes.data;
      designationsCache = desigRes.data;
      employeesCache = empRes.data;
    } catch (e) {
      /* filters/dropdowns degrade gracefully without lookups */
    }
  }

  function departmentName(id) {
    const d = departmentsCache.find((x) => x.id === id);
    return d ? d.name : "—";
  }
  function designationTitle(id) {
    const d = designationsCache.find((x) => x.id === id);
    return d ? d.title : "—";
  }
  function employeeName(id) {
    const e = employeesCache.find((x) => x.id === id);
    return e ? e.display_name : "—";
  }

  function populateDropdown(selectEl, items, valueKey, labelFn) {
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item[valueKey];
      opt.textContent = labelFn(item);
      selectEl.appendChild(opt);
    }
  }

  // ==================================================================
  // EMPLOYEES TAB
  // ==================================================================

  const emp = { page: 1, pageSize: 20 };

  function empStatusBadgeClass(status) {
    if (status === "ACTIVE") return "badge-active";
    if (status === "INACTIVE" || status === "TERMINATED" || status === "RESIGNED") return "badge-inactive";
    return "badge-neutral";
  }

  /**
   * Password reveal/reset cell for one Employees-tab row.
   *
   * Only shown for employees with a linked user_id (accounts created
   * outside the Teams "Add Member" flow, e.g. via the separate Users
   * admin API, may have no stored vault entry to reveal) and only when
   * the current admin has settings.manage -- the same permission the
   * backend's reveal/reset endpoints require, so the UI never offers an
   * action that would just 403.
   */
  function passwordCellHtml(employee, canManagePasswords) {
    if (!canManagePasswords || !employee.user_id) {
      return '<span class="muted">—</span>';
    }
    return `
      <div class="password-cell" data-user-id="${employee.user_id}">
        <span class="password-dots" data-role="display">••••••••</span>
        <button type="button" class="eye-toggle-btn" data-action="reveal" data-user-id="${employee.user_id}" title="Show password">👁</button>
        <button type="button" class="btn btn-small" data-action="reset-password" data-user-id="${employee.user_id}">Reset</button>
      </div>`;
  }

  async function loadEmployeesTable() {
    const banner = document.getElementById("banner");
    const tableBody = document.getElementById("empTableBody");
    tableBody.innerHTML = '<tr><td colspan="8" class="muted">Loading...</td></tr>';
    const canManagePasswords = Auth.hasPermission("settings.manage");
    const params = {
      page: emp.page,
      page_size: emp.pageSize,
      sort_order: "asc",
      search: document.getElementById("empSearchInput").value.trim(),
      department_id: document.getElementById("empDepartmentFilter").value,
      designation_id: document.getElementById("empDesignationFilter").value,
      employment_status: document.getElementById("empStatusFilter").value,
    };
    try {
      const { data, meta } = await apiGet("/employees" + toQueryString(params));
      if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="8" class="muted">No employees found.</td></tr>';
      } else {
        // Sr. No. is a running number across the whole result set (page-aware),
        // same convention as every Master Data list and Suppliers.
        const startingSrNo = (emp.page - 1) * emp.pageSize + 1;
        tableBody.innerHTML = data.map((e, index) => `
          <tr>
            <td class="cell-srno">${startingSrNo + index}</td>
            <td>${escapeHtml(e.employee_code)}</td>
            <td><a href="./employee-detail.html?id=${e.id}">${escapeHtml(e.display_name)}</a></td>
            <td>${e.department_id ? escapeHtml(departmentName(e.department_id)) : "—"}</td>
            <td>${e.designation_id ? escapeHtml(designationTitle(e.designation_id)) : "—"}</td>
            <td><span class="badge ${empStatusBadgeClass(e.employment_status)}">${escapeHtml(e.employment_status)}</span></td>
            <td>${passwordCellHtml(e, canManagePasswords)}</td>
            <td class="actions"><a class="btn btn-small" href="./employee-detail.html?id=${e.id}">View</a></td>
          </tr>`).join("");
      }
      renderEmpPagination(meta.pagination);
    } catch (err) {
      tableBody.innerHTML = "";
      showError(banner, err);
    }
  }

  function renderEmpPagination(p) {
    const pagination = document.getElementById("empPagination");
    pagination.innerHTML = `
      <span class="muted">Page ${p.current_page} of ${p.total_pages || 1} &middot; ${p.total_records} total</span>
      <div>
        <button class="btn btn-small" id="empPrevPage" ${!p.has_previous ? "disabled" : ""}>Previous</button>
        <button class="btn btn-small" id="empNextPage" ${!p.has_next ? "disabled" : ""}>Next</button>
      </div>`;
    const prev = document.getElementById("empPrevPage");
    const next = document.getElementById("empNextPage");
    if (prev) prev.addEventListener("click", () => { emp.page--; loadEmployeesTable(); });
    if (next) next.addEventListener("click", () => { emp.page++; loadEmployeesTable(); });
  }

  function initEmployeesTab() {
    // Department/designation filter dropdowns are populated in init(),
    // once loadSharedLookups() resolves (they'd be empty if populated here).

    let searchDebounce;
    let empPendingSrNoJump = null;

    function isSrNoQuery(value) {
      return /^\d+$/.test(value.trim());
    }

    async function loadEmployeesTableForSrNoJump() {
      const searchInputEl = document.getElementById("empSearchInput");
      const savedValue = searchInputEl.value;
      searchInputEl.value = "";
      await loadEmployeesTable();
      searchInputEl.value = savedValue;
      if (empPendingSrNoJump !== null) {
        const rows = document.getElementById("empTableBody").querySelectorAll("tr");
        for (const row of rows) {
          const srNoCell = row.querySelector(".cell-srno");
          if (srNoCell && parseInt(srNoCell.textContent, 10) === empPendingSrNoJump) {
            row.classList.add("row-highlight");
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            break;
          }
        }
        empPendingSrNoJump = null;
      }
    }

    document.getElementById("empSearchInput").addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        const raw = document.getElementById("empSearchInput").value.trim();
        if (raw && isSrNoQuery(raw)) {
          const srNo = parseInt(raw, 10);
          if (srNo >= 1) {
            emp.page = Math.ceil(srNo / emp.pageSize);
            empPendingSrNoJump = srNo;
            loadEmployeesTableForSrNoJump();
            return;
          }
        }
        empPendingSrNoJump = null;
        emp.page = 1;
        loadEmployeesTable();
      }, 300);
    });
    ["empDepartmentFilter", "empDesignationFilter", "empStatusFilter"].forEach((id) => {
      document.getElementById(id).addEventListener("change", () => { emp.page = 1; loadEmployeesTable(); });
    });

    document.getElementById("empTableBody").addEventListener("click", async (e) => {
      const banner = document.getElementById("banner");
      const revealBtn = e.target.closest('[data-action="reveal"]');
      const resetBtn = e.target.closest('[data-action="reset-password"]');

      if (revealBtn) {
        const userId = revealBtn.getAttribute("data-user-id");
        const cell = revealBtn.closest(".password-cell");
        const display = cell.querySelector('[data-role="display"]');
        const isRevealed = revealBtn.getAttribute("data-revealed") === "true";
        if (isRevealed) {
          display.textContent = "••••••••";
          revealBtn.setAttribute("data-revealed", "false");
          revealBtn.title = "Show password";
          return;
        }
        try {
          const { data } = await apiGet(`/members/${userId}/password`);
          display.textContent = data.password;
          revealBtn.setAttribute("data-revealed", "true");
          revealBtn.title = "Hide password";
        } catch (err) {
          showError(banner, err);
        }
      } else if (resetBtn) {
        openPasswordResetModal(resetBtn.getAttribute("data-user-id"));
      }
    });
  }

  // ==================================================================
  // PASSWORD RESET MODAL (Employees tab eye icon "Reset" button)
  // ==================================================================

  function openPasswordResetModal(userId) {
    document.getElementById("passwordResetForm").reset();
    document.getElementById("passwordResetBanner").innerHTML = "";
    document.getElementById("resetUserId").value = userId;
    openModalShell(document.getElementById("passwordResetBackdrop"));
  }

  function closePasswordResetModal() {
    closeModalShell(document.getElementById("passwordResetBackdrop"));
  }

  function initPasswordResetModal() {
    document.getElementById("passwordResetCloseBtn").addEventListener("click", closePasswordResetModal);
    document.getElementById("passwordResetCancelBtn").addEventListener("click", closePasswordResetModal);
    document.getElementById("passwordResetBackdrop").addEventListener("click", (e) => {
      if (e.target === document.getElementById("passwordResetBackdrop")) closePasswordResetModal();
    });

    wirePasswordEyeToggle("reset_password", "resetPasswordToggle");

    document.getElementById("passwordResetForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const banner = document.getElementById("passwordResetBanner");
      banner.innerHTML = "";
      const userId = document.getElementById("resetUserId").value;
      const newPassword = document.getElementById("reset_password").value;
      try {
        await apiPatch(`/members/${userId}/password`, { password: newPassword });
        closePasswordResetModal();
        await loadEmployeesTable(); // re-collapse any previously-revealed password for this row
      } catch (err) {
        showError(banner, err);
      }
    });
  }

  /** Wires a show/hide toggle button next to a password <input>. */
  function wirePasswordEyeToggle(inputId, toggleBtnId) {
    const input = document.getElementById(inputId);
    const toggleBtn = document.getElementById(toggleBtnId);
    toggleBtn.addEventListener("click", () => {
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      toggleBtn.title = showing ? "Show password" : "Hide password";
    });
  }

  // ==================================================================
  // DEPARTMENTS TAB
  // ==================================================================

  const dept = { page: 1, pageSize: 20 };

  function badge(status) {
    const cls = status === "active" ? "badge-active" : "badge-inactive";
    return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
  }

  async function loadDepartmentsTable() {
    const banner = document.getElementById("banner");
    const tableBody = document.getElementById("deptTableBody");
    tableBody.innerHTML = '<tr><td colspan="7" class="muted">Loading...</td></tr>';
    const params = {
      page: dept.page,
      page_size: dept.pageSize,
      sort_order: "asc",
      search: document.getElementById("deptSearchInput").value.trim(),
      status: document.getElementById("deptStatusFilter").value,
    };
    try {
      const { data, meta } = await apiGet("/departments" + toQueryString(params));
      const canUpdate = Auth.hasPermission("department.update");
      const canDelete = Auth.hasPermission("department.delete");
      if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="7" class="muted">No departments found.</td></tr>';
      } else {
        const startingSrNo = (dept.page - 1) * dept.pageSize + 1;
        tableBody.innerHTML = data.map((d, index) => `
          <tr>
            <td class="cell-srno">${startingSrNo + index}</td>
            <td>${escapeHtml(d.code)}</td>
            <td>${escapeHtml(d.name)}</td>
            <td>${d.parent_department_id ? escapeHtml(departmentName(d.parent_department_id)) : "—"}</td>
            <td>${d.manager_id ? escapeHtml(employeeName(d.manager_id)) : "—"}</td>
            <td>${badge(d.status)}</td>
            <td class="actions">
              ${canUpdate ? `<button class="btn btn-small" data-edit="${d.id}">Edit</button>` : ""}
              ${canDelete ? `<button class="btn btn-small btn-danger" data-delete="${d.id}">Delete</button>` : ""}
            </td>
          </tr>`).join("");
      }
      renderDeptPagination(meta.pagination);
    } catch (err) {
      tableBody.innerHTML = "";
      showError(banner, err);
    }
  }

  function renderDeptPagination(p) {
    const pagination = document.getElementById("deptPagination");
    pagination.innerHTML = `
      <span class="muted">Page ${p.current_page} of ${p.total_pages || 1} &middot; ${p.total_records} total</span>
      <div>
        <button class="btn btn-small" id="deptPrevPage" ${!p.has_previous ? "disabled" : ""}>Previous</button>
        <button class="btn btn-small" id="deptNextPage" ${!p.has_next ? "disabled" : ""}>Next</button>
      </div>`;
    const prev = document.getElementById("deptPrevPage");
    const next = document.getElementById("deptNextPage");
    if (prev) prev.addEventListener("click", () => { dept.page--; loadDepartmentsTable(); });
    if (next) next.addEventListener("click", () => { dept.page++; loadDepartmentsTable(); });
  }

  function openDeptForm(d) {
    const form = document.getElementById("deptForm");
    form.reset();
    document.getElementById("deptId").value = d ? d.id : "";
    document.getElementById("deptFormTitle").textContent = d ? "Edit department" : "New department";
    document.getElementById("dept_code").value = d ? d.code : "";
    document.getElementById("dept_name").value = d ? d.name : "";
    document.getElementById("dept_description").value = d ? d.description || "" : "";
    document.getElementById("parent_department_id").value = d ? d.parent_department_id || "" : "";
    document.getElementById("manager_id").value = d ? d.manager_id || "" : "";
    document.getElementById("dept_status").value = d ? d.status : "active";
    const card = document.getElementById("deptFormCard");
    card.style.display = "block";
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initDepartmentsTab() {
    const canCreate = Auth.hasPermission("department.create");
    if (!canCreate) document.getElementById("newDeptBtn").style.display = "none";

    // Parent-department/manager dropdowns are populated in init(), once
    // loadSharedLookups() resolves.

    document.getElementById("newDeptBtn").addEventListener("click", () => openDeptForm(null));
    document.getElementById("deptCancelBtn").addEventListener("click", () => {
      document.getElementById("deptFormCard").style.display = "none";
    });

    document.getElementById("deptForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const banner = document.getElementById("banner");
      banner.innerHTML = "";
      const id = document.getElementById("deptId").value;
      const payload = {
        code: document.getElementById("dept_code").value.trim(),
        name: document.getElementById("dept_name").value.trim(),
        description: document.getElementById("dept_description").value.trim() || null,
        parent_department_id: document.getElementById("parent_department_id").value || null,
        manager_id: document.getElementById("manager_id").value || null,
        status: document.getElementById("dept_status").value,
      };
      try {
        if (id) await apiPatch(`/departments/${id}`, payload);
        else await apiPost("/departments", payload);
        document.getElementById("deptFormCard").style.display = "none";
        await loadSharedLookups();
        await loadDepartmentsTable();
      } catch (err) {
        showError(banner, err);
      }
    });

    document.getElementById("deptTableBody").addEventListener("click", async (e) => {
      const editId = e.target.getAttribute("data-edit");
      const deleteId = e.target.getAttribute("data-delete");
      const banner = document.getElementById("banner");
      if (editId) {
        try {
          const { data } = await apiGet(`/departments/${editId}`);
          openDeptForm(data);
        } catch (err) {
          showError(banner, err);
        }
      } else if (deleteId) {
        if (!confirm("Delete this department? This cannot be undone.")) return;
        try {
          await apiDelete(`/departments/${deleteId}`);
          await loadDepartmentsTable();
        } catch (err) {
          showError(banner, err);
        }
      }
    });

    let searchDebounce;
    let deptPendingSrNoJump = null;

    function isDeptSrNoQuery(value) {
      return /^\d+$/.test(value.trim());
    }

    async function loadDepartmentsTableForSrNoJump() {
      const searchInputEl = document.getElementById("deptSearchInput");
      const savedValue = searchInputEl.value;
      searchInputEl.value = "";
      await loadDepartmentsTable();
      searchInputEl.value = savedValue;
      if (deptPendingSrNoJump !== null) {
        const rows = document.getElementById("deptTableBody").querySelectorAll("tr");
        for (const row of rows) {
          const srNoCell = row.querySelector(".cell-srno");
          if (srNoCell && parseInt(srNoCell.textContent, 10) === deptPendingSrNoJump) {
            row.classList.add("row-highlight");
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            break;
          }
        }
        deptPendingSrNoJump = null;
      }
    }

    document.getElementById("deptSearchInput").addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        const raw = document.getElementById("deptSearchInput").value.trim();
        if (raw && isDeptSrNoQuery(raw)) {
          const srNo = parseInt(raw, 10);
          if (srNo >= 1) {
            dept.page = Math.ceil(srNo / dept.pageSize);
            deptPendingSrNoJump = srNo;
            loadDepartmentsTableForSrNoJump();
            return;
          }
        }
        deptPendingSrNoJump = null;
        dept.page = 1;
        loadDepartmentsTable();
      }, 300);
    });
    document.getElementById("deptStatusFilter").addEventListener("change", () => { dept.page = 1; loadDepartmentsTable(); });
  }

  // ==================================================================
  // DESIGNATIONS TAB
  // ==================================================================

  const desig = { page: 1, pageSize: 20 };

  async function loadDesignationsTable() {
    const banner = document.getElementById("banner");
    const tableBody = document.getElementById("desigTableBody");
    tableBody.innerHTML = '<tr><td colspan="6" class="muted">Loading...</td></tr>';
    const params = {
      page: desig.page,
      page_size: desig.pageSize,
      sort_order: "asc",
      search: document.getElementById("desigSearchInput").value.trim(),
      status: document.getElementById("desigStatusFilter").value,
    };
    try {
      const { data, meta } = await apiGet("/designations" + toQueryString(params));
      const canUpdate = Auth.hasPermission("designation.update");
      const canDelete = Auth.hasPermission("designation.delete");
      if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="6" class="muted">No designations found.</td></tr>';
      } else {
        const startingSrNo = (desig.page - 1) * desig.pageSize + 1;
        tableBody.innerHTML = data.map((d, index) => `
          <tr>
            <td class="cell-srno">${startingSrNo + index}</td>
            <td>${escapeHtml(d.code)}</td>
            <td>${escapeHtml(d.title)}</td>
            <td>${d.level ?? "—"}</td>
            <td>${badge(d.status)}</td>
            <td class="actions">
              ${canUpdate ? `<button class="btn btn-small" data-edit="${d.id}">Edit</button>` : ""}
              ${canDelete ? `<button class="btn btn-small btn-danger" data-delete="${d.id}">Delete</button>` : ""}
            </td>
          </tr>`).join("");
      }
      renderDesigPagination(meta.pagination);
    } catch (err) {
      tableBody.innerHTML = "";
      showError(banner, err);
    }
  }

  function renderDesigPagination(p) {
    const pagination = document.getElementById("desigPagination");
    pagination.innerHTML = `
      <span class="muted">Page ${p.current_page} of ${p.total_pages || 1} &middot; ${p.total_records} total</span>
      <div>
        <button class="btn btn-small" id="desigPrevPage" ${!p.has_previous ? "disabled" : ""}>Previous</button>
        <button class="btn btn-small" id="desigNextPage" ${!p.has_next ? "disabled" : ""}>Next</button>
      </div>`;
    const prev = document.getElementById("desigPrevPage");
    const next = document.getElementById("desigNextPage");
    if (prev) prev.addEventListener("click", () => { desig.page--; loadDesignationsTable(); });
    if (next) next.addEventListener("click", () => { desig.page++; loadDesignationsTable(); });
  }

  function openDesigForm(d) {
    const form = document.getElementById("desigForm");
    form.reset();
    document.getElementById("desigId").value = d ? d.id : "";
    document.getElementById("desigFormTitle").textContent = d ? "Edit designation" : "New designation";
    document.getElementById("desig_code").value = d ? d.code : "";
    document.getElementById("desig_title").value = d ? d.title : "";
    document.getElementById("desig_level").value = d && d.level !== null ? d.level : "";
    document.getElementById("desig_description").value = d ? d.description || "" : "";
    document.getElementById("desig_status").value = d ? d.status : "active";
    const card = document.getElementById("desigFormCard");
    card.style.display = "block";
    card.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function initDesignationsTab() {
    const canCreate = Auth.hasPermission("designation.create");
    if (!canCreate) document.getElementById("newDesigBtn").style.display = "none";

    document.getElementById("newDesigBtn").addEventListener("click", () => openDesigForm(null));
    document.getElementById("desigCancelBtn").addEventListener("click", () => {
      document.getElementById("desigFormCard").style.display = "none";
    });

    document.getElementById("desigForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const banner = document.getElementById("banner");
      banner.innerHTML = "";
      const id = document.getElementById("desigId").value;
      const levelRaw = document.getElementById("desig_level").value;
      const payload = {
        code: document.getElementById("desig_code").value.trim(),
        title: document.getElementById("desig_title").value.trim(),
        description: document.getElementById("desig_description").value.trim() || null,
        level: levelRaw === "" ? null : Number(levelRaw),
        status: document.getElementById("desig_status").value,
      };
      try {
        if (id) await apiPatch(`/designations/${id}`, payload);
        else await apiPost("/designations", payload);
        document.getElementById("desigFormCard").style.display = "none";
        await loadSharedLookups();
        await loadDesignationsTable();
      } catch (err) {
        showError(banner, err);
      }
    });

    document.getElementById("desigTableBody").addEventListener("click", async (e) => {
      const editId = e.target.getAttribute("data-edit");
      const deleteId = e.target.getAttribute("data-delete");
      const banner = document.getElementById("banner");
      if (editId) {
        try {
          const { data } = await apiGet(`/designations/${editId}`);
          openDesigForm(data);
        } catch (err) {
          showError(banner, err);
        }
      } else if (deleteId) {
        if (!confirm("Delete this designation? This cannot be undone.")) return;
        try {
          await apiDelete(`/designations/${deleteId}`);
          await loadDesignationsTable();
        } catch (err) {
          showError(banner, err);
        }
      }
    });

    let searchDebounce;
    let desigPendingSrNoJump = null;

    function isDesigSrNoQuery(value) {
      return /^\d+$/.test(value.trim());
    }

    async function loadDesignationsTableForSrNoJump() {
      const searchInputEl = document.getElementById("desigSearchInput");
      const savedValue = searchInputEl.value;
      searchInputEl.value = "";
      await loadDesignationsTable();
      searchInputEl.value = savedValue;
      if (desigPendingSrNoJump !== null) {
        const rows = document.getElementById("desigTableBody").querySelectorAll("tr");
        for (const row of rows) {
          const srNoCell = row.querySelector(".cell-srno");
          if (srNoCell && parseInt(srNoCell.textContent, 10) === desigPendingSrNoJump) {
            row.classList.add("row-highlight");
            row.scrollIntoView({ behavior: "smooth", block: "center" });
            break;
          }
        }
        desigPendingSrNoJump = null;
      }
    }

    document.getElementById("desigSearchInput").addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        const raw = document.getElementById("desigSearchInput").value.trim();
        if (raw && isDesigSrNoQuery(raw)) {
          const srNo = parseInt(raw, 10);
          if (srNo >= 1) {
            desig.page = Math.ceil(srNo / desig.pageSize);
            desigPendingSrNoJump = srNo;
            loadDesignationsTableForSrNoJump();
            return;
          }
        }
        desigPendingSrNoJump = null;
        desig.page = 1;
        loadDesignationsTable();
      }, 300);
    });
    document.getElementById("desigStatusFilter").addEventListener("change", () => { desig.page = 1; loadDesignationsTable(); });
  }

  // ==================================================================
  // ADD MEMBER MODAL
  // ==================================================================

  function openMemberModal() {
    document.getElementById("memberForm").reset();
    document.getElementById("memberFormBanner").innerHTML = "";
    document.getElementById("memberFormStep").style.display = "block";
    document.getElementById("memberViewStep").style.display = "none";
    document.getElementById("memberModalTitle").textContent = "Add Member";
    openModalShell(document.getElementById("memberModalBackdrop"));
  }

  function closeMemberModal() {
    closeModalShell(document.getElementById("memberModalBackdrop"));
  }

  function showMemberViewStep(member) {
    document.getElementById("memberModalTitle").textContent = "Member Added";
    document.getElementById("memberFormStep").style.display = "none";
    document.getElementById("memberViewStep").style.display = "block";
    document.getElementById("viewTempPassword").textContent = member.password;
    document.getElementById("view_full_name").textContent = member.full_name;
    document.getElementById("view_username").textContent = member.username;
    document.getElementById("view_email").textContent = member.email;
    document.getElementById("view_role").textContent = member.role;
    document.getElementById("view_department").textContent = member.department_id ? departmentName(member.department_id) : "—";
    document.getElementById("view_designation").textContent = member.designation_id ? designationTitle(member.designation_id) : "—";
  }

  function initAddMemberModal() {
    const canAdd = Auth.hasPermission("user.create") && Auth.hasPermission("employee.create");
    if (!canAdd) document.getElementById("addMemberBtn").style.display = "none";

    // Department/designation dropdowns are populated in init(), once
    // loadSharedLookups() resolves.
    wirePasswordEyeToggle("member_password", "memberPasswordToggle");

    document.getElementById("addMemberBtn").addEventListener("click", openMemberModal);
    document.getElementById("memberCancelBtn").addEventListener("click", closeMemberModal);
    document.getElementById("memberModalCloseBtn").addEventListener("click", closeMemberModal);
    document.getElementById("memberModalBackdrop").addEventListener("click", (e) => {
      if (e.target === document.getElementById("memberModalBackdrop")) closeMemberModal();
    });

    // "Save & Close" on the view-only confirmation step: the member
    // already exists (created by the Save below) -- this just dismisses
    // the modal and refreshes the Employees list, per the two-step
    // save-then-view-then-confirm flow.
    document.getElementById("memberDoneBtn").addEventListener("click", async () => {
      closeMemberModal();
      await loadSharedLookups();
      await loadEmployeesTable();
    });

    document.getElementById("memberForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const banner = document.getElementById("memberFormBanner");
      banner.innerHTML = "";
      const password = document.getElementById("member_password").value;
      const payload = {
        full_name: document.getElementById("member_full_name").value.trim(),
        email: document.getElementById("member_email").value.trim(),
        password,
        department_id: document.getElementById("member_department_id").value || null,
        designation_id: document.getElementById("member_designation_id").value || null,
      };
      try {
        const { data } = await apiPost("/members", payload);
        // The create response never echoes the password back (see
        // app.members.schemas.TeamMemberRead) -- carry the value the
        // admin just typed through to the view step directly instead.
        showMemberViewStep({ ...data, password });
      } catch (err) {
        showError(banner, err);
      }
    });
  }

  // ==================================================================
  // Init
  // ==================================================================

  async function init() {
    initSubTabs();

    // Run lookups and every tab's initial table load in parallel instead
    // of waiting for lookups to fully finish first -- see the earlier
    // performance fix; re-applied here since this file was re-uploaded
    // from a version that predates it.
    const lookupsPromise = loadSharedLookups();

    initEmployeesTab();
    initDepartmentsTab();
    initDesignationsTab();
    initAddMemberModal();
    initPasswordResetModal();

    await lookupsPromise;
    populateDropdown(document.getElementById("empDepartmentFilter"), departmentsCache, "id", (d) => d.name);
    populateDropdown(document.getElementById("empDesignationFilter"), designationsCache, "id", (d) => d.title);
    populateDropdown(document.getElementById("parent_department_id"), departmentsCache, "id", (d) => `${d.code} — ${d.name}`);
    populateDropdown(document.getElementById("manager_id"), employeesCache, "id", (e) => `${e.display_name} (${e.employee_code})`);
    populateDropdown(document.getElementById("member_department_id"), departmentsCache, "id", (d) => d.name);
    populateDropdown(document.getElementById("member_designation_id"), designationsCache, "id", (d) => d.title);

    await Promise.all([loadEmployeesTable(), loadDepartmentsTable(), loadDesignationsTable()]);
  }

  return { init };
})();