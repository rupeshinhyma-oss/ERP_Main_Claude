/**
 * Type-ahead searchable dropdown component.
 *
 * Replaces the old pattern of pre-loading an entire master table into a
 * plain <select> (which breaks outright once a table has more than a few
 * thousand rows -- both because the fetch itself becomes huge, and
 * because a browser <select> with thousands of options is unusable).
 *
 * Instead: renders a text input + a results dropdown. As the user types,
 * calls the backend's `?search=` endpoint (debounced, cancellable) and
 * shows up to ~20 matches. Selecting one stores its id/label; the
 * underlying value is available via `.getValue()` / `.setValue()`.
 *
 * Usage:
 *   const stateField = SearchableDropdown.create({
 *     mountEl: document.getElementById("state_id_mount"),
 *     placeholder: "Search province...",
 *     fetchOptions: async (term, signal) => {
 *       const { data } = await apiGet("/masters/states" + toQueryString({
 *         search: term, page: 1, page_size: 20, sort_order: "asc", status: "active",
 *       }), { signal });
 *       return data.map((s) => ({ value: s.id, label: s.name }));
 *     },
 *     // Optional: resolve a single id back to a label when pre-filling an
 *     // edit form (e.g. the state a supplier already has selected).
 *     fetchLabelForValue: async (id) => {
 *       const { data } = await apiGet(`/masters/states/${id}`);
 *       return data.name;
 *     },
 *     onChange: (value, label) => { ... },
 *   });
 *
 *   stateField.setValue(existingId, existingLabel);   // pre-fill (label known)
 *   await stateField.setValueById(existingId);         // pre-fill (label unknown -- fetches it)
 *   stateField.getValue();                             // -> id or null
 *   stateField.clear();
 *
 * For multi-select (e.g. Product Category, multiple), use
 * SearchableDropdown.createMulti() instead -- same fetchOptions contract,
 * renders selections as removable chips instead of a single value.
 */

