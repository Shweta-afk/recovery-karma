// "Lookup data by Loan ID": everything the Insights lookups found on a portfolio, one row per
// account, set beside what the bank's own file says about that loan. Pure — no Supabase, no
// React — so the server action and the tests share it (scripts/loan-lookup-data.test.ts).
//
// Extraction is by field NAME, walked through the whole response, rather than per service: the
// skip-tracing bundle nests the same blocks the standalone services return (vrePanAdvance,
// vrePhoneToPrefill, getAlternateAddress…), so one walker covers both, and a service added to the
// catalogue later contributes without a code change here. Everything not picked out below still
// reaches the export: every field ProfileX returned gets its own column on that service's sheet
// (buildServiceSheets), plus the raw JSON, so nothing paid for is left out of the file.

import { extractPhones, normalisePhone } from "./billing";
import { humanise } from "./flatten";
import { lookupResult } from "./outcome";

type Json = Record<string, unknown>;

/** One completed lookup plus the account it was run on, as the server action reads it. */
export interface LoanTraceInput {
  traceId: string;
  debtorId: string;
  serviceId: string;
  state: string;
  providerStatus: string | null;
  billable: boolean;
  cost: number;
  createdAt: string;
  response: unknown;
  loanReference: string;
  name: string;
  phonePrimary: string;
  email: string | null;
  /** The bank file's address/city/state/dob/employer (debtors.extra_named). */
  bankExtra: Record<string, string>;
}

export type Compare = "match" | "differs" | "";

export interface LoanLookupRow {
  debtorId: string;
  loanReference: string;
  name: string;
  phonePrimary: string;
  bank: { email: string; address: string; city: string; dob: string; employer: string };
  lookups: number;
  lookupsFound: number;
  services: string[];
  cost: number;
  firstLookupAt: string;
  lastLookupAt: string;
  /** Mobiles found that are not the loan's primary number. */
  newNumbers: string[];
  emails: string[];
  namesFound: string[];
  fatherName: string;
  dob: string;
  age: string;
  gender: string;
  pan: string;
  uan: string;
  employer: string;
  employed: string;
  dateOfJoining: string;
  upiIds: string[];
  addresses: string[];
  gst: string[];
  compare: { name: Compare; dob: Compare; employer: Compare; email: Compare; city: Compare };
}

/** One lookup with every field it returned, for the per-service sheets. */
export interface LoanLookupDetail {
  debtorId: string;
  loanReference: string;
  name: string;
  phonePrimary: string;
  serviceId: string;
  result: string;
  createdAt: string;
  cost: number;
  /** Every non-empty value in the response's `data`, flattened to label/value. */
  fields: { label: string; value: string }[];
  /** The whole stored response, verbatim — the envelope keys flatten() skips included. */
  raw: string;
}

/**
 * Every scalar in a response with its full path as the label — "Vre Pan Advance › Pincode",
 * "Email 2 › Email" — so each becomes a distinct Excel column. flatten() (the on-screen list)
 * labels by the leaf key alone, which is readable in a card but makes two blocks' "Status" or a
 * list's emails collide as columns. Keys that are ids (a UAN keying uan_details) become "#1",
 * "#2" by position, so the same field lines up in one column across borrowers. Booleans and
 * zeros are kept; only null/empty is skipped.
 */
export function flattenPaths(
  node: unknown,
  path: string[] = [],
  out: { label: string; value: string }[] = [],
  depth = 0,
): { label: string; value: string }[] {
  if (node === null || node === undefined || depth > 10) return out;
  if (Array.isArray(node)) {
    node.forEach((v, i) => {
      const p = path.length
        ? [...path.slice(0, -1), `${path[path.length - 1]} ${i + 1}`]
        : [String(i + 1)];
      flattenPaths(v, p, out, depth + 1);
    });
    return out;
  }
  if (typeof node === "object") {
    let idN = 0;
    for (const [k, v] of Object.entries(node as Json)) {
      const seg = /^\d{6,}$/.test(k) ? `#${++idN}` : humanise(k);
      flattenPaths(v, [...path, seg], out, depth + 1);
    }
    return out;
  }
  const value = String(node).trim();
  if (!value || value === "null" || value === "undefined") return out;
  out.push({ label: path.join(" › ") || "Value", value });
  return out;
}

