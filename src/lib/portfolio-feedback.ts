// The banker's feedback file (2026-11-09): for one portfolio and a date range, one row per loan
// with everything that happened on it. Column order follows the company's own
// "ALLOCTION POTFOLIO REPORT" sample. Pure, tested in scripts/call-audit.test.ts; also used for
// the auditor's Allocation report.
//
// Internal quality scores and auditor comments never appear here: this file leaves the company.
//
// "Generation Date" is the day the loan's first PTP was marked (user, 2026-11-10). A PTP date moves
// every time a promise is renewed; the generation date never does, whatever period the file covers.
//
// One column is our reading of the sample, since it left it blank:
//   "Total AVERAGE Call BACK duration" = average length of calls that ended in a Call Back.
import type { XlsxSheet } from "./xlsx-export";
import {
  DISPOSITION_RANK,
  dispositionLabel,
  fmtSeconds,
  isAnswered,
  isConnectedOutcome,
  disconnectedBy,
  type AuditCallRow,
} from "./call-audit";
import { DIAL_MODE_META } from "./call-queue/types";
import type { DialMode } from "./call-queue/types";

export interface FeedbackDebtor {
  id: string;
  name: string;
  phone_primary: string | null;
  loan_reference: string | null;
  loan_amount: number | null;
  outstanding_balance: number | null;
  dpd: number | null;
  lender: string | null;
  product_type: string | null;
  status: string | null;
  assigned_agent_id: string | null;
  phone_alternate?: string | null;
  alt_phones?: string[] | null;
}

/** How a call reached this loan, when it isn't simply a call on this portfolio's row. */
export type FeedbackCall = AuditCallRow & { link?: "earlier_allocation" | "number" };

export interface FeedbackMessage {
  debtor_id: string;
  channel: string | null;
  direction: string | null;
  content: string | null;
  status: string | null;
  sent_at: string | null;
}

export interface FeedbackRetention {
  debtor_id: string;
  reason: string | null;
  status: string | null;
  created_at: string;
}

export interface FeedbackReminder {
  debtor_id: string;
  kind: string | null;
  amount: number | null;
  due_date: string | null;
  due_time: string | null;
  message: string | null;
  created_at: string;
}

/* ─── one loan, wherever its history is ───────────────────────────────────────
 *
 * The same loan comes back in later uploads as a new debtor row, and call history stays on the row
 * it was made against. Lender names can't join them (they're typed by hand: real values include
 * a manager's name), so two rows are the same loan only with the same loan ID AND the same borrower.
 */

export const loanKey = (ref: string | null | undefined) => ref?.trim().toLowerCase() || null;

/** Last 10 digits, or null when there aren't 10. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : null;
}

const nameKey = (name: string | null | undefined) =>
  (name ?? "").toLowerCase().replace(/[^a-z]/g, "");

type BorrowerRow = Pick<
  FeedbackDebtor,
  "id" | "name" | "phone_primary" | "loan_reference" | "phone_alternate" | "alt_phones"
>;

export function phoneKeysOf(d: BorrowerRow): string[] {
  return [d.phone_primary, d.phone_alternate, ...(d.alt_phones ?? [])]
    .map(phoneKey)
    .filter((k): k is string => !!k);
}

export function sameBorrower(a: BorrowerRow, b: BorrowerRow): boolean {
  const keys = new Set(phoneKeysOf(a));
  if (phoneKeysOf(b).some((k) => keys.has(k))) return true;
  const name = nameKey(a.name);
  return name.length > 0 && name === nameKey(b.name);
}

/** One row per loan: a loan listed twice in a file folds into its first row. */
export function mergeLoanRows<T extends BorrowerRow>(debtors: T[]) {
  const loans: T[] = [];
  const firstByKey = new Map<string, T>();
  const canonicalOf = new Map<string, string>();
  for (const d of debtors) {
    const key = loanKey(d.loan_reference);
    const first = key ? firstByKey.get(key) : undefined;
    if (first) {
      canonicalOf.set(d.id, first.id);
      continue;
    }
    if (key) firstByKey.set(key, d);
    loans.push(d);
    canonicalOf.set(d.id, d.id);
  }
  return { loans, canonicalOf };
}

