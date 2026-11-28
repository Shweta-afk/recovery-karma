// Pure rules for emailing reports (no imports from server or browser code).

export const MAX_LIST_SIZE = 50;
/** Resend's limit is 40 MB per email after base64; keep well under it. */
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

/** Split pasted text (commas, semicolons, spaces, new lines) into unique, lower-cased addresses. */
export function parseEmailList(text: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const e = raw.trim().replace(/^<|>$/g, "").toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) {
      invalid.push(raw.trim());
      continue;
    }
    if (!seen.has(e)) {
      seen.add(e);
      valid.push(e);
    }
  }
  return { valid, invalid };
}

/** Only file names our exports produce; nothing that could be a path or a header injection. */
export function safeAttachmentName(name: string): string {
  const cleaned = name.replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  return cleaned || "report";
}

export const ALLOWED_TYPES: Record<string, string> = {
  csv: "text/csv",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
  png: "image/png",
};

export function attachmentExt(name: string): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ext in ALLOWED_TYPES ? ext : null;
}

/** "agent-performance.csv" → "Agent performance" */
export function reportNameFromFile(name: string): string {
  const base = name
    .replace(/\.[^.]+$/, "")
    .replace(/^samvadx-/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : "Report";
}