const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

/** Every value under a key matching `key`, anywhere in the tree (depth-limited). */
function collect(node: unknown, key: RegExp, out: unknown[] = [], depth = 0): unknown[] {
  if (node === null || node === undefined || depth > 7) return out;
  if (Array.isArray(node)) {
    for (const v of node) collect(v, key, out, depth + 1);
    return out;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Json)) {
      if (key.test(k)) out.push(v);
      if (v && typeof v === "object") collect(v, key, out, depth + 1);
    }
  }
  return out;
}

/** Scalar strings under matching keys, including plain string arrays. */
function strings(node: unknown, key: RegExp): string[] {
  const out: string[] = [];
  for (const v of collect(node, key)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      const s = str(x);
      if (s && s !== "null") out.push(s);
    }
  }
  return out;
}

const uniq = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

function addressesIn(data: unknown): string[] {
  const out: string[] = [];
  // Alternate Address: { address_text }
  out.push(...strings(data, /^address_text$/));
  // Phone to Prefill: address[] of { Address, State, Postal }
  for (const a of collect(data, /^address$/)) {
    for (const x of Array.isArray(a) ? a : []) {
      if (x && typeof x === "object") {
        const o = x as Json;
        const line = [str(o.Address), str(o.State), str(o.Postal)].filter(Boolean).join(", ");
        if (line) out.push(line);
      }
    }
  }
  // PAN Advance: address_line1..5 + pincode on one object
  for (const lines of collect(data, /^vrePanAdvance$|^pan_details$/)) {
    if (lines && typeof lines === "object") {
      const o = lines as Json;
      const line = [1, 2, 3, 4, 5]
        .map((n) => str(o[`address_line${n}`]))
        .concat(str(o.pincode))
        .filter(Boolean)
        .join(", ");
      if (line) out.push(line);
    }
  }
  // LPG: customer_address object
  for (const addr of collect(data, /^customer_address$/)) {
    if (addr && typeof addr === "object") {
      const o = addr as Json;
      const line = ["address_line1", "address_line2", "address_line3", "city", "state", "pincode"]
        .map((k) => str(o[k]))
        .filter(Boolean)
        .join(", ");
      if (line) out.push(line);
    }
  }
  return out;
}