const SearchableDropdown = (() => {
  function baseMarkup(placeholder) {
    return `
      <div class="sd-wrap" style="position:relative;">
        <input type="text" class="sd-input" placeholder="${placeholder || 'Search...'}" autocomplete="off" />
        <div class="sd-results" style="display:none;"></div>
      </div>`;
  }

  function ensureStyles() {
    if (document.getElementById("sd-styles")) return;
    const style = document.createElement("style");
    style.id = "sd-styles";
    style.textContent = `
      .sd-wrap { width: 100%; position: relative; }
      .sd-input { width: 100%; border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm);
        padding: 9px 11px; font-size: 13.5px; font-family: inherit; background: var(--color-surface); color: var(--color-text);
        transition: border-color 0.15s ease, box-shadow 0.15s ease; }
      .sd-input:focus { outline: none; border-color: var(--color-primary); box-shadow: 0 0 0 3px var(--color-primary-soft); }
      .sd-results { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 40;
        background: var(--color-surface); border: 1px solid var(--color-border); border-radius: var(--radius-sm);
        box-shadow: 0 10px 25px -5px rgba(16, 24, 40, 0.15); max-height: 240px; overflow-y: auto;
        animation: sdMenuSlide 0.18s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
      @keyframes sdMenuSlide {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .sd-option { padding: 8px 11px; font-size: 13px; cursor: pointer; transition: background-color 0.1s ease; }
      .sd-option:hover, .sd-option.sd-active { background: var(--color-primary-soft); color: var(--color-primary-hover); }
      .sd-empty { padding: 8px 11px; font-size: 12.5px; color: var(--color-muted); }
      .sd-chip-area { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
      .sd-chip { display: inline-flex; align-items: center; gap: 6px; background: var(--color-neutral-soft);
        border-radius: 20px; padding: 3px 6px 3px 10px; font-size: 12px; transition: background-color 0.15s ease; }
      .sd-chip button { border: none; background: none; cursor: pointer; color: var(--color-muted); font-size: 14px; line-height: 1; padding: 0 2px; }
      .sd-chip button:hover { color: var(--color-danger); }
    `;
    document.head.appendChild(style);
  }

  /** Single-select type-ahead dropdown. */
  function create({ mountEl, placeholder, fetchOptions, fetchLabelForValue, onChange }) {
    ensureStyles();
    mountEl.innerHTML = baseMarkup(placeholder);
    const input = mountEl.querySelector(".sd-input");
    const resultsEl = mountEl.querySelector(".sd-results");
    const search = createSearchController();

    let currentValue = null;
    let currentLabel = "";
    let activeIndex = -1;
    let currentOptions = [];

    function closeResults() {
      resultsEl.style.display = "none";
      resultsEl.innerHTML = "";
      activeIndex = -1;
    }

    function renderOptions(options) {
      currentOptions = options;
      if (!options.length) {
        resultsEl.innerHTML = '<div class="sd-empty">No matches.</div>';
      } else {
        resultsEl.innerHTML = options
          .map((opt, i) => `<div class="sd-option" data-index="${i}">${escapeHtml(opt.label)}</div>`)
          .join("");
      }
      resultsEl.style.display = "block";
    }

    function selectOption(opt) {
      currentValue = opt.value;
      currentLabel = opt.label;
      input.value = opt.label;
      closeResults();
      if (onChange) onChange(currentValue, currentLabel);
    }

    input.addEventListener("input", () => {
      const term = input.value.trim();
      if (currentValue !== null) {
        // User is typing again after having a value selected -- clear the
        // stale selection so getValue() doesn't silently return an ID that
        // no longer matches what's shown in the box.
        currentValue = null;
        if (onChange) onChange(null, "");
      }
      if (!term) {
        closeResults();
        return;
      }
      search.run(async (signal) => {
        const options = await fetchOptions(term, signal);
        renderOptions(options || []);
      }, 250);
    });

    input.addEventListener("keydown", (e) => {
      if (resultsEl.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, currentOptions.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIndex >= 0 && currentOptions[activeIndex]) selectOption(currentOptions[activeIndex]);
        return;
      } else if (e.key === "Escape") {
        closeResults();
        return;
      } else {
        return;
      }
      Array.from(resultsEl.children).forEach((el, i) => el.classList.toggle("sd-active", i === activeIndex));
    });

    resultsEl.addEventListener("mousedown", (e) => {
      // mousedown (not click) so this fires before the input's blur handler.
      const optionEl = e.target.closest(".sd-option");
      if (!optionEl) return;
      const idx = parseInt(optionEl.getAttribute("data-index"), 10);
      if (currentOptions[idx]) selectOption(currentOptions[idx]);
    });

    input.addEventListener("blur", () => {
      // Slight delay so a mousedown-selection above can complete first.
      setTimeout(() => {
        closeResults();
        // If the user typed something but never selected a match, revert
        // the visible text to the last real selection (or blank) rather
        // than leaving an ambiguous free-text value in the box.
        if (currentValue === null) input.value = "";
        else input.value = currentLabel;
      }, 150);
    });

    return {
      getValue: () => currentValue,
      getLabel: () => currentLabel,
      setValue(value, label) {
        currentValue = value;
        currentLabel = label || "";
        input.value = currentLabel;
      },
      async setValueById(value) {
        if (!value) {
          this.clear();
          return;
        }
        currentValue = value;
        currentLabel = fetchLabelForValue ? (await fetchLabelForValue(value)) || "" : "";
        input.value = currentLabel;
      },
      clear() {
        currentValue = null;
        currentLabel = "";
        input.value = "";
        closeResults();
      },
      destroy() {
        search.cancel();
      },
    };
  }

  /** Multi-select type-ahead dropdown: selections render as removable chips. */
  function createMulti({ mountEl, placeholder, fetchOptions, fetchLabelForValue, onChange }) {
    ensureStyles();
    mountEl.innerHTML = baseMarkup(placeholder) + '<div class="sd-chip-area"></div>';
    const input = mountEl.querySelector(".sd-input");
    const resultsEl = mountEl.querySelector(".sd-results");
    const chipArea = mountEl.querySelector(".sd-chip-area");
    const search = createSearchController();

    let selected = []; // [{ value, label }]
    let activeIndex = -1;
    let currentOptions = [];

    function closeResults() {
      resultsEl.style.display = "none";
      resultsEl.innerHTML = "";
      activeIndex = -1;
    }

    function renderChips() {
      chipArea.innerHTML = selected
        .map(
          (s, i) =>
            `<span class="sd-chip">${escapeHtml(s.label)}<button type="button" data-remove="${i}" aria-label="Remove">&times;</button></span>`
        )
        .join("");
    }

    function renderOptions(options) {
      const selectedValues = new Set(selected.map((s) => s.value));
      currentOptions = options.filter((o) => !selectedValues.has(o.value));
      if (!currentOptions.length) {
        resultsEl.innerHTML = '<div class="sd-empty">No matches.</div>';
      } else {
        resultsEl.innerHTML = currentOptions
          .map((opt, i) => `<div class="sd-option" data-index="${i}">${escapeHtml(opt.label)}</div>`)
          .join("");
      }
      resultsEl.style.display = "block";
    }

    function addSelection(opt) {
      selected.push(opt);
      renderChips();
      input.value = "";
      closeResults();
      if (onChange) onChange(selected.map((s) => s.value), selected);
    }

    function removeSelection(index) {
      selected.splice(index, 1);
      renderChips();
      if (onChange) onChange(selected.map((s) => s.value), selected);
    }

    input.addEventListener("input", () => {
      const term = input.value.trim();
      if (!term) {
        closeResults();
        return;
      }
      search.run(async (signal) => {
        const options = await fetchOptions(term, signal);
        renderOptions(options || []);
      }, 250);
    });

    input.addEventListener("keydown", (e) => {
      if (resultsEl.style.display === "none") return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, currentOptions.length - 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIndex >= 0 && currentOptions[activeIndex]) addSelection(currentOptions[activeIndex]);
        return;
      } else if (e.key === "Escape") {
        closeResults();
        return;
      } else {
        return;
      }
      Array.from(resultsEl.children).forEach((el, i) => el.classList.toggle("sd-active", i === activeIndex));
    });

    resultsEl.addEventListener("mousedown", (e) => {
      const optionEl = e.target.closest(".sd-option");
      if (!optionEl) return;
      const idx = parseInt(optionEl.getAttribute("data-index"), 10);
      if (currentOptions[idx]) addSelection(currentOptions[idx]);
    });

    chipArea.addEventListener("click", (e) => {
      const removeIdx = e.target.getAttribute("data-remove");
      if (removeIdx !== null) removeSelection(parseInt(removeIdx, 10));
    });

    input.addEventListener("blur", () => {
      setTimeout(() => { closeResults(); input.value = ""; }, 150);
    });

    return {
      getValues: () => selected.map((s) => s.value),
      getSelected: () => selected.slice(),
      setValues(items) {
        // items: [{ value, label }]
        selected = (items || []).slice();
        renderChips();
      },
      async setValuesByIds(ids) {
        if (!ids || !ids.length) {
          this.clear();
          return;
        }
        if (fetchLabelForValue) {
          selected = await Promise.all(
            ids.map(async (id) => ({ value: id, label: (await fetchLabelForValue(id)) || id }))
          );
        } else {
          selected = ids.map((id) => ({ value: id, label: id }));
        }
        renderChips();
      },
      clear() {
        selected = [];
        renderChips();
        closeResults();
      },
      destroy() {
        search.cancel();
      },
    };
  }

  return { create, createMulti };
})();

