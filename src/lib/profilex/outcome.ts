// "Was the lookup worth it" — the pure half of the Insights outcome report
// (migrations/20260927_insights_outcome_report.sql). The RPC supplies each lookup with what
// happened on the account afterwards; this decides what the lookup found and how it turned out,
// and lays the rows out for export. No Supabase, no React, so it is unit-tested directly
// (scripts/profilex-outcome.test.ts).
//
// Attribution is by time on the same account, never causation: a payment after a lookup is
// credited to it because it came after, not because the lookup provably caused it. The report
// says so on screen; don't word it as proof anywhere else either.

import { extractPhones, normalisePhone } from "./billing";

type Json = Record<string, unknown>;

/** One row of insights_outcome_report, as the RPC returns it. */
export interface OutcomeRpcRow {
  trace_id: string;
  created_at: string;
  service_id: string;
  state: string;
  provider_status: string | null;
  billable: boolean;
  cost: number | string;
  response: unknown;
  requested_by_name: string;
  requested_by_role: string;
  debtor_id: string;
  debtor_name: string;
  loan_reference: string;
  phone_primary: string;
  loan_amount: number | string | null;
  dpd: number | null;
  portfolio_id: string | null;
  portfolio_name: string;
  lender_name: string;
  product_type: string;
  manager_id: string | null;
  manager_name: string;
  agent_name: string;
  calls_before: number;
  contacted_before: boolean;
  calls_after: number;
  contacts_after: number;
  first_call_after_at: string | null;
  first_contact_after_at: string | null;
  best_outcome_after: string | null;
  best_notes_after: string | null;
  last_outcome_after: string | null;
  last_outcome_at: string | null;
  last_notes_after: string | null;
  ptp_amount: number | string | null;
  ptp_date: string | null;
  dialed_after: string[] | null;
  dialed_contacted_after: string[] | null;
  paid_amount_after: number | string | null;
  last_paid_at: string | null;
  /** Of paid_amount_after, what arrived through the bank's paid file (source 'bank_reported'). */
  paid_file_amount_after: number | string | null;
  /** Any completed payment on the account before the lookup. */
  paid_before: boolean;
  debtor_status: string;
}

export type LookupResult = "found" | "not_found" | "failed" | "pending";

export type Turnout =
  | "recovered"
  | "ptp"
  | "contacted"
  | "worked_no_contact"
  | "not_worked"
  | "no_data"
  | "failed"
  | "pending";

export const TURNOUT_META: Record<Turnout, { label: string; order: number }> = {
  recovered: { label: "Recovered", order: 1 },
  ptp: { label: "PTP / settlement", order: 2 },
  contacted: { label: "Contacted", order: 3 },
  worked_no_contact: { label: "Called, no contact", order: 4 },
  not_worked: { label: "Not called yet", order: 5 },
  no_data: { label: "No data found", order: 6 },
  failed: { label: "Failed (not billed)", order: 7 },
  pending: { label: "In progress", order: 8 },
};

export const OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  settlement: "Settlement",
  promised: "PTP",
  callback: "Call Back",
  dispute: "Dispute",
  refused: "RTP",
  escalated: "Escalated",
  wrong_number: "Wrong Number",
  voicemail: "Voicemail",
  no_answer: "Not Contacted",
  deceased: "Deceased",
};

/** What the lookup itself returned. ProfileX's `data.status` "1" is found and "2"/"3"/"201" are
 *  not, but some endpoints answer with only the envelope's "OK" — for those the message
 *  ("No record(s) found") or the nested `status_code` is the only signal. */
export function lookupResult(
  state: string,
  providerStatus: string | null,
  response: unknown,
): LookupResult {
  if (state === "failed") return "failed";
  if (state !== "done") return "pending";
  if (providerStatus === "1") return "found";
  if (providerStatus === "2" || providerStatus === "3" || providerStatus === "201") {
    return "not_found";
  }
  const r = (response ?? {}) as Json;
  const msg = String(r.message ?? "");
  if (/no record|not found/i.test(msg)) return "not_found";
  const d = (r.data ?? {}) as Json;
  if (String(d.status ?? "") === "1" || String(d.status_code ?? "") === "1") return "found";
  return /fetched successfully/i.test(msg) ? "found" : "not_found";
}

