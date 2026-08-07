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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const options: { value: string; label: ReactNode }[] = [];
  React.Children.forEach(children, (child) => {
    if (React.isValidElement(child) && child.type === "option") {
      const childProps = child.props as { value?: string | number; children?: ReactNode };
      options.push({
        value: String(childProps.value ?? ""),
        label: childProps.children ?? childProps.value ?? "",
      });
    }
  });

  const selectedOption = options.find((opt) => opt.value === value);
  const displayLabel = selectedOption ? selectedOption.label : (options[0]?.label || "-- Select --");

  return (
    <div className="field" style={{ ...style, position: "relative" }} ref={containerRef}>
      <label htmlFor={id}>{label}</label>

      <div
        id={id}
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen(!open);
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
            maxHeight: "220px",
            overflowY: "auto",
            padding: "4px 0",
          }}
        >
          {options.map((opt, idx) => {
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
                {opt.label}
              </div>
            );
          })}
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