/** Rows from other uploads that are really these loans: other row id -> this portfolio's row. */
export function linkEarlierRows(loans: BorrowerRow[], others: BorrowerRow[]): Map<string, string> {
  const byKey = new Map<string, BorrowerRow>();
  for (const l of loans) {
    const key = loanKey(l.loan_reference);
    if (key) byKey.set(key, l);
  }
  const links = new Map<string, string>();
  for (const o of others) {
    const key = loanKey(o.loan_reference);
    const loan = key ? byKey.get(key) : undefined;
    if (loan && sameBorrower(loan, o)) links.set(o.id, loan.id);
  }
  return links;
}

/** Manual calls with no account attached, placed on a loan by the number dialled. Only when that
 *  number belongs to exactly one loan anywhere in the company: otherwise the call could be about
 *  a different loan, possibly another bank's, and this file goes to the bank. */
export function matchManualCalls(
  calls: AuditCallRow[],
  loans: BorrowerRow[],
  loansByNumber: Map<string, Set<string>>,
): FeedbackCall[] {
  const loanByPhone = new Map<string, BorrowerRow>();
  for (const l of loans) for (const k of phoneKeysOf(l)) loanByPhone.set(k, l);
  const out: FeedbackCall[] = [];
  for (const c of calls) {
    const key = phoneKey(c.customer_phone);
    const loan = key ? loanByPhone.get(key) : undefined;
    if (!key || !loan) continue;
    const owners = loansByNumber.get(key);
    if (!owners || owners.size !== 1 || !owners.has(loanKey(loan.loan_reference) ?? "")) continue;
    out.push({ ...c, debtor_id: loan.id, link: "number" });
  }
  return out;
}

export interface FeedbackPayment {
  debtor_id: string;
  amount: number;
  status: string | null;
  source: string | null;
  payment_method: string | null;
  notes: string | null;
  received_at: string | null;
  created_at: string;
}

export interface FeedbackSettlement {
  debtor_id: string;
  original_amount: number | null;
  proposed_amount: number | null;
  status: string | null;
  agent_notes: string | null;
  created_at: string;
}

export interface FeedbackDispute {
  debtor_id: string;
  dispute_type: string | null;
  debtor_reason: string | null;
  agent_notes: string | null;
  status: string | null;
  created_at: string;
}

/** A call on which a PTP was marked. */
export interface PtpMark {
  debtor_id: string | null;
  loan_reference?: string | null;
  created_at: string;
  promise_amount: number | null;
}

/** The earliest PTP per key: the one a loan's Generation Date and Amount come from. */
export function firstPtpBy<T extends PtpMark>(
  marks: T[],
  keyOf: (m: T) => string | null,
): Map<string, T> {
  const first = new Map<string, T>();
  for (const m of marks) {
    const key = keyOf(m);
    if (!key) continue;
    const seen = first.get(key);
    if (!seen || m.created_at < seen.created_at) first.set(key, m);
  }
  return first;
}

export interface FeedbackInput {
  portfolioName: string;
  lenderName: string | null;
  debtors: FeedbackDebtor[];
  /** Calls inside the range, any order, with debtor_id already pointing at the row in `debtors`. */
  calls: FeedbackCall[];
  /** PTPs marked before the file's period, so a short period keeps the true Generation Date. */
  earlierPtps?: PtpMark[];
  /** Every completed payment on these loans, whatever the date: "Till Date Collected". */
  payments: FeedbackPayment[];
  settlements: FeedbackSettlement[];
  disputes: FeedbackDispute[];
  messages?: FeedbackMessage[];
  retentions?: FeedbackRetention[];
  reminders?: FeedbackReminder[];
  agentNames: Map<string, string>;
  /** "YYYY-MM-DD" IST bounds of the file. Blank = no limit on that side; both blank = everything. */
  from: string;
  to: string;
  /** Call id -> link. Filled only when the manager asked for recording links. */
  recordingLinks?: Map<string, string>;
  includeNoActivity: boolean;
}