/** The most recent employer: the employment summary when present, else any establishment. */
function employmentIn(data: unknown): { employer: string; employed: string; joined: string } {
  const recent = collect(data, /^recent_employer_data$/).find((v) => v && typeof v === "object") as
    Json | undefined;
  const employedRaw = collect(data, /^is_employed$/).find((v) => typeof v === "boolean");
  return {
    employer: str(recent?.establishment_name) || strings(data, /^establishment_name$/)[0] || "",
    employed: employedRaw === undefined ? "" : employedRaw ? "Yes" : "No",
    joined: str(recent?.date_of_joining) || strings(data, /^date_of_joining$/)[0] || "",
  };
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const UAN_RE = /^\d{12}$/;

/** Dates arrive as 16-07-1978, 1978-07-16, 16/07/1978 — reduce to YYYYMMDD to compare. */
export function dateKey(raw: string): string {
  const m = raw.trim().match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
  if (!m) return "";
  const [a, b, c] = [m[1], m[2], m[3]];
  const [y, mo, d] = a.length === 4 ? [a, b, c] : [c, b, a];
  if (y.length !== 4) return "";
  return `${y}${mo.padStart(2, "0")}${d.padStart(2, "0")}`;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !/^(pvt|ltd|private|limited|the|and|india|llp)$/.test(w));

function compareName(bank: string, found: string[]): Compare {
  if (!bank || !found.length) return "";
  const first = words(bank)[0];
  if (!first) return "";
  return found.some((f) => words(f).includes(first)) ? "match" : "differs";
}

function compareEmployer(bank: string, found: string): Compare {
  if (!bank || !found) return "";
  const b = words(bank);
  const f = new Set(words(found));
  return b.some((w) => f.has(w)) ? "match" : "differs";
}

function compareDob(bank: string, found: string): Compare {
  const b = dateKey(bank);
  const f = dateKey(found);
  if (!b || !f) return "";
  return b === f ? "match" : "differs";
}

function compareEmail(bank: string | null, found: string[]): Compare {
  if (!bank || !found.length) return "";
  return found.some((e) => e.toLowerCase() === bank.trim().toLowerCase()) ? "match" : "differs";
}

function compareCity(bankCity: string, found: string[]): Compare {
  if (!bankCity || !found.length) return "";
  const c = bankCity.trim().toLowerCase();
  return found.some((a) => a.toLowerCase().includes(c)) ? "match" : "differs";
}

/**
 * Lookups → one row per loan, plus one detail row per lookup. Traces may arrive in any order;
 * within a loan the newest lookup wins for single-valued fields (employer, DOB…), and list
 * fields (numbers, emails, addresses) are merged and de-duplicated across every lookup.
 */
export function buildLoanLookupData(traces: LoanTraceInput[]): {
  rows: LoanLookupRow[];
  details: LoanLookupDetail[];
} {
  const byDebtor = new Map<string, LoanTraceInput[]>();
  for (const t of traces) {
    const list = byDebtor.get(t.debtorId);
    if (list) list.push(t);
    else byDebtor.set(t.debtorId, [t]);
  }

  const rows: LoanLookupRow[] = [];
  const details: LoanLookupDetail[] = [];

  for (const list of byDebtor.values()) {
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // newest first
    const head = list[0];
    const primary = normalisePhone(head.phonePrimary);
    const found = list.filter(
      (t) => lookupResult(t.state, t.providerStatus, t.response) === "found",
    );
    const datas = found.map((t) => (t.response as Json | null)?.data ?? null);
    const firstOf = (key: RegExp, test?: (s: string) => boolean) => {
      for (const d of datas) {
        const hit = strings(d, key).find((s) => !test || test(s));
        if (hit) return hit;
      }
      return "";
    };

    const phones = new Set<string>();
    for (const t of found) for (const p of extractPhones(t.response)) phones.add(p);
    phones.delete(primary);

    let emp = { employer: "", employed: "", joined: "" };
    for (const d of datas) {
      const e = employmentIn(d);
      if (e.employer) {
        emp = e;
        break;
      }
    }

    const emails = uniq(
      datas.flatMap((d) => strings(d, /^(email|email_id)$/)).filter((e) => e.includes("@")),
    );
    const namesFound = uniq(datas.flatMap((d) => strings(d, /^(fullName|full_name)$/)));
    const addresses = uniq(datas.flatMap(addressesIn));
    const dob = firstOf(/^(dob|date_of_birth)$/);
    const bankAddress = [head.bankExtra.address, head.bankExtra.city, head.bankExtra.state]
      .map((s) => (s ?? "").trim())
      .filter(Boolean)
      .join(", ");

    rows.push({
      debtorId: head.debtorId,
      loanReference: head.loanReference,
      name: head.name,
      phonePrimary: head.phonePrimary,
      bank: {
        email: head.email ?? "",
        address: bankAddress,
        city: (head.bankExtra.city ?? "").trim(),
        dob: (head.bankExtra.dob ?? "").trim(),
        employer: (head.bankExtra.employer ?? "").trim(),
      },
      lookups: list.length,
      lookupsFound: found.length,
      services: [...new Set(list.map((t) => t.serviceId))],
      cost: list.reduce((s, t) => s + (t.billable ? t.cost : 0), 0),
      firstLookupAt: list[list.length - 1].createdAt,
      lastLookupAt: head.createdAt,
      newNumbers: [...phones],
      emails,
      namesFound,
      fatherName: firstOf(/^(father_name|fatherName)$/),
      dob,
      age: firstOf(/^age$/),
      gender: firstOf(/^gender$/),
      pan: firstOf(/^pan$/, (s) => PAN_RE.test(s)),
      uan: firstOf(/^(uan|matching_uan)$/, (s) => UAN_RE.test(s)),
      employer: emp.employer,
      employed: emp.employed,
      dateOfJoining: emp.joined,
      upiIds: uniq(datas.flatMap((d) => strings(d, /^upi_id$/))),
      addresses,
      gst: uniq(
        datas.flatMap((d) =>
          collect(d, /^result$/)
            .flatMap((r) => (Array.isArray(r) ? r : []))
            .map((g) => {
              const o = (g ?? {}) as Json;
              return str(o.gstin)
                ? [str(o.legal_name), str(o.gstin)].filter(Boolean).join(" · ")
                : "";
            })
            .filter(Boolean),
        ),
      ),
      compare: {
        name: compareName(head.name, namesFound),
        dob: compareDob(head.bankExtra.dob ?? "", dob),
        employer: compareEmployer(head.bankExtra.employer ?? "", emp.employer),
        email: compareEmail(head.email, emails),
        city: compareCity(head.bankExtra.city ?? "", addresses),
      },
    });

    for (const t of list) {
      const result = lookupResult(t.state, t.providerStatus, t.response);
      const data = (t.response as Json | null)?.data ?? t.response;
      details.push({
        debtorId: t.debtorId,
        loanReference: t.loanReference,
        name: t.name,
        phonePrimary: t.phonePrimary,
        serviceId: t.serviceId,
        result: result === "found" ? "Found" : result === "not_found" ? "Not found" : result,
        createdAt: t.createdAt,
        cost: t.billable ? t.cost : 0,
        fields: flattenPaths(data),
        raw: t.response == null ? "" : JSON.stringify(t.response),
      });
    }
  }

  rows.sort((a, b) => b.lastLookupAt.localeCompare(a.lastLookupAt));
  details.sort(
    (a, b) =>
      a.loanReference.localeCompare(b.loanReference) || b.createdAt.localeCompare(a.createdAt),
  );
  return { rows, details };
}

export const COMPARE_LABEL: Record<Compare, string> = {
  match: "Match",
  differs: "Differs",
  "": "",
};

// ── Excel layout ───────────────────────────────────────────────────────────────────────────────

/** Excel rejects a cell over 32,767 characters and corrupts the whole file. */
const clip = (s: string) => (s.length > 32_000 ? `${s.slice(0, 32_000)}…[truncated]` : s);
const IST_MS = 5.5 * 60 * 60 * 1000;
const ist = (iso: string) =>
  iso
    ? new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 16).replace("T", " ")
    : "";

