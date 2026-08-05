/**
 * Supplier Profiles page controller.
 *
 * Implements the "Supplier Profile" document's list view (Top Filter
 * Fields, truncated multi-value columns with a "view more" expander,
 * inline editable Grade/Potential dropdowns) and the two-step
 * First-Data-Form / Main-Profile-Form creation flow, plus the Contacts
 * sub-panel ("Add Contacts Form/List").
 *
 * Country/State/City/Category/Sub-Category selectors are all type-ahead
 * (SearchableDropdown, see dropdown-search.js) rather than pre-loaded
 * <select> lists: Cities in particular can realistically reach tens of
 * thousands of rows, and a plain <select> with that many options is both
 * slow to render and effectively unusable to scroll through. Table-column
 * name lookups (Country/State/City/Category names shown per row) use a
 * bounded NameResolver cache that only ever resolves the IDs actually
 * present on the current page of results, not the full related tables.
 */

const SupplierPage = (() => {
  const MAX_CHIPS = 5; // document: "5 items to show in list, if more then that to view by eye button"

  let currentPage = 1;
  let pageSize = 20;
  let currentSupplierId = null; // set once the supplier being edited/created has been saved

  // --- Bounded name-resolver for table columns (see dropdown-search.js) ---
  async function fetchNamesByIds(apiBase, ids, labelFn) {
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          const { data } = await apiGet(`${apiBase}/${id}`);
          return [id, labelFn ? labelFn(data) : data.name];
        } catch (e) {
          return [id, null];
        }
      })
    );
    return results.filter(([, label]) => label !== null);
  }

  const resolver = NameResolver.create({
    countries: (ids) => fetchNamesByIds("/masters/countries", ids),
    states: (ids) => fetchNamesByIds("/masters/states", ids),
    cities: (ids) => fetchNamesByIds("/masters/cities", ids),
    categories: (ids) => fetchNamesByIds("/masters/product-categories", ids),
    subCategories: (ids) => fetchNamesByIds("/masters/product-sub-categories", ids),
    products: (ids) => fetchNamesByIds("/masters/products", ids, (d) => d.product_name),
  });

  function chipListHtml(ids, tableKey, fieldLabel) {
    if (!ids || !ids.length) return '<span class="muted">—</span>';
    const names = ids.map((id) => resolver.get(tableKey, id) || "…");
    const shown = names.slice(0, MAX_CHIPS);
    const remaining = names.length - shown.length;
    const chips = shown.map((n) => `<span class="chip">${escapeHtml(n)}</span>`).join("");
    const more = remaining > 0
      ? `<button type="button" class="chip-more" data-expand="${fieldLabel}" title="${escapeHtml(names.join(', '))}">+${remaining} more</button>`
      : "";
    return `<div class="chip-list">${chips}${more}</div>`;
  }

  function statusBadge(value) {
    if (!value) return '<span class="badge badge-neutral">Select</span>';
    const isPositive = value === "existing" || value === "yes" || value === "active";
    const cls = isPositive ? "badge-active" : "badge-neutral";
    const label = value === "existing" ? "Existing" : value === "new" ? "New" : value === "yes" ? "Yes" : value === "no" ? "No" : value;
    return `<span class="badge ${cls}">${escapeHtml(label)}</span>`;
  }

  // ------------------------------------------------------------------
  // Type-ahead dropdown fields (form + filters)
  // ------------------------------------------------------------------

  function searchFetcher(apiBase, extraParamsFn) {
    return async (term, signal) => {
      const extra = extraParamsFn ? extraParamsFn() : {};
      const { data } = await apiGet(
        apiBase + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active", ...extra }),
        { signal }
      );
      return data.map((d) => ({ value: d.id, label: d.name }));
    };
  }

  // Form fields
  let countryField, stateField, cityField, categoryMultiField, subCategoryMultiField, productMultiField, contactCountryField;
  // Filter fields
  let countryFilterField, stateFilterField, cityFilterField, categoryFilterField, subCategoryFilterField, productFilterField;

  let selectedCountryId = null; // drives state field's scoping
  let selectedStateId = null; // drives city field's scoping
  let filterCountryId = "";
  let filterStateId = "";

  function initDropdownFields() {
    // --- First Data Form: Country -> State -> City (cascading) ---
    countryField = SearchableDropdown.create({
      mountEl: document.getElementById("countryMount"),
      placeholder: "Search country...",
      fetchOptions: searchFetcher("/masters/countries"),
      fetchLabelForValue: async (id) => (await apiGet(`/masters/countries/${id}`)).data.name,
      onChange: (value) => {
        selectedCountryId = value;
        stateField.clear();
        cityField.clear();
      },
    });

    stateField = SearchableDropdown.create({
      mountEl: document.getElementById("stateMount"),
      placeholder: "Search province...",
      fetchOptions: async (term, signal) => {
        const params = { search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" };
        if (selectedCountryId) params.country_id = selectedCountryId;
        const { data } = await apiGet("/masters/states" + toQueryString(params), { signal });
        return data.map((d) => ({ value: d.id, label: d.name }));
      },
      fetchLabelForValue: async (id) => (await apiGet(`/masters/states/${id}`)).data.name,
      onChange: (value) => {
        selectedStateId = value;
        cityField.clear();
      },
    });

    cityField = SearchableDropdown.create({
      mountEl: document.getElementById("cityMount"),
      placeholder: "Search city...",
      fetchOptions: async (term, signal) => {
        const params = { search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" };
        if (selectedStateId) params.state_id = selectedStateId;
        const { data } = await apiGet("/masters/cities" + toQueryString(params), { signal });
        return data.map((d) => ({ value: d.id, label: d.name }));
      },
      fetchLabelForValue: async (id) => (await apiGet(`/masters/cities/${id}`)).data.name,
    });

    // --- First Data Form: Product Category (multiple) ---
    categoryMultiField = SearchableDropdown.createMulti({
      mountEl: document.getElementById("categoryMultiMount"),
      placeholder: "Search and add a category...",
      fetchOptions: searchFetcher("/masters/product-categories"),
      fetchLabelForValue: async (id) => (await apiGet(`/masters/product-categories/${id}`)).data.name,
    });

    // --- Main Profile Form: Key Strength Product Sub-Category (multiple) ---
    subCategoryMultiField = SearchableDropdown.createMulti({
      mountEl: document.getElementById("subCategoryMultiMount"),
      placeholder: "Search and add a sub-category...",
      fetchOptions: searchFetcher("/masters/product-sub-categories"),
      fetchLabelForValue: async (id) => (await apiGet(`/masters/product-sub-categories/${id}`)).data.name,
    });

    // --- Main Profile Form: Products Supplied (multiple) -- the specific
    // SKUs (Product master, the central item master) this supplier sources,
    // as opposed to the broader Category/Sub-Category links above. ---
    productMultiField = SearchableDropdown.createMulti({
      mountEl: document.getElementById("productMultiMount"),
      placeholder: "Search and add a product...",
      fetchOptions: async (term, signal) => {
        const { data } = await apiGet(
          "/masters/products" + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" }),
          { signal }
        );
        return data.map((d) => ({ value: d.id, label: `${d.product_code} — ${d.product_name}` }));
      },
      fetchLabelForValue: async (id) => {
        const { data } = await apiGet(`/masters/products/${id}`);
        return `${data.product_code} — ${data.product_name}`;
      },
    });

    // --- Contact sub-form: Country ---
    contactCountryField = SearchableDropdown.create({
      mountEl: document.getElementById("cContactCountryMount"),
      placeholder: "Search country...",
      fetchOptions: searchFetcher("/masters/countries"),
      fetchLabelForValue: async (id) => (await apiGet(`/masters/countries/${id}`)).data.name,
    });

    // --- Top Filter Fields ---
    categoryFilterField = SearchableDropdown.create({
      mountEl: document.getElementById("categoryFilterMount"),
      placeholder: "Filter: Product Category",
      fetchOptions: searchFetcher("/masters/product-categories"),
      onChange: () => { currentPage = 1; loadTable(); },
    });

    subCategoryFilterField = SearchableDropdown.create({
      mountEl: document.getElementById("subCategoryFilterMount"),
      placeholder: "Filter: Key Strength Sub-Category",
      fetchOptions: searchFetcher("/masters/product-sub-categories"),
      onChange: () => { currentPage = 1; loadTable(); },
    });

    productFilterField = SearchableDropdown.create({
      mountEl: document.getElementById("productFilterMount"),
      placeholder: "Filter: Product Supplied",
      fetchOptions: async (term, signal) => {
        const { data } = await apiGet(
          "/masters/products" + toQueryString({ search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" }),
          { signal }
        );
        return data.map((d) => ({ value: d.id, label: `${d.product_code} — ${d.product_name}` }));
      },
      onChange: () => { currentPage = 1; loadTable(); },
    });

    countryFilterField = SearchableDropdown.create({
      mountEl: document.getElementById("countryFilterMount"),
      placeholder: "Filter: Country",
      fetchOptions: searchFetcher("/masters/countries"),
      onChange: (value) => {
        filterCountryId = value || "";
        stateFilterField.clear();
        cityFilterField.clear();
        currentPage = 1;
        loadTable();
      },
    });

    stateFilterField = SearchableDropdown.create({
      mountEl: document.getElementById("stateFilterMount"),
      placeholder: "Filter: Province",
      fetchOptions: async (term, signal) => {
        const params = { search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" };
        if (filterCountryId) params.country_id = filterCountryId;
        const { data } = await apiGet("/masters/states" + toQueryString(params), { signal });
        return data.map((d) => ({ value: d.id, label: d.name }));
      },
      onChange: (value) => {
        filterStateId = value || "";
        cityFilterField.clear();
        currentPage = 1;
        loadTable();
      },
    });

    cityFilterField = SearchableDropdown.create({
      mountEl: document.getElementById("cityFilterMount"),
      placeholder: "Filter: City",
      fetchOptions: async (term, signal) => {
        const params = { search: term, page: 1, page_size: 20, sort_order: "asc", status: "active" };
        if (filterStateId) params.state_id = filterStateId;
        const { data } = await apiGet("/masters/cities" + toQueryString(params), { signal });
        return data.map((d) => ({ value: d.id, label: d.name }));
      },
      onChange: () => { currentPage = 1; loadTable(); },
    });

    // Enum-based filters (small, fixed option sets -- plain <select> is fine).
    ["supplierTypeFilter", "gradeFilter", "statusFilter", "potentialFilter", "visitedFilter"].forEach((id) => {
      document.getElementById(id).addEventListener("change", () => { currentPage = 1; loadTable(); });
    });
  }

  // ------------------------------------------------------------------
  // List table
  // ------------------------------------------------------------------

  async function loadTable() {
    const banner = document.getElementById("banner");
    const tableBody = document.getElementById("tableBody");
    tableBody.innerHTML = '<tr><td colspan="15" class="muted">Loading...</td></tr>';

    const params = {
      page: currentPage,
      page_size: pageSize,
      sort_order: "asc",
      search: document.getElementById("searchInput").value.trim(),
      country_id: filterCountryId,
      state_id: filterStateId,
      city_id: cityFilterField.getValue() || "",
      supplier_type: document.getElementById("supplierTypeFilter").value,
      supplier_grade: document.getElementById("gradeFilter").value,
      current_status: document.getElementById("statusFilter").value,
      potential: document.getElementById("potentialFilter").value,
      visited_factory_office: document.getElementById("visitedFilter").value,
      category_id: categoryFilterField.getValue() || "",
      sub_category_id: subCategoryFilterField.getValue() || "",
      product_id: productFilterField.getValue() || "",
    };

    try {
      const { data, meta } = await apiGet("/suppliers" + toQueryString(params));
      if (!data.length) {
        tableBody.innerHTML = '<tr><td colspan="15" class="muted">No suppliers found.</td></tr>';
      } else {
        // Resolve every related name needed for this page's rows only
        // (bounded by page size, not by how large Countries/Cities/etc.
        // grow -- see the NameResolver docs in dropdown-search.js).
        await Promise.all([
          resolver.resolve("countries", data.map((s) => s.country_id)),
          resolver.resolve("states", data.map((s) => s.state_id)),
          resolver.resolve("cities", data.map((s) => s.city_id)),
          resolver.resolve("categories", data.flatMap((s) => s.category_ids || [])),
          resolver.resolve("subCategories", data.flatMap((s) => s.sub_category_ids || [])),
          resolver.resolve("products", data.flatMap((s) => s.product_ids || [])),
        ]);
        tableBody.innerHTML = data.map(rowHtml).join("");
      }
      renderPagination(meta.pagination);
    } catch (err) {
      tableBody.innerHTML = "";
      showError(banner, err);
    }
  }

  function rowHtml(s, index) {
    const cityName = resolver.get("cities", s.city_id) || "…";
    const stateName = resolver.get("states", s.state_id) || "…";
    const countryName = resolver.get("countries", s.country_id) || "…";
    const srNo = (currentPage - 1) * pageSize + index + 1;
    const canUpdate = Auth.hasPermission("supplier.update");
    const canDelete = Auth.hasPermission("supplier.delete");

    const gradeSelectHtml = canUpdate ? `
      <select class="inline-select" data-grade-for="${s.id}">
        <option value="" ${!s.supplier_grade ? "selected" : ""}>Select</option>
        <option value="A" ${s.supplier_grade === "A" ? "selected" : ""}>A</option>
        <option value="B" ${s.supplier_grade === "B" ? "selected" : ""}>B</option>
        <option value="C" ${s.supplier_grade === "C" ? "selected" : ""}>C</option>
      </select>` : `<span>${escapeHtml(s.supplier_grade || "—")}</span>`;

    const potentialSelectHtml = canUpdate ? `
      <select class="inline-select" data-potential-for="${s.id}">
        <option value="" ${!s.potential ? "selected" : ""}>Select</option>
        <option value="yes" ${s.potential === "yes" ? "selected" : ""}>Yes</option>
        <option value="no" ${s.potential === "no" ? "selected" : ""}>No</option>
      </select>` : `<span>${escapeHtml(s.potential ? s.potential.toUpperCase() : "—")}</span>`;

    return `
      <tr data-supplier-id="${s.id}">
        <td><input type="checkbox" class="row-select" /></td>
        <td class="cell-srno">${srNo}</td>
        <td><a href="#" data-view="${s.id}">${escapeHtml(s.company_name)}</a></td>
        <td>${chipListHtml(s.category_ids, "categories", "category:" + s.id)}</td>
        <td>${chipListHtml(s.sub_category_ids, "subCategories", "subcategory:" + s.id)}</td>
        <td>${chipListHtml(s.product_ids, "products", "product:" + s.id)}</td>
        <td>${s.secondary_products_description ? escapeHtml(s.secondary_products_description).slice(0, 60) : '<span class="muted">—</span>'}</td>
        <td>${escapeHtml(countryName)}</td>
        <td>${escapeHtml(cityName)}, ${escapeHtml(stateName)}</td>
        <td>${s.brand_description ? escapeHtml(s.brand_description) : '<span class="muted">—</span>'}</td>
        <td>${s.supplier_type ? escapeHtml(s.supplier_type) : '<span class="muted">—</span>'}</td>
        <td>${statusBadge(s.current_status)}</td>
        <td>${gradeSelectHtml}</td>
        <td>${potentialSelectHtml}</td>
        <td class="actions">
          ${canUpdate ? `<button class="btn btn-small" data-edit="${s.id}">Edit</button>` : ""}
          ${canDelete ? `<button class="btn btn-small btn-danger" data-delete="${s.id}">Delete</button>` : ""}
        </td>
      </tr>`;
  }

  function renderPagination(p) {
    renderFlexiblePagination(document.getElementById("pagination"), p, {
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

  // ------------------------------------------------------------------
  // Modal / form (First Data Form -> Main Profile -> Contacts)
  // ------------------------------------------------------------------

  function showTab(tab) {
    document.getElementById("tabFirst").style.display = tab === "first" ? "block" : "none";
    document.getElementById("tabSecond").style.display = tab === "second" ? "block" : "none";
    document.getElementById("tabContacts").style.display = tab === "contacts" ? "block" : "none";
  }

  async function openModal(supplier) {
    const form = document.getElementById("entityForm");
    form.reset();
    currentSupplierId = supplier ? supplier.id : null;

    document.getElementById("entityId").value = supplier ? supplier.id : "";
    document.getElementById("modalTitle").textContent = supplier ? `Edit ${supplier.company_name}` : "New Supplier";
    document.getElementById("tabContactsBtn").style.display = supplier ? "inline-flex" : "none";

    // First Data Form fields
    document.getElementById("company_name").value = supplier ? supplier.company_name : "";

    if (supplier) {
      selectedCountryId = supplier.country_id;
      selectedStateId = supplier.state_id;
      await countryField.setValueById(supplier.country_id);
      await stateField.setValueById(supplier.state_id);
      await cityField.setValueById(supplier.city_id);
      await categoryMultiField.setValuesByIds(supplier.category_ids || []);
      await subCategoryMultiField.setValuesByIds(supplier.sub_category_ids || []);
      await productMultiField.setValuesByIds(supplier.product_ids || []);
    } else {
      selectedCountryId = null;
      selectedStateId = null;
      countryField.clear();
      stateField.clear();
      cityField.clear();
      categoryMultiField.clear();
      subCategoryMultiField.clear();
      productMultiField.clear();
    }

    document.getElementById("supplier_type").value = supplier && supplier.supplier_type ? supplier.supplier_type : "";
    document.getElementById("brand_description").value = supplier ? supplier.brand_description || "" : "";
    document.getElementById("contact_salutation").value = supplier ? supplier.contact_salutation || "" : "";
    document.getElementById("contact_full_name").value = supplier ? supplier.contact_full_name || "" : "";
    document.getElementById("contact_designation").value = supplier ? supplier.contact_designation || "" : "";
    document.getElementById("contact_calling_number").value = supplier ? supplier.contact_calling_number || "" : "";
    document.getElementById("contact_whatsapp_number").value = supplier ? supplier.contact_whatsapp_number || "" : "";
    document.getElementById("contact_wechat_number").value = supplier ? supplier.contact_wechat_number || "" : "";
    document.getElementById("emails_input").value = supplier ? (supplier.emails || []).join(", ") : "";

    // Main Profile Form fields
    document.getElementById("tax_id_number").value = supplier ? supplier.tax_id_number || "" : "";
    document.getElementById("town").value = supplier ? supplier.town || "" : "";
    document.getElementById("primary_website").value = supplier ? supplier.primary_website || "" : "";
    document.getElementById("secondary_website").value = supplier ? supplier.secondary_website || "" : "";
    document.getElementById("supplier_grade").value = supplier && supplier.supplier_grade ? supplier.supplier_grade : "";
    document.getElementById("current_status").value = supplier && supplier.current_status ? supplier.current_status : "";
    document.getElementById("potential").value = supplier && supplier.potential ? supplier.potential : "";
    document.getElementById("potential_reason").value = supplier ? supplier.potential_reason || "" : "";
    document.getElementById("secondary_products_description").value = supplier ? supplier.secondary_products_description || "" : "";
    document.getElementById("visited_factory_office").value = supplier ? String(supplier.visited_factory_office) : "false";
    document.getElementById("visit_remarks").value = supplier ? supplier.visit_remarks || "" : "";
    document.getElementById("visit_media_input").value = supplier && supplier.visit_media ? supplier.visit_media.join(", ") : "";
    document.getElementById("overall_remarks").value = supplier ? supplier.overall_remarks || "" : "";
    document.getElementById("is_active").value = supplier ? String(supplier.is_active) : "true";

    updateStatusLockUI(supplier ? supplier.current_status : null);
    updateVisitRemarksVisibility();

    if (supplier) {
      renderContactsTable(supplier.contacts || []);
    }

    showTab("first");
    openModalShell(document.getElementById("modalBackdrop"));
  }

  function closeModal() {
    closeModalShell(document.getElementById("modalBackdrop"));
    currentSupplierId = null;
  }

  function updateStatusLockUI(currentStatus) {
    const statusSelect = document.getElementById("current_status");
    const hint = document.getElementById("statusLockHint");
    const newOption = statusSelect.querySelector('option[value="new"]');
    if (currentStatus === "existing") {
      newOption.disabled = true;
      hint.style.display = "inline";
    } else {
      newOption.disabled = false;
      hint.style.display = "none";
    }
  }

  function updateVisitRemarksVisibility() {
    const visited = document.getElementById("visited_factory_office").value === "true";
    document.getElementById("visitRemarksField").style.display = visited ? "block" : "none";
    if (!visited) document.getElementById("visit_remarks").value = "";
  }

  function buildPayload() {
    const emails = document.getElementById("emails_input").value
      .split(",").map((e) => e.trim()).filter(Boolean);
    const visitMedia = document.getElementById("visit_media_input").value
      .split(",").map((v) => v.trim()).filter(Boolean);

    return {
      company_name: document.getElementById("company_name").value.trim(),
      category_ids: categoryMultiField.getValues(),
      supplier_type: document.getElementById("supplier_type").value || null,
      brand_description: document.getElementById("brand_description").value.trim() || null,
      country_id: countryField.getValue(),
      state_id: stateField.getValue(),
      city_id: cityField.getValue(),
      contact_salutation: document.getElementById("contact_salutation").value || null,
      contact_full_name: document.getElementById("contact_full_name").value.trim() || null,
      contact_designation: document.getElementById("contact_designation").value.trim() || null,
      contact_calling_number: document.getElementById("contact_calling_number").value.trim() || null,
      contact_whatsapp_number: document.getElementById("contact_whatsapp_number").value.trim() || null,
      contact_wechat_number: document.getElementById("contact_wechat_number").value.trim() || null,
      emails,
      tax_id_number: document.getElementById("tax_id_number").value.trim() || null,
      town: document.getElementById("town").value.trim() || null,
      primary_website: document.getElementById("primary_website").value.trim() || null,
      secondary_website: document.getElementById("secondary_website").value.trim() || null,
      sub_category_ids: subCategoryMultiField.getValues(),
      product_ids: productMultiField.getValues(),
      supplier_grade: document.getElementById("supplier_grade").value || null,
      current_status: document.getElementById("current_status").value || null,
      potential: document.getElementById("potential").value || null,
      potential_reason: document.getElementById("potential_reason").value.trim() || null,
      secondary_products_description: document.getElementById("secondary_products_description").value.trim() || null,
      visited_factory_office: document.getElementById("visited_factory_office").value === "true",
      visit_remarks: document.getElementById("visit_remarks").value.trim() || null,
      visit_media: visitMedia.length ? visitMedia : null,
      overall_remarks: document.getElementById("overall_remarks").value.trim() || null,
      is_active: document.getElementById("is_active").value === "true",
    };
  }

  // ------------------------------------------------------------------
  // Contacts sub-panel
  // ------------------------------------------------------------------

  function contactRowHtml(c) {
    const nameDesignation = `${escapeHtml(c.salutation || "")} ${escapeHtml(c.person_name)}${c.designation ? `<br><span class="cell-secondary">${escapeHtml(c.designation)}</span>` : ""}`;
    const callingWhatsapp = [c.calling_number, c.whatsapp_number].filter(Boolean).map(escapeHtml).join(" / ") || "—";
    const wechatEmail = [c.wechat_number, c.email].filter(Boolean).map(escapeHtml).join(" / ") || "—";
    return `
      <tr data-contact-id="${c.id}">
        <td>${nameDesignation}${c.is_primary ? ' <span class="badge badge-neutral">Primary</span>' : ""}</td>
        <td>${callingWhatsapp}</td>
        <td>${wechatEmail}</td>
        <td>${escapeHtml(c.handling_territory || "—")}</td>
        <td class="actions">
          <button class="btn btn-small" data-edit-contact="${c.id}">Edit</button>
          ${!c.is_primary ? `<button class="btn btn-small btn-danger" data-delete-contact="${c.id}">Delete</button>` : ""}
        </td>
      </tr>`;
  }

  function renderContactsTable(contacts) {
    const body = document.getElementById("contactsTableBody");
    body.innerHTML = contacts.length
      ? contacts.map(contactRowHtml).join("")
      : '<tr><td colspan="5" class="muted">No contacts yet.</td></tr>';
  }

  async function refreshContacts() {
    if (!currentSupplierId) return;
    const { data } = await apiGet(`/suppliers/${currentSupplierId}/contacts`);
    renderContactsTable(data);
  }

  async function openContactForm(contact) {
    const form = document.getElementById("contactForm");
    form.reset();
    document.getElementById("contactId").value = contact ? contact.id : "";
    document.getElementById("c_salutation").value = contact ? contact.salutation || "" : "";
    document.getElementById("c_person_name").value = contact ? contact.person_name : "";
    document.getElementById("c_designation").value = contact ? contact.designation || "" : "";
    document.getElementById("c_handling_territory").value = contact ? contact.handling_territory || "" : "";
    if (contact && contact.country_id) await contactCountryField.setValueById(contact.country_id);
    else contactCountryField.clear();
    document.getElementById("c_calling_number").value = contact ? contact.calling_number || "" : "";
    document.getElementById("c_whatsapp_number").value = contact ? contact.whatsapp_number || "" : "";
    document.getElementById("c_wechat_number").value = contact ? contact.wechat_number || "" : "";
    document.getElementById("c_email").value = contact ? contact.email || "" : "";
    document.getElementById("contactFormWrapper").style.display = "block";
  }

  function closeContactForm() {
    document.getElementById("contactFormWrapper").style.display = "none";
  }

  function contactPayload() {
    return {
      salutation: document.getElementById("c_salutation").value || null,
      person_name: document.getElementById("c_person_name").value.trim(),
      designation: document.getElementById("c_designation").value.trim() || null,
      handling_territory: document.getElementById("c_handling_territory").value.trim() || null,
      country_id: contactCountryField.getValue() || null,
      calling_number: document.getElementById("c_calling_number").value.trim() || null,
      whatsapp_number: document.getElementById("c_whatsapp_number").value.trim() || null,
      wechat_number: document.getElementById("c_wechat_number").value.trim() || null,
      email: document.getElementById("c_email").value.trim() || null,
    };
  }

  // ------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------

  function init() {
    const banner = document.getElementById("banner");
    const canCreate = Auth.hasPermission("supplier.create");
    const canUpdate = Auth.hasPermission("supplier.update");

    if (!canCreate) {
      document.getElementById("newBtn").style.display = "none";
      document.getElementById("importBtnWrapper").style.display = "none";
    }

    initDropdownFields();

    document.getElementById("newBtn").addEventListener("click", () => openModal(null));
    document.getElementById("cancelBtn").addEventListener("click", closeModal);
    document.getElementById("modalCloseBtn").addEventListener("click", closeModal);
    document.getElementById("modalBackdrop").addEventListener("click", (e) => {
      if (e.target === document.getElementById("modalBackdrop")) closeModal();
    });

    document.getElementById("goToSecondBtn").addEventListener("click", () => showTab("second"));
    document.getElementById("backToFirstBtn").addEventListener("click", () => showTab("first"));
    document.getElementById("tabFirstBtn").addEventListener("click", () => showTab("first"));
    document.getElementById("tabSecondBtn").addEventListener("click", () => showTab("second"));
    document.getElementById("tabContactsBtn").addEventListener("click", () => showTab("contacts"));
    document.getElementById("doneWithContactsBtn").addEventListener("click", closeModal);

    document.getElementById("visited_factory_office").addEventListener("change", updateVisitRemarksVisibility);

    document.getElementById("entityForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      banner.innerHTML = "";
      const id = document.getElementById("entityId").value;
      const payload = buildPayload();
      try {
        let supplier;
        if (id) {
          const { data } = await apiPatch(`/suppliers/${id}`, payload);
          supplier = data;
        } else {
          const { data } = await apiPost("/suppliers", payload);
          supplier = data;
        }
        currentSupplierId = supplier.id;
        document.getElementById("entityId").value = supplier.id;
        document.getElementById("tabContactsBtn").style.display = "inline-flex";
        renderContactsTable(supplier.contacts || []);
        await loadTable();
        showTab("contacts");
      } catch (err) {
        showError(banner, err);
      }
    });

    // Contacts sub-panel
    document.getElementById("addContactBtn").addEventListener("click", () => openContactForm(null));
    document.getElementById("cancelContactBtn").addEventListener("click", closeContactForm);
    document.getElementById("contactForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!currentSupplierId) return;
      const contactId = document.getElementById("contactId").value;
      const payload = contactPayload();
      try {
        if (contactId) {
          await apiPatch(`/suppliers/${currentSupplierId}/contacts/${contactId}`, payload);
        } else {
          await apiPost(`/suppliers/${currentSupplierId}/contacts`, payload);
        }
        closeContactForm();
        await refreshContacts();
      } catch (err) {
        showError(banner, err);
      }
    });

    document.getElementById("contactsTableBody").addEventListener("click", async (e) => {
      const editId = e.target.getAttribute("data-edit-contact");
      const deleteId = e.target.getAttribute("data-delete-contact");
      if (editId) {
        const { data } = await apiGet(`/suppliers/${currentSupplierId}/contacts`);
        const contact = data.find((c) => c.id === editId);
        if (contact) openContactForm(contact);
      } else if (deleteId) {
        if (!confirm("Delete this contact?")) return;
        try {
          await apiDelete(`/suppliers/${currentSupplierId}/contacts/${deleteId}`);
          await refreshContacts();
        } catch (err) {
          showError(banner, err);
        }
      }
    });

    // List table interactions
    document.getElementById("tableBody").addEventListener("click", async (e) => {
      const editId = e.target.getAttribute("data-edit");
      const viewId = e.target.getAttribute("data-view");
      const expandKey = e.target.getAttribute("data-expand");
      if (editId || viewId) {
        e.preventDefault();
        const id = editId || viewId;
        try {
          const { data } = await apiGet(`/suppliers/${id}`);
          await openModal(data);
        } catch (err) {
          showError(banner, err);
        }
      } else if (expandKey) {
        // "view by eye button" -- full list shown via native tooltip (title attr) already;
        // clicking simply surfaces an alert with the full list for accessibility.
        alert(e.target.getAttribute("title"));
      }
    });

    document.getElementById("tableBody").addEventListener("change", async (e) => {
      const gradeFor = e.target.getAttribute("data-grade-for");
      const potentialFor = e.target.getAttribute("data-potential-for");
      try {
        if (gradeFor) {
          await apiPatch(`/suppliers/${gradeFor}/grade`, { supplier_grade: e.target.value || null });
        } else if (potentialFor) {
          await apiPatch(`/suppliers/${potentialFor}/potential`, { potential: e.target.value || null });
        }
      } catch (err) {
        showError(banner, err);
        await loadTable();
      }
    });

    let searchDebounce;
    let pendingSrNoJump = null; // Sr. No. to scroll-to-and-highlight once the target page loads

    // Same convention as Master Data pages: a bare integer in search means
    // "take me to Sr. No. N" (jump to its page + highlight), not a text search.
    function isSrNoQuery(value) {
      return /^\d+$/.test(value.trim());
    }

    async function loadTableForSrNoJump() {
      const searchInputEl = document.getElementById("searchInput");
      const savedValue = searchInputEl.value;
      searchInputEl.value = "";
      await loadTable();
      searchInputEl.value = savedValue;
      if (pendingSrNoJump !== null) {
        const rows = document.getElementById("tableBody").querySelectorAll("tr");
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

    document.getElementById("searchInput").addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        const raw = document.getElementById("searchInput").value.trim();
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

    // Export
    document.getElementById("exportCsvBtn").addEventListener("click", () => doExport("csv"));
    document.getElementById("exportXlsxBtn").addEventListener("click", () => doExport("xlsx"));

    async function doExport(format) {
      try {
        const token = Auth.getAccessToken();
        const res = await fetch(`${API_ORIGIN}/api/v1/suppliers/export?format=${format}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Export failed.");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `suppliers.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        showError(banner, err);
      }
    }

    // Import (column-mapping wizard: pick file -> map columns -> import)
    ImportWizard.attach({
      triggerInputEl: document.getElementById("importInput"),
      apiBase: "/suppliers",
      entityName: "supplier",
      importHeaders: [
        { key: "company_name", label: "Company Name", required: true },
        { key: "supplier_type", label: "Supplier Type (manufacturer/trader)" },
        { key: "brand_description", label: "Brand Description" },
        { key: "country_code", label: "Country Code", required: true },
        { key: "state_name", label: "State/Province Name", required: true },
        { key: "city_name", label: "City Name", required: true },
        { key: "contact_salutation", label: "Contact Salutation" },
        { key: "contact_full_name", label: "Contact Full Name" },
        { key: "contact_designation", label: "Contact Designation" },
        { key: "contact_calling_number", label: "Contact Calling Number" },
        { key: "contact_whatsapp_number", label: "Contact WhatsApp Number" },
        { key: "contact_wechat_number", label: "Contact WeChat Number" },
        { key: "email", label: "Email" },
        { key: "tax_id_number", label: "Tax ID Number" },
        { key: "address", label: "Address" },
        { key: "town", label: "Town" },
        { key: "primary_website", label: "Primary Website" },
        { key: "secondary_website", label: "Secondary Website" },
        { key: "supplier_grade", label: "Supplier Grade (A/B/C)" },
        { key: "current_status", label: "Current Status (new/existing)" },
        { key: "potential", label: "Potential (yes/no)" },
        { key: "potential_reason", label: "Potential Reason" },
        { key: "secondary_products_description", label: "Secondary Products Description" },
        { key: "visited_factory_office", label: "Visited Factory/Office (true/false)" },
        { key: "visit_remarks", label: "Visit Remarks" },
        { key: "overall_remarks", label: "Overall Remarks" },
        { key: "is_active", label: "Is Active (true/false)" },
      ],
      summaryEl: document.getElementById("importSummary"),
      onComplete: async () => {
        await loadTable();
      },
    });

    loadTable();
  }

  return { init };
})();