/** Excel refuses a cell longer than this. */
export const MAX_CELL = 32_000;
export const clampCell = (s: string, hint = " … (continues on the CC Report sheet)") =>
  s.length > MAX_CELL ? s.slice(0, MAX_CELL - hint.length) + hint : s;

const IST_MS = 330 * 60_000;
const ist = (iso: string) => new Date(new Date(iso).getTime() + IST_MS).toISOString();
/** "YYYY-MM-DD" in IST. */
export const istDay = (iso: string) => ist(iso).slice(0, 10);
/** DD/MM/YYYY, the way the sample files write dates. */
export const dmy = (day: string | null | undefined) =>
  day ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : "";
export const istDateTime = (iso: string | null | undefined) =>
  iso ? `${dmy(istDay(iso))} ${ist(iso).slice(11, 19)}` : "";
const istHour = (iso: string) => Number(ist(iso).slice(11, 13));

/** "Fri Oct 30 2026", the way the sample's Call Date reads. */
export const longDate = (day: string) => {
  const parts = new Date(`${day}T00:00:00Z`).toUTCString().split(" ");
  return `${parts[0].replace(",", "")} ${parts[2]} ${parts[1]} ${parts[3]}`;
};

export const dialModeLabel = (m: string | null | undefined) =>
  m ? (DIAL_MODE_META[m as DialMode]?.short ?? m) : "";

const money = (v: number | null | undefined) => (v === null || v === undefined ? "" : Number(v));
const byTime = <T extends { created_at: string }>(a: T, b: T) =>
  a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;

/** Best result in the period. On a tie the later call wins. */
export function bestCall(calls: AuditCallRow[]): AuditCallRow | undefined {
  let best: AuditCallRow | undefined;
  for (const c of [...calls].sort(byTime)) {
    if (!best || (DISPOSITION_RANK[c.outcome] ?? 0) >= (DISPOSITION_RANK[best.outcome] ?? 0)) {
      best = c;
    }
  }
  return best;
}

/** The dated trail, newest day first: "11/09/2026. PTP - notes // 10/09/2026. Call Back - notes". */
export function feedbackTrail(calls: AuditCallRow[]): string {
  const days = new Map<string, string[]>();
  for (const c of [...calls].sort(byTime).reverse()) {
    const day = istDay(c.created_at);
    const list = days.get(day) ?? [];
    list.push(callFeedbackText(c));
    days.set(day, list);
  }
  return clampCell(
    [...days.entries()].map(([day, items]) => `${dmy(day)}. ${items.join(" | ")}`).join(" // "),
  );
}

export function callFeedbackText(c: AuditCallRow): string {
  return [dispositionLabel(c.outcome), c.outcome_reason, c.raw_notes?.trim()]
    .filter(Boolean)
    .join(" - ");
}

