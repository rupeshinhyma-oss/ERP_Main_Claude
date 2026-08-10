/**
 * Form field primitives.
 *
 * Each renders the same `.field > label + control` markup the original pages
 * hand-wrote, so spacing, focus rings and hint styling come straight from
 * style.css.
 */

import React, { useState, useRef, useEffect, type ReactNode } from "react";

interface BaseFieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Inline overrides such as `grid-column: span 2`. */
  style?: React.CSSProperties;
}

export function TextField({
  id,
  label,
  value,
  onChange,
  required,
  maxLength,
  minLength,
  placeholder,
  type = "text",
  hint,
  style,
  readOnly,
  inputStyle,
  step,
  min,
  max,
  className,
  autoComplete = "off",
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  maxLength?: number;
  minLength?: number;
  placeholder?: string;
  type?: string;
  readOnly?: boolean;
  inputStyle?: React.CSSProperties;
  step?: string | number;
  min?: string | number;
  max?: string | number;
  className?: string;
  autoComplete?: string;
}) {
  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        maxLength={maxLength}
        minLength={minLength}
        placeholder={placeholder}
        readOnly={readOnly}
        style={inputStyle}
        step={step}
        min={min}
        max={max}
        className={className}
        autoComplete={autoComplete}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function TextAreaField({
  id,
  label,
  value,
  onChange,
  rows,
  placeholder,
  hint,
  style,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  required,
  children,
  hint,
  style,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const options: { value: string; label: string; element: ReactNode }[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === "option") {
      const childProps = child.props as { value?: string | number; children?: ReactNode };
      const valStr = String(childProps.value ?? "");
      const labelText =
        typeof childProps.children === "string" || typeof childProps.children === "number"
          ? String(childProps.children)
          : valStr;
      options.push({
        value: valStr,
        label: labelText,
        element: childProps.children ?? valStr,
      });
    }
  });

  const selectedOption = options.find((opt) => opt.value === value);
  const displayLabel = selectedOption ? selectedOption.element : (options[0]?.element || "-- Select --");

  const filteredOptions = options.filter((opt) => {
    if (!searchTerm.trim()) return true;
    return opt.label.toLowerCase().includes(searchTerm.toLowerCase());
  });

  function toggleOpen() {
    const nextState = !open;
    setOpen(nextState);
    if (nextState && options.length > 5) {
      setSearchTerm("");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }

  return (
    <div className="field" style={{ ...style, position: "relative" }} ref={containerRef}>
      <label htmlFor={id}>{label}</label>

      <div
        id={id}
        tabIndex={0}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleOpen();
          }
        }}
        style={{
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-sm)",
          padding: "9px 11px",
          fontSize: "13.5px",
          background: "var(--color-surface)",
          color: "var(--color-text)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          userSelect: "none",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {displayLabel}
        </span>
        <span style={{ fontSize: "10px", color: "var(--color-muted)", marginLeft: "8px" }}>
          {open ? "▲" : "▼"}
        </span>
      </div>

      {open && (
        <div
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
            maxHeight: "260px",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Search Bar — only shown for longer lists */}
          {options.length > 5 && (
          <div style={{ padding: "8px", borderBottom: "1px solid #f1f5f9", background: "#f8fafc" }}>
            <input
              ref={searchInputRef}
              type="text"
              placeholder="Search / Type here..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filteredOptions.length > 0) {
                  e.preventDefault();
                  onChange(filteredOptions[0].value);
                  setOpen(false);
                }
              }}
              style={{
                width: "100%",
                padding: "6px 10px",
                fontSize: "13px",
                border: "1px solid #cbd5e0",
                borderRadius: "4px",
                outline: "none",
                background: "#ffffff",
              }}
            />
          </div>
          )}

          {/* Options List */}
          <div style={{ overflowY: "auto", flex: 1, maxHeight: "200px", padding: "4px 0" }}>
            {filteredOptions.length === 0 ? (
              <div style={{ padding: "10px 12px", fontSize: "13px", color: "#94a3b8", textAlign: "center" }}>
                No matching results
              </div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={idx}
                    onClick={() => {
                      onChange(opt.value);
                      setOpen(false);
                    }}
                    style={{
                      padding: "8px 12px",
                      fontSize: "13.5px",
                      cursor: "pointer",
                      background: isSelected ? "#0061f2" : "transparent",
                      color: isSelected ? "#ffffff" : "#1e293b",
                      fontWeight: isSelected ? 600 : 400,
                    }}
                    onMouseOver={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "#f1f5f9";
                    }}
                    onMouseOut={(e) => {
                      if (!isSelected) e.currentTarget.style.background = "transparent";
                    }}
                  >
                    {opt.element}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        tabIndex={-1}
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          width: 0,
          height: 0,
        }}
      >
        {children}
      </select>

      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function SearchableSelectField({
  id,
  label,
  value,
  onChange,
  required,
  placeholder = "-- Select or type to search --",
  children,
  hint,
  style,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  const options: { value: string; label: string }[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === "option") {
      const childProps = child.props as { value?: string | number; children?: ReactNode };
      options.push({
        value: String(childProps.value ?? ""),
        label: String(childProps.children ?? childProps.value ?? ""),
      });
    }
  });

  const selectedOption = options.find((opt) => opt.value === value);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredOptions = options.filter((opt) =>
    opt.value === "" || opt.label.toLowerCase().includes(query.toLowerCase())
  );

  const displayString = open ? query : (selectedOption ? selectedOption.label : "");

  return (
    <div className="field" style={{ ...style, position: "relative" }} ref={containerRef}>
      <label htmlFor={id}>{label}</label>

      <div
        style={{
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-sm)",
          background: "var(--color-surface)",
          display: "flex",
          alignItems: "center",
          position: "relative",
        }}
      >
        <input
          id={id}
          type="text"
          value={displayString}
          onChange={(e) => {
            setQuery(e.target.value);
            if (!open) setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onFocus={() => setOpen(true)}
          placeholder={selectedOption ? selectedOption.label : placeholder}
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            padding: "9px 30px 9px 11px",
            fontSize: "13.5px",
            background: "transparent",
            color: "var(--color-text)",
          }}
        />
        <span
          onClick={() => setOpen(!open)}
          style={{
            position: "absolute",
            right: "10px",
            fontSize: "10px",
            color: "var(--color-muted)",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          {open ? "▲" : "▼"}
        </span>
      </div>

      {open && (
        <div
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
          {filteredOptions.length === 0 ? (
            <div style={{ padding: "8px 12px", fontSize: "13px", color: "#64748b" }}>No matching category</div>
          ) : (
            filteredOptions.map((opt, idx) => {
              const isSelected = opt.value === value;
              return (
                <div
                  key={idx}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                    setQuery("");
                  }}
                  style={{
                    padding: "8px 12px",
                    fontSize: "13.5px",
                    cursor: "pointer",
                    background: isSelected ? "#0061f2" : "transparent",
                    color: isSelected ? "#ffffff" : "#1e293b",
                    fontWeight: isSelected ? 600 : 400,
                  }}
                  onMouseOver={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "#f1f5f9";
                  }}
                  onMouseOut={(e) => {
                    if (!isSelected) e.currentTarget.style.background = "transparent";
                  }}
                >
                  {opt.label}
                </div>
              );
            })
          )}
        </div>
      )}

      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        tabIndex={-1}
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          width: 0,
          height: 0,
        }}
      >
        {children}
      </select>

      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

/** The active/inactive select that closes almost every master form. */
export function StatusSelectField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <SelectField id="status" label="Status" value={value} onChange={onChange}>
      <option value="active">Active</option>
      <option value="inactive">Inactive</option>
    </SelectField>
  );
}

/** Trim helper used by every toPayload(): "" becomes null, not an empty string. */
export function nullIfBlank(value: string | undefined): string | null {
  const trimmed = (value || "").trim();
  return trimmed === "" ? null : trimmed;
}

/** parseFloat that yields null for a blank field rather than NaN. */
export function numOrNull(value: string | undefined): number | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? null : parsed;
}
