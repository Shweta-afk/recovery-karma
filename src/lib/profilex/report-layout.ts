// Turns an Insights / credit-report response into something a person can read: titled sections,
// each with a two-column label/value table and row tables for lists (loan accounts, enquiries,
// address variations…). Pure — no React — so the on-screen ReportView
// (components/profilex/report-view.tsx) and the downloadable CIBIL file (cibil/payprime.ts)
// lay a report out identically.
//
// flatten() (./flatten.ts) stays for exports that need one flat list. It is what every screen
// used until 2026-10-21, and a credit report with 76 loan accounts came out as hundreds of lines
// like "Loan Accounts 37 Loan Details Account Status" — impossible to follow (user, 2026-10-21).

import { humanise } from "./flatten";

export interface ReportField {
  label: string;
  value: string;
}

export interface ReportTable {
  title: string;
  columns: string[];
  /** One row per list item, aligned with `columns`; "" where the item has no value. */
  rows: string[][];
}

export interface ReportSection {
  title: string;
  fields: ReportField[];
  tables: ReportTable[];
  sections: ReportSection[];
}

// Envelope keys that say how the call went, not anything about the person. Same list as
// flatten()'s, plus the wrapper keys the CRIF report adds around its three `data` layers.
const NOISE = new Set([
  "status",
  "statusCode",
  "status_code",
  "message",
  "success",
  "timestamp",
  "transactionId",
  "transaction_id",
  "request_id",
  "response_time_ms",
  "packageVersion",
  "partial_output",
]);

/** Text longer than this is a blob (an embedded printable report, base64), not a field. */
const MAX_VALUE = 400;
const MAX_DEPTH = 8;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v: unknown) =>
  v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v);

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return s === "null" || s === "undefined" || s.length > MAX_VALUE ? "" : s;
}

/** Labels like "AVERAGE-ACCOUNT-AGE-MONTH" or "dateOfIssue" → "Average Account Age Month". */
export function label(key: string): string {
  return humanise(key.replace(/-/g, " "));
}

/** Peels response envelopes: `{status, data: {...}}` → the `data`, as many layers as there are
 *  (the CRIF report has three). */
export function unwrap(node: unknown): unknown {
  let cur = node;
  for (let i = 0; i < 6 && isObj(cur); i++) {
    const keys = Object.keys(cur).filter((k) => !NOISE.has(k));
    if (keys.length === 1 && keys[0] === "data" && (isObj(cur.data) || Array.isArray(cur.data))) {
      cur = cur.data;
    } else break;
  }
  return cur;
}

/** `{VARIATION: [...]}` / `{HISTORY: [...]}` — an object whose only content is one list. */
function soleList(o: Obj): unknown[] | null {
  const keys = Object.keys(o).filter((k) => !NOISE.has(k));
  return keys.length === 1 && Array.isArray(o[keys[0]]) ? (o[keys[0]] as unknown[]) : null;
}

/** One list item as table cells: scalars become columns, nested objects become prefixed
 *  columns, and nested lists are written out in the cell rather than exploding into columns. */
function cells(item: unknown, prefix = "", out = new Map<string, string>(), depth = 0) {
  if (isScalar(item)) {
    const v = text(item);
    if (v) out.set(prefix || "Value", v);
    return out;
  }
  if (Array.isArray(item)) {
    const v = item.map((x) => (isScalar(x) ? text(x) : inline(x))).filter(Boolean);
    if (v.length) out.set(prefix || "Value", v.join(isScalar(item[0]) ? ", " : " | "));
    return out;
  }
  if (!isObj(item) || depth > 3) return out;
  for (const [k, v] of Object.entries(item)) {
    if (NOISE.has(k)) continue;
    cells(v, prefix ? `${prefix} · ${label(k)}` : label(k), out, depth + 1);
  }
  return out;
}

/** A nested object written on one line, for a table cell: "Date: 01-02-2024, Amount: 5000". */
function inline(o: unknown): string {
  return [...cells(o).entries()].map(([k, v]) => `${k}: ${v}`).join(", ");
}

function table(title: string, items: unknown[]): ReportTable | ReportField | null {
  if (items.length === 0) return null;
  if (items.every(isScalar)) {
    const v = items.map(text).filter(Boolean);
    return v.length ? { label: title, value: v.join(", ") } : null;
  }
  // Each item wrapped in the same single key (`{"LOAN-DETAILS": {...}}`) — use what is inside.
  const only = items.every(isObj) ? Object.keys(items[0] as Obj) : [];
  const unwrapped =
    only.length === 1 && items.every((i) => isObj(i) && Object.keys(i).length === 1 && only[0] in i)
      ? items.map((i) => (i as Obj)[only[0]])
      : items;
  const rowMaps = unwrapped.map((i) => cells(i));
  const columns: string[] = [];
  for (const m of rowMaps) for (const k of m.keys()) if (!columns.includes(k)) columns.push(k);
  if (columns.length === 0) return null;
  return { title, columns, rows: rowMaps.map((m) => columns.map((c) => m.get(c) ?? "")) };
}

