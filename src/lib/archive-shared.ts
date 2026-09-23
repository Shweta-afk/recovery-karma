// Pure helpers for the monthly archive — no server, no browser, no Supabase — so both the
// server action and the admin page can use them and scripts/archive.test.ts can pin them.

/** Every 'YYYY-MM' from `fromMonth` through `toMonth` inclusive, oldest first. */
export function monthsBetween(fromMonth: string, toMonth: string): string[] {
  const ok = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
  if (!ok(fromMonth) || !ok(toMonth) || fromMonth > toMonth) return [];
  const out: string[] = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** What each archive `kind` is called in the spreadsheet, in the order the sheets appear. */
export const ARCHIVE_SHEETS: { kind: string; sheet: string }[] = [
  { kind: "trace", sheet: "Insights lookups" },
  { kind: "call_log", sheet: "Calls & feedback" },
  { kind: "payment", sheet: "Payments" },
  { kind: "message", sheet: "Messages" },
  { kind: "dispute", sheet: "Disputes" },
  { kind: "settlement", sheet: "Settlements" },
  { kind: "debtor", sheet: "Accounts" },
  { kind: "portfolio", sheet: "Portfolios" },
  { kind: "portfolio_target", sheet: "Agent targets" },
];

/** Excel refuses a cell over 32,767 characters and would corrupt the whole file. */
const EXCEL_CELL_LIMIT = 32_000;

function cell(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return text.length > EXCEL_CELL_LIMIT ? `${text.slice(0, EXCEL_CELL_LIMIT)}…[truncated]` : text;
}

/**
 * Turns archived `data` objects into a header row + value rows.
 *
 * Columns are the union of every key seen, in first-seen order. `extra` (the bank file's
 * unmapped columns) is spread into one `extra: <name>` column each, since ~150 of them hidden
 * in a single JSON cell would make the Accounts sheet useless. Every other nested value
 * (a lookup's `response`, `settings`) is kept whole as JSON text.
 */
export function shapeSheet(rows: Record<string, unknown>[]): {
  columns: string[];
  values: (string | number | boolean | null)[][];
} {
  const flat = rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (k === "extra" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [ek, ev] of Object.entries(v as Record<string, unknown>)) {
          out[`extra: ${ek}`] = ev;
        }
      } else {
        out[k] = v;
      }
    }
    return out;
  });
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of flat) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  return { columns, values: flat.map((r) => columns.map((c) => cell(r[c]))) };
}
