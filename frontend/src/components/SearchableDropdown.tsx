/**
 * Type-ahead searchable dropdown.
 *
 * Replaces the old pattern of pre-loading an entire master table into a plain
 * <select> (which breaks outright once a table has more than a few thousand
 * rows -- both because the fetch itself becomes huge, and because a browser
 * <select> with thousands of options is unusable).
 *
 * Instead: a text input plus a results list. As the user types, the backend's
 * `?search=` endpoint is called (debounced 250ms, previous request aborted) and
 * up to ~20 matches are shown.
 *
 * Ported from dropdown-search.js. The imperative handle (getValue/setValueById/
 * clear) becomes a controlled `value` + `onChange` pair, which is what lets the
 * Suppliers cascade (country -> province -> city) clear its dependents by just
 * setting state. Labels for a pre-filled value are resolved lazily through
 * `fetchLabelForValue`, exactly as setValueById() used to.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchController } from "@/lib/hooks";
import { autoTitleCase } from "@/components/fields";

export interface DropdownOption {
  value: string;
  label: string;
}

export type FetchOptions = (term: string, signal: AbortSignal) => Promise<DropdownOption[]>;
export type FetchLabelForValue = (value: string) => Promise<string>;

interface SharedProps {
  placeholder?: string;
  fetchOptions: FetchOptions;
  fetchLabelForValue?: FetchLabelForValue;
}

/* ------------------------------------------------------------------ */
/* Single select                                                      */
/* ------------------------------------------------------------------ */

export interface SearchableDropdownProps extends SharedProps {
  value: string | null;
  onChange: (value: string | null, label: string) => void;
  allowCustomText?: boolean;
  onTextChange?: (text: string) => void;
}

