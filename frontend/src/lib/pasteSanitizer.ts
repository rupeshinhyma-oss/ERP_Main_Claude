/**
 * Global Paste Auto-Clean Sanitizer.
 *
 * Automatically intercepts clipboard paste events on input and textarea elements
 * across the entire ERP to strip:
 * 1. Accidental leading and trailing whitespace from Excel cells, PDFs, or tables.
 * 2. Non-breaking spaces (\u00A0).
 * 3. Invisible tabs (\t) and carriage returns from spreadsheet selections.
 */

export function initGlobalPasteSanitizer(): () => void {
  const handlePaste = (e: ClipboardEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      return;
    }

    // Skip password inputs or file inputs where whitespace or raw bytes might be intentional
    if (target instanceof HTMLInputElement && (target.type === "password" || target.type === "file")) {
      return;
    }

    const text = e.clipboardData?.getData("text");
    if (!text) return;

    // Normalize non-breaking spaces
    let cleaned = text.replace(/\u00A0/g, " ");

    if (target instanceof HTMLInputElement) {
      // Single-line inputs: replace tabs and newlines with spaces, then trim edges
      cleaned = cleaned.replace(/[\r\n\t]+/g, " ").trim();
    } else {
      // Multi-line textareas: preserve internal newlines, but trim outer padding
      cleaned = cleaned.trim();
    }

    if (cleaned !== text) {
      e.preventDefault();

      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const val = target.value;
      const nextVal = val.slice(0, start) + cleaned + val.slice(end);

      const proto =
        target instanceof HTMLInputElement
          ? window.HTMLInputElement.prototype
          : window.HTMLTextAreaElement.prototype;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

      if (nativeValueSetter) {
        nativeValueSetter.call(target, nextVal);
      } else {
        target.value = nextVal;
      }

      const newCursorPos = start + cleaned.length;
      target.setSelectionRange(newCursorPos, newCursorPos);
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    }
  };

  document.addEventListener("paste", handlePaste, true);
  return () => {
    document.removeEventListener("paste", handlePaste, true);
  };
}
