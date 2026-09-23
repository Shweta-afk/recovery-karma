// Turns an Insights (ProfileX) response into flat label/value pairs. Pure — no React, no
// Supabase — so both the debtor profile's Insights panel (components/profilex/trace-panel.tsx)
// and the server-side dead-account Excel export (dead-account-archive.server.ts) render a
// lookup's fields identically.

// Envelope/plumbing keys that carry no information for an agent looking at a debtor.
const NOISE = new Set([
  "status",
  "statusCode",
  "message",
  "success",
  "timestamp",
  "transactionId",
  "packageVersion",
  "partial_output",
]);

/** snake_case / camelCase -> "Sentence case", with the acronyms this data is full of kept upper. */
export function humanise(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[_\s]+/)
    .filter(Boolean);
  return words
    .map((w) =>
      /^(uan|pan|ifsc|dob|epfo|id|no|acc)$/i.test(w)
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join(" ");
}

export interface Leaf {
  label: string;
  value: string;
}

/**
 * Every non-empty scalar in the response, flattened for display.
 *
 * The panel used to show only a hand-picked summary, which meant a manager paid for ~94 fields
 * and saw five — including things that matter for recovery like the debtor's father's name,
 * date of birth and bank branch. Anything paid for should be visible; the curated block above
 * stays as the scannable part, and this is everything else.
 */
export function flatten(node: unknown, prefix = "", out: Leaf[] = [], depth = 0): Leaf[] {
  if (node === null || node === undefined || depth > 6) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) =>
      flatten(v, prefix ? `${prefix} ${i + 1}` : String(i + 1), out, depth + 1),
    );
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (NOISE.has(k)) continue;
      // A UAN-keyed map (uan_details) adds nothing but a long number to every label.
      const isIdKey = /^\d{8,}$/.test(k);
      flatten(v, isIdKey ? prefix : humanise(k), out, depth + 1);
    }
    return out;
  }
  const value = String(node).trim();
  if (!value || value === "null" || value === "undefined") return out;
  out.push({ label: prefix || "Value", value });
  return out;
}