const firstString = (...vals: unknown[]): string | null => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].trim()) return v[0].trim();
  }
  return null;
};

/** The facts a lookup surfaced, in a line a manager can read in a table cell. Deliberately
 *  shallow — the full payload is on the debtor's Insights tab; this is for scanning a report. */
export function summariseData(response: unknown, newNumbers: string[]): string {
  const d = ((response as Json | null)?.data ?? {}) as Json;
  const parts: string[] = [];
  if (newNumbers.length) {
    parts.push(`${newNumbers.length} number${newNumbers.length === 1 ? "" : "s"}`);
  }
  const summary = (d.summary ?? {}) as Json;
  const recent = (summary.recent_employer_data ?? {}) as Json;
  const employer = firstString(recent.establishment_name);
  if (employer) parts.push(`Employer: ${employer}`);
  const uan = firstString(d.uan);
  if (uan) parts.push(`UAN ${uan}`);
  const upi = Array.isArray(d.upi_id) ? d.upi_id.length : 0;
  if (upi) parts.push(`${upi} UPI ID${upi === 1 ? "" : "s"}`);
  const addresses = Array.isArray(d.address)
    ? d.address.length
    : Array.isArray(d.alternate_addresses)
      ? d.alternate_addresses.length
      : 0;
  if (addresses) parts.push(`${addresses} address${addresses === 1 ? "" : "es"}`);
  const age = firstString(d.age);
  if (age) parts.push(`Age ${age}`);
  return parts.join(" · ");
}

export interface OutcomeRow {
  traceId: string;
  createdAt: string;
  serviceId: string;
  result: LookupResult;
  billable: boolean;
  cost: number;
  requestedBy: string;
  requestedByRole: string;
  debtorId: string;
  debtorName: string;
  loanReference: string;
  phonePrimary: string;
  loanAmount: number;
  dpd: number | null;
  portfolioId: string | null;
  portfolioName: string;
  lenderName: string;
  productType: string;
  managerId: string | null;
  managerName: string;
  agentName: string;
  dataFound: string;
  /** Mobiles the lookup returned that are not the account's primary number. */
  newNumbers: string[];
  newNumberCalled: boolean;
  newNumberConnected: boolean;
  callsBefore: number;
  contactedBefore: boolean;
  callsAfter: number;
  contactsAfter: number;
  firstCallAfterAt: string | null;
  firstContactAfterAt: string | null;
  bestOutcome: string | null;
  bestNotes: string;
  lastOutcome: string | null;
  lastOutcomeAt: string | null;
  lastNotes: string;
  ptpAmount: number | null;
  ptpDate: string | null;
  paidAfter: number;
  /** The part of paidAfter reported by the bank's paid file. */
  paidFileAfter: number;
  /** The account is marked paid (a paid-file row can carry no amount) with no payment recorded
   *  either side of the lookup — credited as paid via the bank file, amount unknown. */
  markedPaidByFile: boolean;
  lastPaidAt: string | null;
  turnout: Turnout;
}