/** The hour band with the most answered calls, e.g. "11:00-12:00". */
export function bestTimeToCall(calls: AuditCallRow[]): string {
  const hours = new Map<number, number>();
  for (const c of calls) {
    if (!isAnswered(c)) continue;
    const h = istHour(c.created_at);
    hours.set(h, (hours.get(h) ?? 0) + 1);
  }
  if (!hours.size) return "";
  const [h] = [...hours.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return `${String(h).padStart(2, "0")}:00-${String(h + 1).padStart(2, "0")}:00`;
}

/** Commitments that fell due with no call to the customer on or after the due date. */
export function missedFollowUps(calls: AuditCallRow[], todayIst: string) {
  const sorted = [...calls].sort(byTime);
  const days = sorted.map((c) => istDay(c.created_at));
  const missed = (due: string | null, i: number) => {
    if (!due || due > todayIst) return false;
    return !days.some((d, j) => j > i && d >= due);
  };
  let callback = 0;
  let ptp = 0;
  sorted.forEach((c, i) => {
    if (c.outcome === "callback" && missed(c.callback_date, i)) callback++;
    if (c.outcome === "promised" && missed(c.promise_date, i)) ptp++;
  });
  return { callback, ptp };
}

const avg = (nums: number[]) =>
  nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;

/** The first 36 are the company's own "ALLOCTION POTFOLIO REPORT", in its order (spelling
 *  corrected). A test pins this. Extra columns go after them, never between. */
export const LOAN_HEADERS = [
  "Profile Name",
  "Loan Account Number",
  "Reference ID",
  "Call Date",
  "Agent ID",
  "Agent Name",
  "Supervisor Name",
  "Customer Mobile Number",
  "Customer Name",
  "Intensity of Calls",
  "Connect Count",
  "Call Record Link",
  "Team",
  "Campaign Type (First Connected By)",
  "Callback Miss to Call Count",
  "PTP Miss to Call Count",
  "Best Time to Call",
  "Total Call Duration",
  "Total Ringing Call Duration",
  "Total Average Call Back Duration",
  "Total Average Ringing Call Duration",
  "Best Disposition Name",
  "Best Disposition Remarks",
  "Last Disposition Name",
  "Last Disposition Remarks",
  "Last Paid Date in Allocation",
  "Last Paid Amount in Allocation",
  "Generation Date",
  "Generation Amount",
  "PTP Date",
  "PTP Amount",
  "Callback Date",
  "Till Date Collected",
  "Code",
  "Best Sub Code",
  "Grouping Disposition",
  "Lender",
  "Product",
  "Loan Amount",
  "Outstanding",
  "DPD",
  "Account Status",
  "Contact Group",
  "DID Used",
];

export function buildFeedbackSheets(input: FeedbackInput, todayIst: string): XlsxSheet[] {
  const callsByDebtor = groupBy(input.calls, (c) => c.debtor_id ?? "");
  const paymentsByDebtor = groupBy(
    input.payments.filter((p) => (p.status ?? "completed") === "completed"),
    (p) => p.debtor_id,
  );
  const firstPtps = firstPtpOfLoans(input);
  const loanRows: (string | number)[][] = [];
  const included: FeedbackDebtor[] = [];

  for (const d of input.debtors) {
    const calls = (callsByDebtor.get(d.id) ?? []).sort(byTime);
    if (!calls.length && !input.includeNoActivity) continue;
    // An update made without dialling is feedback, but not a call attempt.
    const attempts = calls.filter((c) => c.dial_mode !== "no_call");
    const connected = attempts.filter(isAnswered);
    const contacted = calls.some((c) => isConnectedOutcome(c.outcome));
    const best = bestCall(calls);
    const last = calls[calls.length - 1];
    const owner = last ?? connected[0];
    const payments = (paymentsByDebtor.get(d.id) ?? []).sort((a, b) =>
      (a.received_at ?? a.created_at) < (b.received_at ?? b.created_at) ? -1 : 1,
    );
    const lastPayment = payments[payments.length - 1];
    const generated = firstPtps.get(d.id);
    const ptp = [...calls].reverse().find((c) => c.outcome === "promised");
    const callback = [...calls].reverse().find((c) => c.outcome === "callback");
    const missed = missedFollowUps(attempts, todayIst);
    const links = calls
      .map((c) => input.recordingLinks?.get(c.call_id))
      .filter((l): l is string => !!l);
    const rings = attempts.map((c) => c.ring_seconds).filter((s): s is number => s != null);
    const callbackLengths = attempts
      .filter((c) => c.outcome === "callback")
      .map((c) => c.duration_seconds ?? 0);
    const callbackAvg = avg(callbackLengths);
    const ringAvg = avg(rings);

    included.push(d);
    loanRows.push([
      input.portfolioName,
      d.loan_reference ?? "",
      "",
      last ? longDate(istDay(last.created_at)) : "",
      owner?.agent_code ?? "",
      owner?.agent_name ??
        (d.assigned_agent_id ? (input.agentNames.get(d.assigned_agent_id) ?? "") : ""),
      owner?.manager_name ?? "",
      d.phone_primary ?? "",
      d.name,
      attempts.length,
      connected.length,
      clampCell(links.join(" , "), " …"),
      owner?.team_name ?? "",
      connected.length ? dialModeLabel(connected[0].dial_mode) : "",
      missed.callback,
      missed.ptp,
      bestTimeToCall(attempts),
      attempts.length ? fmtSeconds(sum(attempts.map((c) => c.duration_seconds ?? 0))) : "",
      rings.length ? fmtSeconds(sum(rings)) : "",
      callbackAvg != null ? fmtSeconds(callbackAvg) : "",
      ringAvg != null ? fmtSeconds(ringAvg) : "",
      best ? dispositionLabel(best.outcome) : "Not Called",
      best ? best.raw_notes?.trim() || best.outcome_reason || "" : "",
      last ? dispositionLabel(last.outcome) : "Not Called",
      last ? last.raw_notes?.trim() || last.outcome_reason || "" : "",
      lastPayment ? dmy(istDay(lastPayment.received_at ?? lastPayment.created_at)) : "",
      lastPayment ? Number(lastPayment.amount) : "",
      generated ? dmy(istDay(generated.created_at)) : "",
      generated ? money(generated.promise_amount) : "",
      ptp?.promise_date ? dmy(ptp.promise_date) : "",
      ptp ? money(ptp.promise_amount) : 0,
      callback?.callback_date ? dmy(callback.callback_date) : "",
      payments.length ? sum(payments.map((p) => Number(p.amount))) : "",
      connected.length ? "CONNECTED" : "NOT CONNECTED",
      best?.outcome_reason ?? "",
      feedbackTrail(calls),
      d.lender ?? input.lenderName ?? "",
      d.product_type ?? "",
      money(d.loan_amount),
      money(d.outstanding_balance),
      d.dpd ?? "",
      d.status ?? "",
      contacted ? "Contact" : "No Contact",
      attempts[attempts.length - 1]?.did_number ?? "",
    ]);
  }

  const { sheet: ccReport, entries } = ccReportSheet(input, firstPtps);
  return [
    { name: "Feedback by Loan", headers: LOAN_HEADERS, rows: loanRows },
    dateWiseSheet(included, entries),
    ccReport,
    summarySheet(input),
  ];
}

interface FeedbackEntry {
  debtorId: string;
  at: string;
  code: string;
  text: string;
}

function firstPtpOfLoans(input: FeedbackInput): Map<string, PtpMark> {
  return firstPtpBy(
    [...(input.earlierPtps ?? []), ...input.calls.filter((c) => c.outcome === "promised")],
    (m) => m.debtor_id,
  );
}

/** One row per loan and two columns per date that has any feedback (its code, then the feedback),
 *  newest date first. */
function dateWiseSheet(loans: FeedbackDebtor[], entries: FeedbackEntry[]): XlsxSheet {
  const byLoanDay = new Map<string, FeedbackEntry[]>();
  const days = new Set<string>();
  const shown = new Set(loans.map((l) => l.id));
  for (const e of [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) {
    if (!shown.has(e.debtorId)) continue;
    const day = istDay(e.at);
    days.add(day);
    const key = `${e.debtorId}|${day}`;
    const list = byLoanDay.get(key);
    if (list) list.push(e);
    else byLoanDay.set(key, [e]);
  }
  const columns = [...days].sort().reverse();
  return {
    name: "Date-wise Feedback",
    headers: [
      "Loan Account Number",
      "Customer Name",
      "Customer Mobile Number",
      ...columns.flatMap((day) => [`${dmy(day)} Code`, `${dmy(day)} Feedback`]),
    ],
    rows: loans.map((l) => [
      l.loan_reference ?? "",
      l.name,
      l.phone_primary ?? "",
      ...columns.flatMap((day) => {
        const items = byLoanDay.get(`${l.id}|${day}`) ?? [];
        return [
          clampCell(items.map((e) => e.code).join(" | ")),
          clampCell(items.map((e) => `${ist(e.at).slice(11, 16)} ${e.text}`).join(" | ")),
        ];
      }),
    ]),
  };
}

function ccReportSheet(
  input: FeedbackInput,
  firstPtps: Map<string, PtpMark>,
): { sheet: XlsxSheet; entries: FeedbackEntry[] } {
  const debtorById = new Map(input.debtors.map((d) => [d.id, d]));
  const inRange = (iso: string) => {
    const day = istDay(iso);
    return (!input.from || day >= input.from) && (!input.to || day <= input.to);
  };
  type Line = { at: string; cells: (string | number)[] };
  const base = (debtorId: string, at: string) => {
    const d = debtorById.get(debtorId);
    return [
      d?.loan_reference ?? "",
      d?.name ?? "",
      d?.phone_primary ?? "",
      dmy(istDay(at)),
      new Date(new Date(at).getTime() + IST_MS).toISOString().slice(11, 19),
    ];
  };
  const lines: Line[] = [];
  const entries: FeedbackEntry[] = [];
  for (const c of input.calls) {
    if (!c.debtor_id) continue;
    entries.push({
      debtorId: c.debtor_id,
      at: c.created_at,
      code: dispositionLabel(c.outcome),
      text: callFeedbackText(c),
    });
    const generated = c.outcome === "promised" ? firstPtps.get(c.debtor_id) : undefined;
    lines.push({
      at: c.created_at,
      cells: [
        ...base(c.debtor_id, c.created_at),
        c.dial_mode === "no_call" ? "Disposition Update" : "Call",
        disconnectedBy(c),
        c.agent_code ?? "",
        c.agent_name,
        c.customer_phone ?? "",
        c.did_number ?? "",
        dialModeLabel(c.dial_mode),
        fmtSeconds(c.duration_seconds),
        isAnswered(c) ? "Answered" : "Not Answered",
        dispositionLabel(c.outcome),
        c.outcome_reason ?? "",
        c.raw_notes ?? "",
        c.outcome === "promised" ? money(c.promise_amount) : "",
        c.promise_date ? dmy(c.promise_date) : "",
        generated ? dmy(istDay(generated.created_at)) : "",
        c.callback_date ? dmy(c.callback_date) : "",
        c.callback_time ?? "",
        c.outcome === "paid" ? money(c.promise_amount) : "",
        input.recordingLinks?.get(c.call_id) ?? "",
        c.link === "number"
          ? "Manual call, matched by number"
          : c.link === "earlier_allocation"
            ? "Earlier allocation"
            : "This allocation",
      ],
    });
  }
  const other = (
    debtorId: string,
    at: string,
    type: string,
    source: string,
    disposition: string,
    sub: string,
    remarks: string,
    amount: number | string,
  ) => {
    entries.push({
      debtorId,
      at,
      code: type,
      text: [type, disposition, sub, remarks, amount].filter((v) => v !== "").join(" - "),
    });
    lines.push({
      at,
      cells: [
        ...base(debtorId, at),
        type,
        "", // Disconnected By
        "", // Agent Number
        "", // Agent Name
        "", // Number Called
        "", // DID Used
        "", // Dial Type
        "", // Call Duration
        "", // Call Status
        disposition,
        sub,
        remarks,
        "", // PTP Amount
        "", // PTP Date
        "", // Generation Date
        "", // Callback Date
        "", // Callback Time
        amount,
        "", // Call Record Link
        source,
      ],
    });
  };
  for (const p of input.payments) {
    const at = p.received_at ?? p.created_at;
    if (!inRange(at)) continue;
    other(
      p.debtor_id,
      at,
      "Payment",
      p.source === "bank_reported" ? "Bank paid file" : "",
      p.status ?? "",
      p.payment_method ?? "",
      p.notes ?? "",
      Number(p.amount),
    );
  }
  for (const s of input.settlements) {
    if (!inRange(s.created_at)) continue;
    other(
      s.debtor_id,
      s.created_at,
      "Settlement Request",
      "",
      s.status ?? "",
      s.original_amount != null ? `Original ${s.original_amount}` : "",
      s.agent_notes ?? "",
      money(s.proposed_amount),
    );
  }
  for (const x of input.disputes) {
    if (!inRange(x.created_at)) continue;
    other(
      x.debtor_id,
      x.created_at,
      "Dispute",
      "",
      x.status ?? "",
      x.dispute_type ?? "",
      [x.debtor_reason, x.agent_notes].filter(Boolean).join(" - "),
      "",
    );
  }
  for (const m of input.messages ?? []) {
    if (!m.sent_at || !inRange(m.sent_at)) continue;
    other(
      m.debtor_id,
      m.sent_at,
      m.channel ? `Message (${m.channel})` : "Message",
      m.direction ?? "",
      m.status ?? "",
      "",
      m.content ?? "",
      "",
    );
  }
  for (const r of input.retentions ?? []) {
    if (!inRange(r.created_at)) continue;
    other(
      r.debtor_id,
      r.created_at,
      "Retention Request",
      "",
      r.status ?? "",
      "",
      r.reason ?? "",
      "",
    );
  }
  for (const r of input.reminders ?? []) {
    if (!inRange(r.created_at)) continue;
    other(
      r.debtor_id,
      r.created_at,
      r.kind === "ptp" ? "PTP Reminder" : "Callback Reminder",
      "",
      r.due_date ? `Due ${dmy(r.due_date)}${r.due_time ? ` ${r.due_time}` : ""}` : "",
      "",
      r.message ?? "",
      money(r.amount),
    );
  }
  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const sheet: XlsxSheet = {
    name: "CC Report",
    headers: [
      "Loan Account Number",
      "Customer Name",
      "Customer Mobile Number",
      "Date",
      "Time (IST)",
      "Feedback Type",
      "Disconnected By",
      "Agent Number",
      "Agent Name",
      "Number Called",
      "DID Used",
      "Dial Type",
      "Call Duration",
      "Call Status",
      "Disposition",
      "Sub-Disposition",
      "Feedback / Remarks",
      "PTP Amount",
      "PTP Date",
      "Generation Date",
      "Callback Date",
      "Callback Time",
      "Amount",
      "Call Record Link",
      "Source",
    ],
    rows: lines.map((l) => l.cells),
  };
  return { sheet, entries };
}

function summarySheet(input: FeedbackInput): XlsxSheet {
  const called = new Set(input.calls.map((c) => c.debtor_id).filter(Boolean));
  const connected = new Set(
    input.calls
      .filter((c) => isConnectedOutcome(c.outcome))
      .map((c) => c.debtor_id)
      .filter(Boolean),
  );
  const rows: (string | number)[][] = [
    ["Portfolio", input.portfolioName],
    ["Lender", input.lenderName ?? ""],
    [
      "Period",
      input.from || input.to
        ? `${input.from ? dmy(input.from) : "Start"} to ${input.to ? dmy(input.to) : "Today"}`
        : "All feedback to date",
    ],
    ["Total loans in portfolio", input.debtors.length],
    ["Loans called in period", called.size],
    ["Loans connected in period", connected.size],
    ["Total call attempts", input.calls.filter((c) => c.dial_mode !== "no_call").length],
    [
      "Calls from earlier allocations",
      input.calls.filter((c) => c.link === "earlier_allocation").length,
    ],
    ["Manual calls matched by number", input.calls.filter((c) => c.link === "number").length],
    ["", ""],
    ["Best disposition per loan", "Loans"],
  ];
  const best = new Map<string, number>();
  for (const calls of groupBy(input.calls, (c) => c.debtor_id ?? "").values()) {
    const b = bestCall(calls);
    if (!b || !b.debtor_id) continue;
    const label = dispositionLabel(b.outcome);
    best.set(label, (best.get(label) ?? 0) + 1);
  }
  for (const [label, n] of [...best.entries()].sort((a, b) => b[1] - a[1])) rows.push([label, n]);
  return { name: "Summary", headers: ["Item", "Value"], rows };
}

const sum = (nums: number[]) => nums.reduce((a, b) => a + b, 0);

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}