export function SearchableDropdown({
  value,
  onChange,
  placeholder,
  fetchOptions,
  fetchLabelForValue,
  allowCustomText = false,
  onTextChange,
}: SearchableDropdownProps) {
  const [inputValue, setInputValue] = useState("");
  const [label, setLabel] = useState("");
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const search = useSearchController();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedFor = useRef<string | null>(null);

  // Resolve the display label whenever the selected id changes from outside
  // (opening an edit form, or a parent clearing this field).
  useEffect(() => {
    if (!value) {
      resolvedFor.current = null;
      setLabel("");
      if (!allowCustomText) {
        setInputValue("");
      }
      return;
    }
    if (resolvedFor.current === value && label) return;
    resolvedFor.current = value;

    let cancelled = false;
    if (!fetchLabelForValue) {
      setLabel(value);
      setInputValue(value);
      return;
    }
    fetchLabelForValue(value)
      .then((resolved) => {
        if (cancelled) return;
        setLabel(resolved || value);
        setInputValue(resolved || value);
      })
      .catch(() => {
        /* leave as-is if the label can't be resolved */
      });
    return () => {
      cancelled = true;
    };
  }, [value, fetchLabelForValue, allowCustomText]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    []
  );

  const closeResults = useCallback(() => {
    setOpen(false);
    setOptions([]);
    setActiveIndex(-1);
  }, []);

  function selectOption(opt: DropdownOption) {
    resolvedFor.current = opt.value;
    setLabel(opt.label);
    setInputValue(opt.label);
    closeResults();
    onChange(opt.value, opt.label);
    if (onTextChange) onTextChange(opt.label);
  }

  function handleInput(raw: string) {
    const next = allowCustomText ? autoTitleCase(raw) : raw;
    setInputValue(next);
    const term = next.trim();
    if (onTextChange) onTextChange(next);

    // Typing again after a value was selected clears the stale selection, so
    // the parent never holds an id that no longer matches what's on screen.
    if (value !== null) {
      resolvedFor.current = null;
      onChange(null, next);
    }

    void search.run(async (signal) => {
      const found = await fetchOptions(term, signal);
      setOptions(found || []);
      setActiveIndex(-1);
      setOpen(true);
    }, 150);
  }

  function handleFocus() {
    void search.run(async (signal) => {
      const found = await fetchOptions(inputValue.trim(), signal);
      setOptions(found || []);
      setActiveIndex(-1);
      setOpen(true);
    }, 100);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && allowCustomText && activeIndex < 0 && inputValue.trim()) {
      e.preventDefault();
      closeResults();
      selectOption({ value: inputValue.trim(), label: inputValue.trim() });
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) selectOption(options[activeIndex]);
    } else if (e.key === "Escape") {
      closeResults();
    }
  }

  function handleBlur() {
    // Slight delay so a mousedown-selection in the list can complete first.
    blurTimer.current = setTimeout(() => {
      closeResults();
      if (allowCustomText) {
        if (onTextChange) onTextChange(inputValue);
      } else {
        setInputValue(value === null ? "" : label);
      }
    }, 150);
  }

  const showCustomOption =
    allowCustomText &&
    inputValue.trim() !== "" &&
    !options.some((o) => o.label.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className="sd-wrap">
      <input
        type="text"
        className="sd-input"
        placeholder={placeholder || "Search..."}
        autoComplete="off"
        value={inputValue}
        onChange={(e) => handleInput(e.target.value)}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {open && (
        <div className="sd-results">
          {options.length === 0 && !showCustomOption ? (
            <div className="sd-empty">No matches.</div>
          ) : (
            <>
              {options.map((opt, i) => (
                <div
                  key={opt.value}
                  className={`sd-option ${i === activeIndex ? "sd-active" : ""}`.trim()}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectOption(opt);
                  }}
                >
                  {opt.label}
                </div>
              ))}
              {showCustomOption && (
                <div
                  className="sd-option"
                  style={{ fontStyle: "italic", color: "var(--color-primary, #0284c7)" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    selectOption({ value: inputValue.trim(), label: inputValue.trim() });
                  }}
                >
                  Use "{inputValue.trim()}"
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Multi select                                                       */
/* ------------------------------------------------------------------ */

export interface SearchableDropdownMultiProps extends SharedProps {
  values: string[];
  onChange: (values: string[]) => void;
  allowCustomText?: boolean;
}

/** Multi-select variant: selections render as removable chips. */
export function SearchableDropdownMulti({
  values,
  onChange,
  placeholder,
  fetchOptions,
  fetchLabelForValue,
  allowCustomText = false,
}: SearchableDropdownMultiProps) {
  const [inputValue, setInputValue] = useState("");
  const [selected, setSelected] = useState<DropdownOption[]>([]);
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const search = useSearchController();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep chips in sync with the ids owned by the parent, resolving labels for
  // any id we don't already have one for (the setValuesByIds() equivalent).
  useEffect(() => {
    let cancelled = false;
    const ids = values || [];

    if (ids.length === 0) {
      setSelected([]);
      return;
    }

    setSelected((prev) => {
      const knownLabels = new Map(prev.map((s) => [s.value, s.label]));
      const needsResolving = ids.some((id) => !knownLabels.has(id));

      if (!needsResolving) {
        // Same set, possibly reordered -- mirror the parent's order.
        return ids.map((id) => ({ value: id, label: knownLabels.get(id) as string }));
      }

      if (fetchLabelForValue) {
        void Promise.all(
          ids.map(async (id) => ({
            value: id,
            label: knownLabels.get(id) ?? ((await fetchLabelForValue(id).catch(() => id)) || id),
          }))
        ).then((resolved) => {
          if (!cancelled) setSelected(resolved);
        });
        // Show the ids until labels land, as the original did.
        return ids.map((id) => ({ value: id, label: knownLabels.get(id) ?? id }));
      }

      return ids.map((id) => ({ value: id, label: knownLabels.get(id) ?? id }));
    });

    return () => {
      cancelled = true;
    };
  }, [values, fetchLabelForValue]);

  useEffect(
    () => () => {
      if (blurTimer.current) clearTimeout(blurTimer.current);
    },
    []
  );

  const closeResults = useCallback(() => {
    setOpen(false);
    setOptions([]);
    setActiveIndex(-1);
  }, []);

  function addSelection(opt: DropdownOption) {
    const next = [...selected, opt];
    setSelected(next);
    setInputValue("");
    closeResults();
    onChange(next.map((s) => s.value));
  }

  function removeSelection(index: number) {
    const next = selected.filter((_, i) => i !== index);
    setSelected(next);
    onChange(next.map((s) => s.value));
  }

  function handleInput(nextValue: string) {
    setInputValue(nextValue);
    const term = nextValue.trim();
    void search.run(async (signal) => {
      const found = (await fetchOptions(term, signal)) || [];
      // Already-selected entries are filtered out of the list.
      const selectedValues = new Set(selected.map((s) => s.value));
      setOptions(found.filter((o) => !selectedValues.has(o.value)));
      setActiveIndex(-1);
      setOpen(true);
    }, 150);
  }

  function handleFocus() {
    void search.run(async (signal) => {
      const found = (await fetchOptions(inputValue.trim(), signal)) || [];
      const selectedValues = new Set(selected.map((s) => s.value));
      setOptions(found.filter((o) => !selectedValues.has(o.value)));
      setActiveIndex(-1);
      setOpen(true);
    }, 100);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if ((e.key === "Enter" || e.key === ",") && allowCustomText && activeIndex < 0 && inputValue.trim()) {
      e.preventDefault();
      addSelection({ value: inputValue.trim(), label: inputValue.trim() });
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && options[activeIndex]) addSelection(options[activeIndex]);
      else if (allowCustomText && inputValue.trim()) addSelection({ value: inputValue.trim(), label: inputValue.trim() });
    } else if (e.key === "Escape") {
      closeResults();
    }
  }

  function handleBlur() {
    blurTimer.current = setTimeout(() => {
      closeResults();
      setInputValue("");
    }, 150);
  }

  const showCustomOption =
    allowCustomText &&
    inputValue.trim() !== "" &&
    !options.some((o) => o.label.toLowerCase() === inputValue.trim().toLowerCase()) &&
    !selected.some((s) => s.label.toLowerCase() === inputValue.trim().toLowerCase());

  return (
    <div className="sd-wrap" style={{ position: "relative" }}>
      <div
        className="sd-multi-box"
        style={{
          border: "1px solid var(--color-border-strong, #cbd5e1)",
          borderRadius: "var(--radius-sm, 6px)",
          padding: "5px 32px 5px 8px",
          minHeight: "42px",
          background: "#ffffff",
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "6px",
          cursor: "text",
          position: "relative",
        }}
        onClick={() => inputRef.current?.focus()}
      >
        {selected.map((s, i) => (
          <span
            key={s.value}
            style={{
              background: "#0061f2",
              color: "#ffffff",
              fontSize: "12.5px",
              fontWeight: 500,
              padding: "4px 8px",
              borderRadius: "4px",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              userSelect: "none",
            }}
          >
            <button
              type="button"
              aria-label="Remove"
              onClick={(e) => {
                e.stopPropagation();
                removeSelection(i);
              }}
              style={{
                background: "transparent",
                border: "none",
                color: "#ffffff",
                fontSize: "12px",
                fontWeight: "bold",
                cursor: "pointer",
                padding: 0,
                lineHeight: 1,
              }}
            >
              ✕
            </button>
            {s.label}
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          style={{
            border: "none",
            outline: "none",
            fontSize: "13.5px",
            background: "transparent",
            flex: "1 1 120px",
            minWidth: "80px",
            padding: "4px 0",
          }}
          placeholder={selected.length === 0 ? (placeholder || "Click to select...") : ""}
          autoComplete="off"
          value={inputValue}
          onChange={(e) => handleInput(e.target.value)}
          onFocus={handleFocus}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
        />
        {/* Dropdown arrow indicator */}
        <span
          style={{
            position: "absolute",
            right: "10px",
            top: "50%",
            transform: open ? "translateY(-50%) rotate(180deg)" : "translateY(-50%)",
            pointerEvents: "none",
            color: "#94a3b8",
            fontSize: "11px",
            transition: "transform 0.2s ease",
            lineHeight: 1,
          }}
        >
          ▼
        </span>
      </div>

      {open && (
        <div
          className="sd-results"
          style={{
            position: "absolute",
            top: "calc(100% + 2px)",
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "#ffffff",
            border: "1px solid #cbd5e0",
            borderRadius: "6px",
            boxShadow: "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)",
            maxHeight: "220px",
            overflowY: "auto",
            padding: "4px 0",
          }}
        >
          {options.length === 0 && !showCustomOption ? (
            <div className="sd-empty" style={{ padding: "8px 12px", fontSize: "13px", color: "#94a3b8" }}>
              No matches.
            </div>
          ) : (
            <>
              {options.map((opt, i) => (
                <div
                  key={opt.value}
                  className={`sd-option ${i === activeIndex ? "sd-active" : ""}`.trim()}
                  style={{
                    padding: "8px 12px",
                    fontSize: "13.5px",
                    cursor: "pointer",
                    background: i === activeIndex ? "#0061f2" : "transparent",
                    color: i === activeIndex ? "#ffffff" : "#1e293b",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addSelection(opt);
                  }}
                  onMouseOver={(e) => {
                    if (i !== activeIndex) e.currentTarget.style.background = "#f1f5f9";
                  }}
                  onMouseOut={(e) => {
                    if (i !== activeIndex) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {opt.label}
                </div>
              ))}
              {showCustomOption && (
                <div
                  className="sd-option"
                  style={{ fontStyle: "italic", color: "#0061f2", padding: "8px 12px", cursor: "pointer" }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    addSelection({ value: inputValue.trim(), label: inputValue.trim() });
                  }}
                >
                  Add "{inputValue.trim()}"
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Multi-select panel (checkbox style, like Product Master)           */
/* ------------------------------------------------------------------ */

export interface SearchableDropdownMultiPanelProps extends SharedProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
}

export function SearchableDropdownMultiPanel({
  values,
  onChange,
  placeholder = "-- Select --",
  fetchOptions,
  fetchLabelForValue,
}: SearchableDropdownMultiPanelProps) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [selected, setSelected] = useState<DropdownOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [showEyeModal, setShowEyeModal] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const search = useSearchController();

  // Resolve labels for pre-filled values
  useEffect(() => {
    let cancelled = false;
    const ids = values || [];
    if (ids.length === 0) { setSelected([]); return; }

    setSelected((prev) => {
      const knownLabels = new Map(prev.map((s) => [s.value, s.label]));
      const needsResolving = ids.some((id) => !knownLabels.has(id));
      if (!needsResolving) {
        return ids.map((id) => ({ value: id, label: knownLabels.get(id) as string }));
      }
      if (fetchLabelForValue) {
        void Promise.all(
          ids.map(async (id) => ({
            value: id,
            label: knownLabels.get(id) ?? ((await fetchLabelForValue(id).catch(() => id)) || id),
          }))
        ).then((resolved) => { if (!cancelled) setSelected(resolved); });
        return ids.map((id) => ({ value: id, label: knownLabels.get(id) ?? id }));
      }
      return ids.map((id) => ({ value: id, label: knownLabels.get(id) ?? id }));
    });

    return () => { cancelled = true; };
  }, [values, fetchLabelForValue]);

  // Click outside to close
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearchTerm("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Load options when opening or searching
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void search.run(async (signal) => {
      const found = (await fetchOptions(searchTerm.trim(), signal)) || [];
      setOptions(found);
      setLoading(false);
    }, 150);
  }, [open, searchTerm]);

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      setSearchTerm("");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }

  function toggleItem(opt: DropdownOption) {
    const isSelected = selected.some((s) => s.value === opt.value);
    let next: DropdownOption[];
    if (isSelected) {
      next = selected.filter((s) => s.value !== opt.value);
    } else {
      next = [...selected, opt];
    }
    setSelected(next);
    onChange(next.map((s) => s.value));
  }

  function removeItem(val: string) {
    const next = selected.filter((s) => s.value !== val);
    setSelected(next);
    onChange(next.map((s) => s.value));
  }

  const selectedValues = new Set(selected.map((s) => s.value));
  const firstThree = selected.slice(0, 3);
  const extraCount = selected.length - 3;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {/* Trigger button */}
      <div
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleOpen(); } }}
        style={{
          border: "1px solid var(--color-border-strong, #cbd5e1)",
          borderRadius: "var(--radius-sm, 6px)",
          padding: "7px 32px 7px 11px",
          minHeight: "40px",
          maxHeight: "40px",
          background: "#ffffff",
          cursor: "pointer",
          fontSize: "13.5px",
          color: selected.length === 0 ? "#94a3b8" : "#1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          userSelect: "none",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, display: "flex", alignItems: "center", gap: "6px" }}>
          {selected.length === 0 ? (
            <span>{placeholder}</span>
          ) : (
            <>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {firstThree.map((s) => s.label).join(", ")}
              </span>
              {extraCount > 0 && (
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowEyeModal(true);
                  }}
                  style={{
                    background: "#0284c7",
                    color: "#ffffff",
                    fontSize: "11.5px",
                    fontWeight: 700,
                    padding: "2px 8px",
                    borderRadius: "12px",
                    flexShrink: 0,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "3px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  }}
                  title="Click to view all selected items"
                >
                  +{extraCount} more 👁️
                </span>
              )}
            </>
          )}
        </div>
        <span style={{
          position: "absolute",
          right: "10px",
          top: "50%",
          transform: open ? "translateY(-50%) rotate(180deg)" : "translateY(-50%)",
          color: "#94a3b8",
          fontSize: "11px",
          transition: "transform 0.2s ease",
          pointerEvents: "none",
        }}>▼</span>
      </div>

      {/* Dropdown panel */}
      {open && (
        <div style={{
          position: "absolute",
          top: "calc(100% + 2px)",
          left: 0,
          right: 0,
          zIndex: 9999,
          background: "#ffffff",
          border: "1px solid #cbd5e0",
          borderRadius: "6px",
          boxShadow: "0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -2px rgba(0,0,0,0.05)",
          maxHeight: "280px",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}>
          {/* Search bar */}
          <div style={{ padding: "8px", borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search / Type here..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: "13px",
                border: "1px solid #cbd5e0",
                borderRadius: "4px",
                outline: "none",
                background: "#ffffff",
                boxSizing: "border-box",
              }}
            />
          </div>

          {/* Options list with checkboxes */}
          <div style={{ overflowY: "auto", flex: 1 }}>
            {loading ? (
              <div style={{ padding: "10px 12px", fontSize: "13px", color: "#94a3b8", textAlign: "center" }}>Loading...</div>
            ) : options.length === 0 ? (
              <div style={{ padding: "10px 12px", fontSize: "13px", color: "#94a3b8", textAlign: "center" }}>No matching results</div>
            ) : (
              options.map((opt) => {
                const isChecked = selectedValues.has(opt.value);
                return (
                  <div
                    key={opt.value}
                    onMouseDown={(e) => { e.preventDefault(); toggleItem(opt); }}
                    style={{
                      padding: "8px 12px",
                      fontSize: "13.5px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "10px",
                      background: isChecked ? "#eff6ff" : "transparent",
                      color: "#1e293b",
                      transition: "background 0.1s",
                    }}
                    onMouseOver={(e) => { if (!isChecked) e.currentTarget.style.background = "#f8fafc"; }}
                    onMouseOut={(e) => { if (!isChecked) e.currentTarget.style.background = "transparent"; }}
                  >
                    <span style={{
                      width: "16px",
                      height: "16px",
                      border: isChecked ? "2px solid #0061f2" : "2px solid #cbd5e1",
                      borderRadius: "3px",
                      background: isChecked ? "#0061f2" : "#ffffff",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      transition: "all 0.15s",
                    }}>
                      {isChecked && <span style={{ color: "#fff", fontSize: "10px", fontWeight: "bold" }}>✓</span>}
                    </span>
                    {opt.label}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer: selected count + clear */}
          {selected.length > 0 && (
            <div style={{
              padding: "6px 12px",
              borderTop: "1px solid #f1f5f9",
              background: "#f8fafc",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "12px",
              color: "#64748b",
            }}>
              <span>{selected.length} selected</span>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); setSelected([]); onChange([]); }}
                style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: "12px", fontWeight: 600 }}
              >
                Clear all
              </button>
            </div>
          )}
        </div>
      )}

      {/* Eye Symbol Modal Popover for viewing all selected items */}
      {showEyeModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 100000,
            background: "rgba(15, 23, 42, 0.45)",
            backdropFilter: "blur(3px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setShowEyeModal(false)}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: "12px",
              padding: "20px",
              width: "90%",
              maxWidth: "480px",
              maxHeight: "80vh",
              display: "flex",
              flexDirection: "column",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "16px",
                borderBottom: "1px solid #e2e8f0",
                paddingBottom: "12px",
              }}
            >
              <h4 style={{ margin: 0, fontSize: "15px", fontWeight: 700, color: "#0f172a", display: "flex", alignItems: "center", gap: "8px" }}>
                <span>👁️</span> All Selected ({selected.length})
              </h4>
              <button
                type="button"
                onClick={() => setShowEyeModal(false)}
                style={{
                  background: "#f1f5f9",
                  border: "none",
                  borderRadius: "50%",
                  width: "28px",
                  height: "28px",
                  cursor: "pointer",
                  fontWeight: 700,
                  color: "#64748b",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: "14px",
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ overflowY: "auto", flex: 1, display: "flex", flexWrap: "wrap", gap: "8px", padding: "4px" }}>
              {selected.map((s) => (
                <span
                  key={s.value}
                  style={{
                    background: "#0061f2",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 600,
                    padding: "6px 10px",
                    borderRadius: "6px",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  {s.label}
                  <button
                    type="button"
                    onClick={() => removeItem(s.value)}
                    style={{
                      background: "rgba(255,255,255,0.25)",
                      border: "none",
                      borderRadius: "50%",
                      color: "#ffffff",
                      fontSize: "11px",
                      fontWeight: "bold",
                      cursor: "pointer",
                      width: "18px",
                      height: "18px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      padding: 0,
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