export function classifyTurnout(r: {
  result: LookupResult;
  paidAfter: number;
  markedPaidByFile?: boolean;
  bestOutcome: string | null;
  contactsAfter: number;
  callsAfter: number;
}): Turnout {
  if (r.result === "failed") return "failed";
  if (r.result === "pending") return "pending";
  if (r.result === "not_found") return "no_data";
  if (r.paidAfter > 0 || r.markedPaidByFile || r.bestOutcome === "paid") return "recovered";
  if (r.bestOutcome === "promised" || r.bestOutcome === "settlement") return "ptp";
  if (r.contactsAfter > 0) return "contacted";
  if (r.callsAfter > 0) return "worked_no_contact";
  return "not_worked";
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** RPC row → report row. Drops the raw response: it can be kilobytes per lookup and nothing
 *  past this point needs more than the summary. */
export function toOutcomeRow(r: OutcomeRpcRow): OutcomeRow {
  const result = lookupResult(r.state, r.provider_status, r.response);
  const primary = normalisePhone(r.phone_primary);
  const newNumbers =
    result === "found" ? [...extractPhones(r.response)].filter((p) => p !== primary) : [];
  const dialed = new Set((r.dialed_after ?? []).map(normalisePhone));
  const connected = new Set((r.dialed_contacted_after ?? []).map(normalisePhone));
  const paidAfter = num(r.paid_amount_after);
  const row: Omit<OutcomeRow, "turnout"> = {
    traceId: r.trace_id,
    createdAt: r.created_at,
    serviceId: r.service_id,
    result,
    billable: !!r.billable,
    cost: num(r.cost),
    requestedBy: r.requested_by_name,
    requestedByRole: r.requested_by_role,
    debtorId: r.debtor_id,
    debtorName: r.debtor_name,
    loanReference: r.loan_reference,
    phonePrimary: r.phone_primary,
    loanAmount: num(r.loan_amount),
    dpd: r.dpd,
    portfolioId: r.portfolio_id,
    portfolioName: r.portfolio_name,
    lenderName: r.lender_name,
    productType: r.product_type,
    managerId: r.manager_id,
    managerName: r.manager_name,
    agentName: r.agent_name,
    dataFound: result === "found" ? summariseData(r.response, newNumbers) : "",
    newNumbers,
    newNumberCalled: newNumbers.some((p) => dialed.has(p)),
    newNumberConnected: newNumbers.some((p) => connected.has(p)),
    callsBefore: num(r.calls_before),
    contactedBefore: !!r.contacted_before,
    callsAfter: num(r.calls_after),
    contactsAfter: num(r.contacts_after),
    firstCallAfterAt: r.first_call_after_at,
    firstContactAfterAt: r.first_contact_after_at,
    bestOutcome: r.best_outcome_after,
    bestNotes: r.best_notes_after ?? "",
    lastOutcome: r.last_outcome_after,
    lastOutcomeAt: r.last_outcome_at,
    lastNotes: r.last_notes_after ?? "",
    ptpAmount: r.ptp_amount == null ? null : num(r.ptp_amount),
    ptpDate: r.ptp_date,
    paidAfter,
    lastPaidAt: r.last_paid_at,
    paidFileAfter: num(r.paid_file_amount_after),
    markedPaidByFile: r.debtor_status === "paid" && paidAfter === 0 && !r.paid_before,
  };
  return { ...row, turnout: classifyTurnout(row) };
}

export interface OutcomeTotals {
  lookups: number;
  found: number;
  spend: number;
  worked: number;
  contacted: number;
  /** Contacted after the lookup when there had been no contact before it. */
  newContacts: number;
  ptp: number;
  ptpAmount: number;
  recovered: number;
  recoveredAmount: number;
  newNumbers: number;
  newNumberConnected: number;
  /** Recovered accounts whose payment came through the bank's paid file. */
  recoveredViaFile: number;
}

export function totals(rows: OutcomeRow[]): OutcomeTotals {
  const t: OutcomeTotals = {
    lookups: 0,
    found: 0,
    spend: 0,
    worked: 0,
    contacted: 0,
    newContacts: 0,
    ptp: 0,
    ptpAmount: 0,
    recovered: 0,
    recoveredAmount: 0,
    newNumbers: 0,
    newNumberConnected: 0,
    recoveredViaFile: 0,
  };
  for (const r of rows) {
    t.lookups += 1;
    if (r.result === "found") t.found += 1;
    if (r.billable) t.spend += r.cost;
    if (r.callsAfter > 0) t.worked += 1;
    if (r.contactsAfter > 0) t.contacted += 1;
    if (r.contactsAfter > 0 && !r.contactedBefore) t.newContacts += 1;
    if (r.turnout === "ptp") {
      t.ptp += 1;
      t.ptpAmount += r.ptpAmount ?? 0;
    }
    if (r.turnout === "recovered") {
      t.recovered += 1;
      t.recoveredAmount += r.paidAfter;
    }
    if (r.newNumbers.length) t.newNumbers += 1;
    if (r.newNumberConnected) t.newNumberConnected += 1;
    if (r.turnout === "recovered" && (r.paidFileAfter > 0 || r.markedPaidByFile)) {
      t.recoveredViaFile += 1;
    }
  }
  return t;
}

/** Rows grouped by a key, each group with its totals — the per-service / manager / portfolio
 *  breakdowns. The same account looked up twice counts its later payment against both lookups;
 *  that is inherent in per-lookup attribution and the UI notes it. */
export function groupTotals(
  rows: OutcomeRow[],
  keyOf: (r: OutcomeRow) => string,
): { key: string; totals: OutcomeTotals }[] {
  const groups = new Map<string, OutcomeRow[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({ key, totals: totals(g) }))
    .sort((a, b) => b.totals.spend - a.totals.spend || b.totals.lookups - a.totals.lookups);
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
/** "2026-09-22 18:37:35" in IST — the timestamp format of the collections export this layout
 *  follows. */
export function istStamp(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}

/** Column layout for the export, modelled on the collections-platform call-log export the
 *  business already works from (Allocator / Allocation File / Supervisor / Best & Last
 *  Disposition / Grouping), with the lookup's own columns added. */
export const OUTCOME_EXPORT_HEADERS = [
  "Allocator Name",
  "Allocation File Name",
  "Product",
  "Loan Account Number",
  "Customer Name",
  "Customer Number",
  "Loan Amount",
  "DPD",
  "Supervisor Name",
  "Agent Name",
  "Lookup Date",
  "Requested By",
  "Insights Service",
  "Lookup Result",
  "Data Found",
  "New Numbers Found",
  "Billed",
  "Cost (INR)",
  "Calls Before Lookup",
  "Contact Before Lookup",
  "Calls After Lookup",
  "Contacts After Lookup",
  "First Call After",
  "First Contact After",
  "New Number Called",
  "New Number Connected",
  "Best Disposition Name",
  "Best Disposition Remarks",
  "Last Disposition Name",
  "Last Disposition Date",
  "Last Disposition Remarks",
  "PTP Date",
  "PTP Amount",
  "Paid Date",
  "Paid Amount",
  "Grouping Disposition",
  "Lookup Turnout",
  "Paid Via",
] as const;

const RESULT_LABEL: Record<LookupResult, string> = {
  found: "Found",
  not_found: "Not found",
  failed: "Failed",
  pending: "Pending",
};

export function outcomeExportRow(
  r: OutcomeRow,
  serviceLabel: (id: string) => string,
): (string | number)[] {
  const yn = (b: boolean) => (b ? "Yes" : "No");
  return [
    r.lenderName,
    r.portfolioName,
    r.productType,
    r.loanReference,
    r.debtorName,
    r.phonePrimary,
    r.loanAmount,
    r.dpd ?? "",
    r.managerName,
    r.agentName,
    istStamp(r.createdAt),
    r.requestedBy,
    serviceLabel(r.serviceId),
    RESULT_LABEL[r.result],
    r.dataFound,
    r.newNumbers.join(" "),
    r.billable ? "Yes" : "No (reused)",
    r.billable ? r.cost : 0,
    r.callsBefore,
    yn(r.contactedBefore),
    r.callsAfter,
    r.contactsAfter,
    istStamp(r.firstCallAfterAt),
    istStamp(r.firstContactAfterAt),
    r.newNumbers.length ? yn(r.newNumberCalled) : "",
    r.newNumbers.length ? yn(r.newNumberConnected) : "",
    r.bestOutcome ? (OUTCOME_LABEL[r.bestOutcome] ?? r.bestOutcome) : "",
    r.bestNotes,
    r.lastOutcome ? (OUTCOME_LABEL[r.lastOutcome] ?? r.lastOutcome) : "",
    istStamp(r.lastOutcomeAt),
    r.lastNotes,
    r.ptpDate ?? "",
    r.ptpAmount ?? "",
    istStamp(r.lastPaidAt).slice(0, 10),
    r.paidAfter || "",
    r.callsAfter === 0 ? "" : r.contactsAfter > 0 ? "Contact" : "No Contact",
    TURNOUT_META[r.turnout].label,
    r.paidFileAfter > 0 || r.markedPaidByFile
      ? r.paidFileAfter < r.paidAfter
        ? "Bank paid file + agent"
        : "Bank paid file"
      : r.paidAfter > 0
        ? "Agent"
        : "",
  ];
}
