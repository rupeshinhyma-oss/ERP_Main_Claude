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

function renderLabel(label: ReactNode) {
  if (typeof label !== "string") return label;
  if (label.endsWith(" *")) {
    const mainText = label.slice(0, -2);
    return (
      <>
        {mainText} <span style={{ color: "#dc2626", fontWeight: 700, marginLeft: "2px" }}>*</span>
      </>
    );
  }
  return label;
}

import { autoTitleCase, nullIfBlank, numOrNull } from "../utils/text";
export { autoTitleCase, nullIfBlank, numOrNull };

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
  disableAutoCapitalize,
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
  disableAutoCapitalize?: boolean;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    const formatted = disableAutoCapitalize ? raw : autoTitleCase(raw, id, type);
    onChange(formatted);
  };

  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{renderLabel(label)}</label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={handleChange}
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
  rows = 3,
  placeholder,
  hint,
  style,
  disableAutoCapitalize,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disableAutoCapitalize?: boolean;
}) {
  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const raw = e.target.value;
    const formatted = disableAutoCapitalize ? raw : autoTitleCase(raw, id, "textarea");
    onChange(formatted);
  };

  return (
    <div className="field" style={style}>
      <label htmlFor={id}>{renderLabel(label)}</label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
      />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function EmailTagInput({
  id,
  label,
  emails,
  onChange,
  placeholder = "Type email and press Enter...",
}: {
  id?: string;
  label?: React.ReactNode;
  emails: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const commitEmail = (raw: string) => {
    const clean = raw.trim();
    if (!clean) {
      setErrorMsg("");
      return;
    }

    const parts = clean.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
    let hasInvalid = false;
    const updated = [...emails];

    for (const p of parts) {
      if (EMAIL_REGEX.test(p)) {
        if (!updated.includes(p)) {
          updated.push(p);
        }
      } else {
        hasInvalid = true;
      }
    }

    if (hasInvalid) {
      setErrorMsg("Please Enter A Valid Email Address.");
    } else {
      setErrorMsg("");
    }

    onChange(updated);
    setInputValue("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      commitEmail(inputValue);
    } else if (e.key === "Backspace" && !inputValue && emails.length > 0) {
      setErrorMsg("");
      onChange(emails.slice(0, -1));
    }
  };

  const handleBlur = () => {
    if (inputValue.trim()) {
      commitEmail(inputValue);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    if (errorMsg) setErrorMsg("");
  };

  const removeTag = (indexToRemove: number) => {
    if (errorMsg) setErrorMsg("");
    onChange(emails.filter((_, idx) => idx !== indexToRemove));
  };

  return (
    <div className="field">
      {label && <label htmlFor={id}>{renderLabel(label)}</label>}
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "6px",
          alignItems: "center",
          padding: "6px 10px",
          borderRadius: "6px",
          border: errorMsg ? "1px solid #ef4444" : "1px solid #cbd5e1",
          background: "#ffffff",
          minHeight: "38px",
          cursor: "text",
          transition: "all 0.15s ease",
        }}
      >
        {emails.map((email, idx) => (
          <span
            key={`${email}-${idx}`}
            style={{
              background: "#2563eb",
              color: "#ffffff",
              borderRadius: "4px",
              padding: "3px 8px 3px 10px",
              fontSize: "12.5px",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
            }}
          >
            {email}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                removeTag(idx);
              }}
              style={{
                background: "none",
                border: "none",
                color: "#ffffff",
                fontWeight: 700,
                fontSize: "12px",
                cursor: "pointer",
                padding: "0 2px",
                lineHeight: 1,
                opacity: 0.85,
              }}
              title="Remove email"
            >
              ✕
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={inputValue}
          placeholder={emails.length === 0 ? placeholder : "Add another email..."}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          style={{
            border: "none",
            outline: "none",
            background: "transparent",
            flex: 1,
            minWidth: "160px",
            fontSize: "13px",
            color: "#0f172a",
            padding: "2px 0",
          }}
        />
      </div>
      {errorMsg && (
        <div style={{ color: "#dc2626", fontSize: "12px", fontWeight: 600, marginTop: "4px" }}>
          {errorMsg}
        </div>
      )}
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
    if (nextState) {
      setSearchTerm("");
      setTimeout(() => searchInputRef.current?.focus(), 50);
    }
  }

  return (
    <div className="field" style={{ ...style, position: "relative" }} ref={containerRef}>
      <label htmlFor={id}>{renderLabel(label)}</label>

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
          {/* Search Bar — shown for all lists */}
          {options.length > 0 && (
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

export function MultiSelectField({
  id,
  label,
  values,
  options,
  onChange,
  placeholder = "-- Select --",
  hint,
  style,
}: BaseFieldProps & {
  values: string[];
  options: { id: string; name: string }[];
  onChange: (newValues: string[]) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [showEyeModal, setShowEyeModal] = useState(false);
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

  const toggleOption = (optId: string) => {
    if (values.includes(optId)) {
      onChange(values.filter((v) => v !== optId));
    } else {
      onChange([...values, optId]);
    }
  };

  const selectedOptions = options.filter((opt) => values.includes(opt.id));
  const visibleOptions = selectedOptions.slice(0, 3);
  const extraCount = selectedOptions.length - 3;

  const filteredOptions = options.filter((opt) =>
    opt.name.toLowerCase().includes(searchTerm.trim().toLowerCase())
  );

  return (
    <div className="field" style={{ ...style, position: "relative" }} ref={containerRef}>
      <label htmlFor={id}>{renderLabel(label)}</label>

      <div
        id={id}
        tabIndex={0}
        onClick={() => setOpen((prev) => !prev)}
        style={{
          border: "1px solid var(--color-border-strong)",
          borderRadius: "var(--radius-sm)",
          padding: "6px 11px",
          minHeight: "40px",
          maxHeight: "40px",
          fontSize: "13.5px",
          background: "var(--color-surface)",
          color: "var(--color-text)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: "4px", alignItems: "center", flex: 1, overflow: "hidden" }}>
          {selectedOptions.length === 0 ? (
            <span style={{ color: "var(--color-muted)" }}>{placeholder}</span>
          ) : (
            <>
              {visibleOptions.map((opt) => (
                <span
                  key={opt.id}
                  style={{
                    background: "#eff6ff",
                    color: "#1d4ed8",
                    border: "1px solid #bfdbfe",
                    borderRadius: "4px",
                    padding: "2px 6px",
                    fontSize: "12px",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    whiteSpace: "nowrap",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleOption(opt.id);
                  }}
                >
                  {opt.name}
                  <span style={{ cursor: "pointer", color: "#3b82f6", fontWeight: 700 }}>×</span>
                </span>
              ))}
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
        <span style={{ fontSize: "10px", color: "var(--color-muted)", marginLeft: "6px" }}>
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
          {options.length > 5 && (
            <div style={{ padding: "6px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
              <input
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "100%",
                  padding: "6px 8px",
                  fontSize: "12.5px",
                  border: "1px solid #cbd5e1",
                  borderRadius: "4px",
                  outline: "none",
                }}
              />
            </div>
          )}

          <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
            {filteredOptions.length === 0 ? (
              <div style={{ padding: "8px 12px", fontSize: "12.5px", color: "#94a3b8" }}>No matches found</div>
            ) : (
              filteredOptions.map((opt) => {
                const isChecked = values.includes(opt.id);
                return (
                  <div
                    key={opt.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleOption(opt.id);
                    }}
                    style={{
                      padding: "7px 12px",
                      fontSize: "13px",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      background: isChecked ? "#f0f9ff" : "transparent",
                      color: isChecked ? "#0284c7" : "#1e293b",
                      fontWeight: isChecked ? 600 : 400,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {}}
                      style={{ cursor: "pointer" }}
                    />
                    <span>{opt.name}</span>
                  </div>
                );
              })
            )}
          </div>
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
                <span>👁️</span> All Selected ({selectedOptions.length})
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
              {selectedOptions.map((opt) => (
                <span
                  key={opt.id}
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
                  {opt.name}
                  <button
                    type="button"
                    onClick={() => toggleOption(opt.id)}
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

      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}
