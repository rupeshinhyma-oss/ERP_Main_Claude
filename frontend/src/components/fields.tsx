/**
 * Form field primitives.
 *
 * Each renders the same `.field > label + control` markup the original pages
 * hand-wrote, so spacing, focus rings and hint styling come straight from
 * style.css.
 */

import type { ReactNode } from "react";

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
  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
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
