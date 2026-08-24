/**
 * Form field primitives.
 *
 * Each renders the same `.field > label + control` markup the original pages
 * hand-wrote, so spacing, focus rings and hint styling come straight from
 * style.css.
 */

import React, { useState, useRef, useEffect, useMemo, type ReactNode } from "react";

interface BaseFieldProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  /** Inline overrides such as `grid-column: span 2`. */
  style?: React.CSSProperties;
  hasError?: boolean;
  errorMessage?: ReactNode;
  error?: ReactNode;
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
  hasError = false,
  errorMessage,
  error,
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
  const isErr = Boolean(hasError || errorMessage || error);
  const errText = errorMessage || error;

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
        style={{
          ...inputStyle,
          border: isErr ? "1.5px solid #ef4444" : inputStyle?.border,
          boxShadow: isErr ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : inputStyle?.boxShadow,
          backgroundColor: isErr ? "#fff5f5" : inputStyle?.backgroundColor,
        }}
        step={step}
        min={min}
        max={max}
        className={className}
        autoComplete={autoComplete}
      />
      {errText && (
        <div style={{ color: "#dc2626", fontSize: "11.5px", fontWeight: 600, marginTop: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>⚠️</span> {errText}
        </div>
      )}
      {hint && !errText && <span className="hint">{hint}</span>}
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
  hasError = false,
  errorMessage,
  error,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disableAutoCapitalize?: boolean;
}) {
  const isErr = Boolean(hasError || errorMessage || error);
  const errText = errorMessage || error;

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
        style={{
          border: isErr ? "1.5px solid #ef4444" : undefined,
          boxShadow: isErr ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : undefined,
          backgroundColor: isErr ? "#fff5f5" : undefined,
        }}
      />
      {errText && (
        <div style={{ color: "#dc2626", fontSize: "11.5px", fontWeight: 600, marginTop: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>⚠️</span> {errText}
        </div>
      )}
      {hint && !errText && <span className="hint">{hint}</span>}
    </div>
  );
}

export function PhoneGroupField({
  id,
  label,
  value,
  onChange,
  hint,
  placeholder = "13800000000",
  defaultPrefix = "+86",
  hasError = false,
}: {
  id?: string;
  label?: React.ReactNode;
  value: string;
  onChange: (fullValue: string) => void;
  hint?: React.ReactNode;
  placeholder?: string;
  defaultPrefix?: string;
  hasError?: boolean;
}) {
  let prefix = "";
  let number = "";

  const trimmed = (value || "").trim();
  if (trimmed.startsWith("+")) {
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx !== -1) {
      prefix = trimmed.slice(0, spaceIdx);
      number = trimmed.slice(spaceIdx + 1).trim();
    } else {
      prefix = trimmed;
      number = "";
    }
  } else if (trimmed) {
    prefix = defaultPrefix || "+86";
    number = trimmed;
  } else {
    prefix = defaultPrefix || "+86";
    number = "";
  }

  const prefixDigits = prefix.replace(/\D/g, "").length;
  const maxSubscriberDigits = Math.max(1, 15 - prefixDigits);

  const handlePrefixChange = (newPrefix: string) => {
    let cleanPrefix = newPrefix.trim();
    if (cleanPrefix && !cleanPrefix.startsWith("+")) {
      cleanPrefix = "+" + cleanPrefix;
    }
    const pDigits = cleanPrefix.replace(/\D/g, "").length;
    const maxSub = Math.max(1, 15 - pDigits);
    const trimmedNum = number.slice(0, maxSub);
    const combined = trimmedNum ? `${cleanPrefix} ${trimmedNum}` : cleanPrefix;
    onChange(combined);
  };

  const handleNumberChange = (newNumber: string) => {
    const cleanNum = newNumber.replace(/[^\d\s-]/g, "").slice(0, maxSubscriberDigits);
    const combined = prefix ? `${prefix} ${cleanNum}` : cleanNum;
    onChange(combined);
  };

  return (
    <div className="field">
      {label && <label htmlFor={id}>{renderLabel(label)}</label>}
      <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
        <input
          type="text"
          value={prefix}
          placeholder={defaultPrefix || "+86"}
          onChange={(e) => handlePrefixChange(e.target.value)}
          style={{
            width: "80px",
            padding: "8px 10px",
            fontSize: "13.5px",
            fontWeight: 700,
            borderRadius: "6px",
            border: hasError ? "1.5px solid #ef4444" : "1px solid #cbd5e1",
            boxShadow: hasError ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : undefined,
            background: "#f8fafc",
            color: "#1e293b",
            textAlign: "center",
            outline: "none",
            height: "38px",
            boxSizing: "border-box",
          }}
        />
        <input
          id={id}
          type="text"
          value={number}
          maxLength={maxSubscriberDigits}
          placeholder={placeholder}
          onChange={(e) => handleNumberChange(e.target.value)}
          style={{
            flex: 1,
            padding: "8px 11px",
            fontSize: "13.5px",
            borderRadius: "6px",
            border: hasError ? "1.5px solid #ef4444" : "1px solid #cbd5e1",
            boxShadow: hasError ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : undefined,
            outline: "none",
            background: "#ffffff",
            height: "38px",
            boxSizing: "border-box",
          }}
        />
      </div>
      {hint && (
        <div style={{ marginTop: "4px", fontSize: "12px", color: "#ef4444", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export const WebsiteField = WebsiteTagInput;

export function WebsiteTagInput({
  id,
  label = "Website",
  value,
  onChange,
  placeholder = "Type website and press Enter...",
  hint,
  hasError = false,
}: {
  id?: string;
  label?: React.ReactNode;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  hint?: React.ReactNode;
  hasError?: boolean;
}) {
  const [inputValue, setInputValue] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [popoverOpen, setPopoverOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Parse comma-separated website URLs into an array of clean links
  const links = useMemo(() => {
    if (!value) return [];
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }, [value]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const commitLink = (raw: string) => {
    const clean = raw.trim();
    if (!clean) {
      setErrorMsg("");
      return;
    }

    const parts = clean.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
    const updated = [...links];

    for (let p of parts) {
      if (!p.startsWith("http://") && !p.startsWith("https://")) {
        p = `https://${p}`;
      }
      if (!updated.includes(p)) {
        updated.push(p);
      }
    }

    onChange(updated.join(", "));
    setInputValue("");
    setErrorMsg("");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || e.key === " ") {
      e.preventDefault();
      commitLink(inputValue);
    } else if (e.key === "Backspace" && !inputValue && links.length > 0) {
      setErrorMsg("");
      const next = links.slice(0, -1);
      onChange(next.join(", "));
    }
  };

  const handleBlur = () => {
    if (inputValue.trim()) {
      commitLink(inputValue);
    }
  };

  const removeTag = (indexToRemove: number) => {
    if (errorMsg) setErrorMsg("");
    const next = links.filter((_, idx) => idx !== indexToRemove);
    onChange(next.join(", "));
    if (next.length <= 2) {
      setPopoverOpen(false);
    }
  };

  const formatDisplayUrl = (url: string) => {
    return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
  };

  const visibleLinks = links.slice(0, 2);
  const hiddenCount = links.length - 2;

  return (
    <div className="field" ref={containerRef} style={{ position: "relative" }}>
      {label && <label htmlFor={id}>{renderLabel(label)}</label>}
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: "flex",
          flexWrap: "nowrap",
          alignItems: "center",
          gap: "6px",
          padding: "4px 8px",
          borderRadius: "6px",
          border: hasError || errorMsg ? "1.5px solid #ef4444" : "1px solid #cbd5e1",
          background: "#ffffff",
          height: "38px",
          minHeight: "38px",
          boxSizing: "border-box",
          cursor: "text",
          transition: "all 0.15s ease",
          overflowX: "hidden",
        }}
      >
        {visibleLinks.map((link, idx) => (
          <span
            key={`${link}-${idx}`}
            style={{
              background: "#0284c7",
              color: "#ffffff",
              borderRadius: "4px",
              padding: "2px 6px 2px 8px",
              fontSize: "12px",
              fontWeight: 600,
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              whiteSpace: "nowrap",
              flexShrink: 0,
              maxWidth: "140px",
              overflow: "hidden",
            }}
          >
            <a
              href={link}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              style={{
                color: "#ffffff",
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: "3px",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={`Visit: ${link}`}
            >
              <span>🌐</span>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {formatDisplayUrl(link)}
              </span>
              <span style={{ fontSize: "10px", opacity: 0.85 }}>↗</span>
            </a>
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
                fontSize: "11px",
                cursor: "pointer",
                padding: "0 2px",
                lineHeight: 1,
                opacity: 0.85,
              }}
              title="Remove website link"
            >
              ✕
            </button>
          </span>
        ))}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPopoverOpen((prev) => !prev);
            }}
            style={{
              background: "#e0f2fe",
              color: "#0369a1",
              border: "1px solid #bae6fd",
              borderRadius: "4px",
              padding: "2px 7px",
              fontSize: "11.5px",
              fontWeight: 700,
              cursor: "pointer",
              whiteSpace: "nowrap",
              flexShrink: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: "2px",
            }}
            title="View all website links"
          >
            +{hiddenCount} 👁️
          </button>
        )}

        <input
          ref={inputRef}
          id={id}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={links.length === 0 ? placeholder : "Add..."}
          style={{
            border: "none",
            outline: "none",
            padding: "2px 4px",
            fontSize: "13px",
            background: "transparent",
            color: "#0f172a",
            minWidth: "60px",
            flex: 1,
          }}
        />
      </div>

      {popoverOpen && hiddenCount > 0 && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            zIndex: 9999,
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15)",
            padding: "10px 12px",
            minWidth: "260px",
            maxWidth: "360px",
          }}
        >
          <div
            style={{
              fontSize: "11.5px",
              fontWeight: 700,
              color: "#64748b",
              marginBottom: "8px",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>All Websites ({links.length})</span>
            <button
              type="button"
              onClick={() => setPopoverOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "#94a3b8",
                cursor: "pointer",
                fontSize: "12px",
                padding: "0 2px",
              }}
            >
              ✕
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", maxHeight: "180px", overflowY: "auto" }}>
            {links.map((link, idx) => (
              <span
                key={`popover-${link}-${idx}`}
                style={{
                  background: "#0284c7",
                  color: "#ffffff",
                  borderRadius: "4px",
                  padding: "3px 8px",
                  fontSize: "12px",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  maxWidth: "100%",
                }}
              >
                <a
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    color: "#ffffff",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span>🌐</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {formatDisplayUrl(link)}
                  </span>
                  <span>↗</span>
                </a>
                <button
                  type="button"
                  onClick={() => removeTag(idx)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#ffffff",
                    fontWeight: 700,
                    fontSize: "11px",
                    cursor: "pointer",
                    padding: "0 2px",
                    opacity: 0.85,
                  }}
                  title="Remove"
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {(hint || errorMsg) && (
        <div style={{ marginTop: "4px", fontSize: "12px", color: "#ef4444", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
          {errorMsg || hint}
        </div>
      )}
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
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCopy = (email: string, key: string) => {
    void navigator.clipboard.writeText(email);
    setCopiedKey(key);
    setTimeout(() => {
      setCopiedKey((current) => (current === key ? null : current));
    }, 1500);
  };

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
    const next = emails.filter((_, idx) => idx !== indexToRemove);
    onChange(next);
    if (next.length <= 2) {
      setPopoverOpen(false);
    }
  };

  const visibleEmails = emails.slice(0, 2);
  const hiddenCount = emails.length - 2;

  return (
    <div className="field" ref={containerRef} style={{ position: "relative" }}>
      {label && <label htmlFor={id}>{renderLabel(label)}</label>}
      <div
        onClick={() => inputRef.current?.focus()}
        style={{
          display: "flex",
          flexWrap: "nowrap",
          alignItems: "center",
          gap: "6px",
          padding: "4px 8px",
          borderRadius: "6px",
          border: errorMsg ? "1.5px solid #ef4444" : "1px solid #cbd5e1",
          background: "#ffffff",
          height: "38px",
          minHeight: "38px",
          boxSizing: "border-box",
          cursor: "text",
          transition: "all 0.15s ease",
          overflowX: "hidden",
        }}
      >
        {visibleEmails.map((email, idx) => {
          const isCopied = copiedKey === `vis-${idx}`;
          return (
            <span
              key={`${email}-${idx}`}
              style={{
                background: "#2563eb",
                color: "#ffffff",
                borderRadius: "4px",
                padding: "2px 5px 2px 7px",
                fontSize: "12px",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                whiteSpace: "nowrap",
                flexShrink: 0,
                maxWidth: "160px",
                boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
              }}
            >
              <a
                href={`mailto:${email}`}
                onClick={(e) => e.stopPropagation()}
                title={`Send email to ${email} (Click to open in mail app)`}
                style={{
                  color: "#ffffff",
                  textDecoration: "none",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
              >
                {email}
              </a>

              {/* 1-Click Copy button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  handleCopy(email, `vis-${idx}`);
                }}
                title={isCopied ? "Copied to clipboard!" : `Copy ${email}`}
                style={{
                  background: isCopied ? "#16a34a" : "rgba(255, 255, 255, 0.22)",
                  border: "none",
                  borderRadius: "3px",
                  color: "#ffffff",
                  cursor: "pointer",
                  padding: "1px 3px",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  lineHeight: 1,
                  fontSize: "10px",
                  transition: "all 0.15s ease",
                }}
              >
                {isCopied ? (
                  <span style={{ fontSize: "10px", fontWeight: 700 }}>✓</span>
                ) : (
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                )}
              </button>

              {/* Remove button */}
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
                  fontSize: "11px",
                  cursor: "pointer",
                  padding: "0 1px",
                  lineHeight: 1,
                  opacity: 0.85,
                }}
                title="Remove email"
              >
                ✕
              </button>
            </span>
          );
        })}

        {hiddenCount > 0 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPopoverOpen((prev) => !prev);
            }}
            style={{
              background: "#eff6ff",
              color: "#1d4ed8",
              border: "1px solid #bfdbfe",
              borderRadius: "4px",
              padding: "2px 7px",
              fontSize: "11.5px",
              fontWeight: 700,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "3px",
              flexShrink: 0,
              transition: "all 0.15s ease",
            }}
            title="Click to view all emails"
          >
            +{hiddenCount} more 👁️
          </button>
        )}

        <input
          ref={inputRef}
          id={id}
          type="text"
          value={inputValue}
          placeholder={emails.length === 0 ? placeholder : "Add..."}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          style={{
            border: "none",
            outline: "none",
            background: "transparent",
            flex: 1,
            minWidth: "60px",
            fontSize: "13px",
            color: "#0f172a",
            padding: "0 4px",
          }}
        />
      </div>

      {/* Clean Popover to view and remove all emails */}
      {popoverOpen && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 9999,
            background: "#ffffff",
            border: "1px solid #cbd5e1",
            borderRadius: "8px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            padding: "12px",
            maxHeight: "220px",
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px", borderBottom: "1px solid #f1f5f9", paddingBottom: "6px" }}>
            <span style={{ fontSize: "12px", fontWeight: 700, color: "#1e293b" }}>
              All Added Emails ({emails.length})
            </span>
            <button
              type="button"
              onClick={() => setPopoverOpen(false)}
              style={{
                background: "none",
                border: "none",
                color: "#64748b",
                fontSize: "12px",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              Done ✕
            </button>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {emails.map((email, idx) => {
              const isCopied = copiedKey === `pop-${idx}`;
              return (
                <span
                  key={`all-${email}-${idx}`}
                  style={{
                    background: "#2563eb",
                    color: "#ffffff",
                    borderRadius: "4px",
                    padding: "4px 8px",
                    fontSize: "12px",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "6px",
                    boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  }}
                >
                  <a
                    href={`mailto:${email}`}
                    onClick={(e) => e.stopPropagation()}
                    title={`Send email to ${email}`}
                    style={{
                      color: "#ffffff",
                      textDecoration: "none",
                      cursor: "pointer",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.textDecoration = "underline")}
                    onMouseLeave={(e) => (e.currentTarget.style.textDecoration = "none")}
                  >
                    {email}
                  </a>

                  {/* 1-Click Copy button */}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCopy(email, `pop-${idx}`);
                    }}
                    title={isCopied ? "Copied to clipboard!" : `Copy ${email}`}
                    style={{
                      background: isCopied ? "#16a34a" : "rgba(255, 255, 255, 0.22)",
                      border: "none",
                      borderRadius: "3px",
                      color: "#ffffff",
                      cursor: "pointer",
                      padding: "2px 4px",
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      lineHeight: 1,
                      fontSize: "11px",
                      transition: "all 0.15s ease",
                    }}
                  >
                    {isCopied ? (
                      <span style={{ fontSize: "10px", fontWeight: 700 }}>✓</span>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => removeTag(idx)}
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
              );
            })}
          </div>
        </div>
      )}

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
  disabled = false,
  hasError = false,
  errorMessage,
  error,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const isErr = Boolean(hasError || errorMessage || error);
  const errText = errorMessage || error;
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

  const flattenedChildren = useMemo(() => {
    const results: React.ReactElement[] = [];
    function extract(nodes: ReactNode) {
      React.Children.forEach(nodes, (child) => {
        if (!React.isValidElement(child)) return;
        if (child.type === React.Fragment) {
          extract(child.props.children);
        } else if (child.type === "option") {
          results.push(child);
        } else if (child.props && child.props.children) {
          extract(child.props.children);
        }
      });
    }
    extract(children);
    return results;
  }, [children]);

  const options = useMemo(() => {
    const list: { value: string; label: string; element: ReactNode; disabled?: boolean }[] = [];
    flattenedChildren.forEach((child) => {
      list.push({
        value: String(child.props.value ?? ""),
        label: typeof child.props.children === "string" ? child.props.children : String(child.props.children ?? child.props.value ?? ""),
        element: child.props.children ?? child.props.value ?? "",
        disabled: child.props.disabled,
      });
    });
    return list;
  }, [flattenedChildren]);

  const currentOption = options.find((o) => o.value === value);
  const displayLabel = currentOption ? currentOption.element : (options[0]?.element || "Select...");

  const filteredOptions = useMemo(() => {
    if (!searchTerm.trim()) return options;
    const term = searchTerm.toLowerCase().trim();
    return options.filter((o) => o.label.toLowerCase().includes(term));
  }, [options, searchTerm]);

  const toggleOpen = () => {
    if (disabled) return;
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        setSearchTerm("");
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      return next;
    });
  };

  return (
    <div className="field" style={{ ...style, position: "relative" }} ref={containerRef}>
      <label htmlFor={id}>{renderLabel(label)}</label>

      <div
        id={id}
        tabIndex={disabled ? -1 : 0}
        onClick={toggleOpen}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggleOpen();
          }
        }}
        style={{
          border: isErr ? "1.5px solid #ef4444" : "1px solid var(--color-border-strong)",
          boxShadow: isErr ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : undefined,
          backgroundColor: disabled ? "#f1f5f9" : isErr ? "#fff5f5" : "var(--color-surface)",
          borderRadius: "var(--radius-sm)",
          padding: "9px 11px",
          fontSize: "13.5px",
          color: disabled ? "var(--color-muted)" : "var(--color-text)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.75 : 1,
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
                    const first = filteredOptions[0];
                    if (first && !first.disabled) {
                      onChange(first.value);
                      setOpen(false);
                    }
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
          <div style={{ overflowY: "auto", flex: 1, padding: "4px 0" }}>
            {filteredOptions.length === 0 ? (
              <div style={{ padding: "8px 12px", fontSize: "13px", color: "#64748b" }}>No matches found</div>
            ) : (
              filteredOptions.map((opt, idx) => {
                const isSelected = opt.value === value;
                return (
                  <div
                    key={idx}
                    onClick={() => {
                      if (!opt.disabled) {
                        onChange(opt.value);
                        setOpen(false);
                      }
                    }}
                    style={{
                      padding: "8px 12px",
                      fontSize: "13.5px",
                      cursor: opt.disabled ? "not-allowed" : "pointer",
                      opacity: opt.disabled ? 0.5 : 1,
                      background: isSelected ? "#0061f2" : "transparent",
                      color: isSelected ? "#ffffff" : "#1e293b",
                      fontWeight: isSelected ? 600 : 400,
                    }}
                    onMouseOver={(e) => {
                      if (!isSelected && !opt.disabled) e.currentTarget.style.background = "#f1f5f9";
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

      {errText && (
        <div style={{ color: "#dc2626", fontSize: "11.5px", fontWeight: 600, marginTop: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>⚠️</span> {errText}
        </div>
      )}
      {hint && !errText && <span className="hint">{hint}</span>}
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
  hasError = false,
  errorMessage,
  error,
}: BaseFieldProps & {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  children: ReactNode;
}) {
  const isErr = Boolean(hasError || errorMessage || error);
  const errText = errorMessage || error;
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
      <label htmlFor={id}>{renderLabel(label)}</label>

      <div
        style={{
          border: isErr ? "1.5px solid #ef4444" : "1px solid var(--color-border-strong)",
          boxShadow: isErr ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : undefined,
          backgroundColor: isErr ? "#fff5f5" : "var(--color-surface)",
          borderRadius: "var(--radius-sm)",
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

      {errText && (
        <div style={{ color: "#dc2626", fontSize: "11.5px", fontWeight: 600, marginTop: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>⚠️</span> {errText}
        </div>
      )}
      {hint && !errText && <span className="hint">{hint}</span>}
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
  hasError = false,
  errorMessage,
  error,
}: BaseFieldProps & {
  values: string[];
  options: { id: string; name: string }[];
  onChange: (newValues: string[]) => void;
  placeholder?: string;
}) {
  const isErr = Boolean(hasError || errorMessage || error);
  const errText = errorMessage || error;
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
          border: isErr ? "1.5px solid #ef4444" : "1px solid var(--color-border-strong)",
          boxShadow: isErr ? "0 0 0 3px rgba(239, 68, 68, 0.15)" : undefined,
          backgroundColor: isErr ? "#fff5f5" : "var(--color-surface)",
          borderRadius: "var(--radius-sm)",
          padding: "6px 11px",
          minHeight: "40px",
          maxHeight: "40px",
          fontSize: "13.5px",
          color: "var(--color-text)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          userSelect: "none",
          overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", gap: "6px", alignItems: "center", flex: 1, overflow: "hidden" }}>
          {selectedOptions.length === 0 ? (
            <span style={{ color: "var(--color-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{placeholder}</span>
          ) : selectedOptions.length === 1 ? (
            <span
              style={{
                background: "#eff6ff",
                color: "#1d4ed8",
                border: "1px solid #bfdbfe",
                borderRadius: "4px",
                padding: "2px 8px",
                fontSize: "12px",
                fontWeight: 600,
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                whiteSpace: "nowrap",
                maxWidth: "200px",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
              onClick={(e) => {
                e.stopPropagation();
                toggleOption(selectedOptions[0].id);
              }}
              title={selectedOptions[0].name}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{selectedOptions[0].name}</span>
              <span style={{ cursor: "pointer", color: "#3b82f6", fontWeight: 700 }}>×</span>
            </span>
          ) : (
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "nowrap", overflow: "hidden" }}>
              <span
                style={{
                  background: "#eff6ff",
                  color: "#1d4ed8",
                  border: "1px solid #bfdbfe",
                  borderRadius: "4px",
                  padding: "2px 8px",
                  fontSize: "12px",
                  fontWeight: 600,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  whiteSpace: "nowrap",
                  maxWidth: "110px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleOption(selectedOptions[0].id);
                }}
                title={selectedOptions[0].name}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{selectedOptions[0].name}</span>
                <span style={{ cursor: "pointer", color: "#3b82f6", fontWeight: 700 }}>×</span>
              </span>

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
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  whiteSpace: "nowrap",
                  boxShadow: "0 1px 2px rgba(0,0,0,0.1)",
                  flexShrink: 0,
                }}
                title="Click to view all selected items"
              >
                👁️ +{selectedOptions.length - 1} More
              </span>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {selectedOptions.length > 0 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowEyeModal(true);
              }}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: "14px",
                padding: "2px 4px",
                borderRadius: "4px",
                display: "flex",
                alignItems: "center",
              }}
              title="View selected items in modal"
            >
              👁️
            </button>
          )}
          <span style={{ fontSize: "10px", color: "var(--color-muted)" }}>
            {open ? "▲" : "▼"}
          </span>
        </div>
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
            maxHeight: "280px",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {/* Select All / Clear All Bar */}
          <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 12px", background: "#f1f5f9", borderBottom: "1px solid #e2e8f0", fontSize: "12px", fontWeight: 600 }}>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange(options.map((o) => o.id));
              }}
              style={{ background: "none", border: "none", color: "#0284c7", cursor: "pointer", fontWeight: 600, padding: 0 }}
            >
              ☑ Select All ({options.length})
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onChange([]);
              }}
              style={{ background: "none", border: "none", color: "#dc2626", cursor: "pointer", fontWeight: 600, padding: 0 }}
            >
              ☒ Clear All
            </button>
          </div>

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
                      onChange={() => { }}
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

      {errText && (
        <div style={{ color: "#dc2626", fontSize: "11.5px", fontWeight: 600, marginTop: "4px", display: "flex", alignItems: "center", gap: "4px" }}>
          <span>⚠️</span> {errText}
        </div>
      )}
      {hint && !errText && <span className="hint">{hint}</span>}
    </div>
  );
}