/** "By Loan ID" sheet: bank file first, then what the lookups found, each compared field
 *  followed by its Match / Differs column. */
export const LOAN_EXPORT_HEADERS = [
  "Loan Account Number",
  "Customer Name (bank file)",
  "Primary Number (bank file)",
  "New Numbers Found",
  "Email (bank file)",
  "Emails Found",
  "Email vs Bank",
  "Names Found",
  "Name vs Bank",
  "Father's Name",
  "DOB (bank file)",
  "DOB Found",
  "DOB vs Bank",
  "Age",
  "Gender",
  "PAN",
  "UAN",
  "Employer (bank file)",
  "Employer Found",
  "Currently Employed",
  "Date of Joining",
  "Employer vs Bank",
  "Address (bank file)",
  "Addresses Found",
  "City vs Bank",
  "UPI IDs",
  "GST",
  "Services Run",
  "Lookups",
  "Lookups With Data",
  "Cost (INR)",
  "First Lookup (IST)",
  "Last Lookup (IST)",
] as const;

export function loanExportRow(
  r: LoanLookupRow,
  serviceLabel: (id: string) => string,
): (string | number)[] {
  const list = (xs: string[]) => clip(xs.join("\n"));
  const c = (x: Compare) => COMPARE_LABEL[x];
  return [
    r.loanReference,
    r.name,
    r.phonePrimary,
    r.newNumbers.join(", "),
    r.bank.email,
    list(r.emails),
    c(r.compare.email),
    list(r.namesFound),
    c(r.compare.name),
    r.fatherName,
    r.bank.dob,
    r.dob,
    c(r.compare.dob),
    r.age,
    r.gender,
    r.pan,
    r.uan,
    r.bank.employer,
    r.employer,
    r.employed,
    r.dateOfJoining,
    c(r.compare.employer),
    r.bank.address,
    list(r.addresses),
    c(r.compare.city),
    r.upiIds.join(", "),
    list(r.gst),
    r.services.map(serviceLabel).join(", "),
    r.lookups,
    r.lookupsFound,
    r.cost,
    ist(r.firstLookupAt),
    ist(r.lastLookupAt),
  ];
}

