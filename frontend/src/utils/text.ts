/** Text formatting & string helpers for ERP frontend */

export function autoTitleCase(text: string, id?: string, type?: string): string {
  if (!text) return "";

  const lowerId = (id || "").toLowerCase();
  const lowerType = (type || "text").toLowerCase();

  if (
    lowerType === "email" ||
    lowerType === "password" ||
    lowerType === "number" ||
    lowerType === "url" ||
    lowerType === "tel" ||
    lowerType === "select" ||
    lowerId.endsWith("_id") ||
    lowerId.includes("type") ||
    lowerId.includes("status") ||
    lowerId.includes("salutation") ||
    lowerId.includes("gender") ||
    lowerId.includes("email") ||
    lowerId.includes("website") ||
    lowerId.includes("url") ||
    lowerId.includes("password") ||
    lowerId.includes("phone") ||
    lowerId.includes("calling") ||
    lowerId.includes("whatsapp") ||
    lowerId.includes("wechat") ||
    text.includes("@") ||
    text.startsWith("http://") ||
    text.startsWith("https://")
  ) {
    return text;
  }

  // Auto capitalize first letter of each word
  return text.replace(/\b[a-z]/g, (char) => char.toUpperCase());
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