function isEmpty(s: ReportSection): boolean {
  return !s.fields.length && !s.tables.length && s.sections.every(isEmpty);
}

function section(title: string, node: Obj, depth: number): ReportSection {
  const out: ReportSection = { title, fields: [], tables: [], sections: [] };
  for (const [k, v] of Object.entries(node)) {
    if (NOISE.has(k)) continue;
    const name = label(k);
    if (isScalar(v)) {
      const t = text(v);
      if (t) out.fields.push({ label: name, value: t });
      continue;
    }
    const list = Array.isArray(v) ? v : isObj(v) ? soleList(v) : null;
    if (list) {
      const t = table(name, list);
      if (t && "columns" in t) out.tables.push(t);
      else if (t) out.fields.push(t);
      continue;
    }
    if (isObj(v) && depth < MAX_DEPTH) {
      // `{"SCORE": {...}}` under "Scores": one heading, not two.
      const keys = Object.keys(v).filter((x) => !NOISE.has(x));
      const inner = keys.length === 1 && isObj(v[keys[0]]) ? (v[keys[0]] as Obj) : v;
      const sub = section(name, inner, depth + 1);
      if (!isEmpty(sub)) out.sections.push(sub);
    }
  }
  return out;
}

/** The report laid out for reading. `title` names the top section (e.g. the service label). */
export function buildReportLayout(response: unknown, title = "Report"): ReportSection {
  const root = unwrap(response);
  if (Array.isArray(root)) {
    const t = table(title, root);
    const out: ReportSection = { title, fields: [], tables: [], sections: [] };
    if (t && "columns" in t) out.tables.push(t);
    else if (t) out.fields.push(t);
    return out;
  }
  if (!isObj(root)) {
    const v = text(root);
    return { title, fields: v ? [{ label: "Value", value: v }] : [], tables: [], sections: [] };
  }
  return section(title, root, 0);
}

/** How many values the layout shows — 0 means the provider sent nothing usable. */
export function countValues(s: ReportSection): number {
  return (
    s.fields.length +
    s.tables.reduce((n, t) => n + t.rows.reduce((m, r) => m + r.filter(Boolean).length, 0), 0) +
    s.sections.reduce((n, x) => n + countValues(x), 0)
  );
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** The same layout as HTML, for a downloadable/printable file. */
export function reportLayoutHtml(s: ReportSection, level = 2): string {
  const h = `h${Math.min(level, 6)}`;
  const fields = s.fields.length
    ? `<table class="kv">${s.fields.map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`).join("")}</table>`
    : "";
  const tables = s.tables
    .map(
      (t) =>
        `<h${Math.min(level + 1, 6)}>${esc(t.title)} (${t.rows.length})</h${Math.min(level + 1, 6)}>` +
        `<div class="wrap"><table class="grid"><thead><tr><th>#</th>${t.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
        t.rows
          .map((r, i) => `<tr><td>${i + 1}</td>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`)
          .join("") +
        `</tbody></table></div>`,
    )
    .join("");
  const subs = s.sections.map((x) => reportLayoutHtml(x, level + 1)).join("");
  return `<section><${h}>${esc(s.title)}</${h}>${fields}${tables}${subs}</section>`;
}

/** Styles for reportLayoutHtml — screen and print. */
export const REPORT_HTML_CSS =
  "table{border-collapse:collapse;width:100%;margin:6px 0 14px}" +
  "th,td{border:1px solid #ddd;padding:5px 8px;text-align:left;vertical-align:top;font-size:12px}" +
  "table.kv th{width:38%;background:#f6f6f6;color:#333;font-weight:600}" +
  "table.grid thead th{background:#f0f0f0;position:sticky;top:0}" +
  "table.grid tbody tr:nth-child(even){background:#fafafa}" +
  ".wrap{overflow-x:auto}section section{margin-left:0}" +
  "h2{font-size:17px;margin:22px 0 6px}h3{font-size:15px;margin:18px 0 6px}h4,h5,h6{font-size:13px;margin:14px 0 4px}" +
  "@media print{.wrap{overflow:visible}table.grid{font-size:10px}}";