export interface SheetData {
  name: string;
  columns: string[];
  rows: (string | number)[][];
}

/** Excel sheet names: ≤31 chars, none of []:*?/\ — and unique within the workbook. */
function sheetName(label: string, used: Set<string>): string {
  const base =
    label
      .replace(/[[\]:*?/\\]/g, " ")
      .trim()
      .slice(0, 28) || "Lookup";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  used.add(name.toLowerCase());
  return name;
}

const FIXED_COLUMNS = [
  "Loan Account Number",
  "Customer Name",
  "Primary Number",
  "Lookup Date (IST)",
  "Result",
  "Cost (INR)",
];

/**
 * One sheet per service, one row per lookup, and EVERY field that service returned as its own
 * column — the union across all of its lookups, in first-seen order — then the raw response.
 * A label that repeats within one response (two UANs' details under the same labels) gets
 * " (2)", " (3)" so no value overwrites another.
 */
export function buildServiceSheets(
  details: LoanLookupDetail[],
  serviceLabel: (id: string) => string,
): SheetData[] {
  const byService = new Map<string, LoanLookupDetail[]>();
  for (const d of details) {
    const list = byService.get(d.serviceId);
    if (list) list.push(d);
    else byService.set(d.serviceId, [d]);
  }
  const used = new Set(["by loan id"]);
  const sheets: SheetData[] = [];
  for (const [serviceId, list] of byService) {
    const columns: string[] = [];
    const seen = new Set<string>();
    const perLookup = list.map((d) => {
      const counts = new Map<string, number>();
      const values = new Map<string, string>();
      for (const f of d.fields) {
        const n = (counts.get(f.label) ?? 0) + 1;
        counts.set(f.label, n);
        const label = n === 1 ? f.label : `${f.label} (${n})`;
        values.set(label, f.value);
        if (!seen.has(label)) {
          seen.add(label);
          columns.push(label);
        }
      }
      return values;
    });
    sheets.push({
      name: sheetName(serviceLabel(serviceId), used),
      columns: [...FIXED_COLUMNS, ...columns, "Raw Response (JSON)"],
      rows: list.map((d, i) => [
        d.loanReference,
        d.name,
        d.phonePrimary,
        ist(d.createdAt),
        d.result,
        d.cost,
        ...columns.map((c) => clip(perLookup[i].get(c) ?? "")),
        clip(d.raw),
      ]),
    });
  }
  return sheets.sort((a, b) => b.rows.length - a.rows.length);
}
