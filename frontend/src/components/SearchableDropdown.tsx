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
}

export function SearchableDropdown({
  value,
  onChange,
  placeholder,
  fetchOptions,
  fetchLabelForValue,
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
      setInputValue("");
      return;
    }
    if (resolvedFor.current === value) return;
    resolvedFor.current = value;

    let cancelled = false;
    if (!fetchLabelForValue) {
      setLabel("");
      setInputValue("");
      return;
    }
    fetchLabelForValue(value)
      .then((resolved) => {
        if (cancelled) return;
        setLabel(resolved || "");
        setInputValue(resolved || "");
      })
      .catch(() => {
        /* leave the box blank if the label can't be resolved */
      });
    return () => {
      cancelled = true;
    };
  }, [value, fetchLabelForValue]);

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
  }

  function handleInput(next: string) {
    setInputValue(next);
    const term = next.trim();

    // Typing again after a value was selected clears the stale selection, so
    // the parent never holds an id that no longer matches what's on screen.
    if (value !== null) {
      resolvedFor.current = null;
      onChange(null, "");
    }

    if (!term) {
      closeResults();
      return;
    }

    void search.run(async (signal) => {
      const found = await fetchOptions(term, signal);
      setOptions(found || []);
      setActiveIndex(-1);
      setOpen(true);
    }, 250);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
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
      // If the user typed something but never picked a match, revert the
      // visible text to the last real selection (or blank) rather than leaving
      // an ambiguous free-text value in the box.
      setInputValue(value === null ? "" : label);
    }, 150);
  }

  return (
    <div className="sd-wrap">
      <input
        type="text"
        className="sd-input"
        placeholder={placeholder || "Search..."}
        autoComplete="off"
        value={inputValue}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {open && (
        <div className="sd-results">
          {options.length === 0 ? (
            <div className="sd-empty">No matches.</div>
          ) : (
            options.map((opt, i) => (
              <div
                key={opt.value}
                className={`sd-option ${i === activeIndex ? "sd-active" : ""}`.trim()}
                // mousedown (not click) so this fires before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectOption(opt);
                }}
              >
                {opt.label}
              </div>
            ))
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
}

/** Multi-select variant: selections render as removable chips. */
export function SearchableDropdownMulti({
  values,
  onChange,
  placeholder,
  fetchOptions,
  fetchLabelForValue,
}: SearchableDropdownMultiProps) {
  const [inputValue, setInputValue] = useState("");
  const [selected, setSelected] = useState<DropdownOption[]>([]);
  const [options, setOptions] = useState<DropdownOption[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const search = useSearchController();
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (!term) {
      closeResults();
      return;
    }
    void search.run(async (signal) => {
      const found = (await fetchOptions(term, signal)) || [];
      // Already-selected entries are filtered out of the list.
      const selectedValues = new Set(selected.map((s) => s.value));
      setOptions(found.filter((o) => !selectedValues.has(o.value)));
      setActiveIndex(-1);
      setOpen(true);
    }, 250);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
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

  return (
    <div className="sd-wrap">
      <input
        type="text"
        className="sd-input"
        placeholder={placeholder || "Search..."}
        autoComplete="off"
        value={inputValue}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {open && (
        <div className="sd-results">
          {options.length === 0 ? (
            <div className="sd-empty">No matches.</div>
          ) : (
            options.map((opt, i) => (
              <div
                key={opt.value}
                className={`sd-option ${i === activeIndex ? "sd-active" : ""}`.trim()}
                onMouseDown={(e) => {
                  e.preventDefault();
                  addSelection(opt);
                }}
              >
                {opt.label}
              </div>
            ))
          )}
        </div>
      )}
      <div className="sd-chip-area">
        {selected.map((s, i) => (
          <span className="sd-chip" key={s.value}>
            {s.label}
            <button type="button" aria-label="Remove" onClick={() => removeSelection(i)}>
              &times;
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