/**
 * Bounded name-resolution cache, keyed by "tableKey:id".
 *
 * Used by list tables to show a related entity's name (e.g. a product's
 * Category name) without preloading the entire related table. Only
 * resolves IDs it hasn't already seen this session, and only for the IDs
 * actually present in the current page of results -- so cost scales with
 * page size, not with how large the underlying master table is.
 *
 * Usage:
 *   const resolver = NameResolver.create({
 *     categories: (ids) => apiGet("/masters/product-categories" + toQueryString({
 *       id: ids.join(","), page: 1, page_size: ids.length, sort_order: "asc",
 *     })).then(({ data }) => data.map((d) => [d.id, d.name])),
 *   });
 *   await resolver.resolve("categories", productsOnThisPage.map((p) => p.category_id));
 *   resolver.get("categories", someId); // -> name or undefined
 *
 * NOTE: the fetcher function you provide is responsible for turning a list
 * of ids into [id, label] pairs -- typically via a backend endpoint that
 * accepts filtering by a batch of ids. If your backend doesn't support
 * that yet, a simple (if slightly less efficient) fallback is to fetch
 * each missing id individually with Promise.all; both patterns work with
 * this cache, since it only cares about the final [id, label] pairs.
 */
const NameResolver = (() => {
  function create(fetchers) {
    const cache = {}; // { [tableKey]: { [id]: label } }

    return {
      get(tableKey, id) {
        return cache[tableKey] && cache[tableKey][id];
      },
      async resolve(tableKey, ids) {
        if (!fetchers[tableKey]) return;
        cache[tableKey] = cache[tableKey] || {};
        const missing = [...new Set(ids)].filter((id) => id && !(id in cache[tableKey]));
        if (!missing.length) return;
        try {
          const pairs = await fetchers[tableKey](missing);
          for (const [id, label] of pairs) {
            cache[tableKey][id] = label;
          }
        } catch (e) {
          /* best-effort -- table will just show a fallback for unresolved ids */
        }
      },
    };
  }

  return { create };
})();
