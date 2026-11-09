// The banker's feedback file (2026-11-09): for one portfolio and a date range, one row per loan
// with everything that happened on it. Column order follows the company's own
// "ALLOCTION POTFOLIO REPORT" sample. Pure, tested in scripts/call-audit.test.ts; also used for
// the auditor's Allocation report.
//
// Internal quality scores and auditor comments never appear here: this file leaves the company.
//
// Two columns are our reading of the sample, since it left them blank:
//   "Genration Date/Amount" = payments an agent reported on a call (outcome "paid"), as against
//   "Last paid" / "Till Date Collected", which are recorded payments.
//   "Total AVERAGE Call BACK duration" = average length of calls that ended in a Call Back.
import type { XlsxSheet } from "./xlsx-export";
import {
  DISPOSITION_RANK,
  dispositionLabel,
  fmtSeconds,
  isAnswered,
  isConnectedOutcome,
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

export interface FeedbackInput {
  portfolioName: string;
  lenderName: string | null;
  debtors: FeedbackDebtor[];
  /** Calls inside the range, any order. */
  calls: AuditCallRow[];
  /** Every completed payment on these loans, whatever the date: "Till Date Collected". */
  payments: FeedbackPayment[];
  settlements: FeedbackSettlement[];
  disputes: FeedbackDispute[];
  agentNames: Map<string, string>;
  /** "YYYY-MM-DD" IST bounds of the file. */
  from: string;
  to: string;
  /** Call id -> link. Filled only when the manager asked for recording links. */
  recordingLinks?: Map<string, string>;
  includeNoActivity: boolean;
}

/** Excel refuses a cell longer than this. */
export const MAX_CELL = 32_000;
export const clampCell = (s: string, hint = " … (continues on the All Feedback sheet)") =>
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

export const LOAN_HEADERS = [
  "Profile Name",
  "Lender",
  "Product",
  "Loan Account Number",
  "Reference ID",
  "Call Date",
  "Agent ID",
  "Agent Name",
  "Supervisor Name",
  "Customer Mobile Number",
  "Customer Name",
  "Loan Amount",
  "Outstanding",
  "DPD",
  "Account Status",
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
  "Contact Group",
  "Grouping Disposition",
];

export function buildFeedbackSheets(input: FeedbackInput, todayIst: string): XlsxSheet[] {
  const callsByDebtor = groupBy(input.calls, (c) => c.debtor_id ?? "");
  const paymentsByDebtor = groupBy(
    input.payments.filter((p) => (p.status ?? "completed") === "completed"),
    (p) => p.debtor_id,
  );
  const loanRows: (string | number)[][] = [];

  for (const d of input.debtors) {
    const calls = (callsByDebtor.get(d.id) ?? []).sort(byTime);
    if (!calls.length && !input.includeNoActivity) continue;
    const connected = calls.filter(isAnswered);
    const contacted = calls.some((c) => isConnectedOutcome(c.outcome));
    const best = bestCall(calls);
    const last = calls[calls.length - 1];
    const owner = last ?? connected[0];
    const payments = (paymentsByDebtor.get(d.id) ?? []).sort((a, b) =>
      (a.received_at ?? a.created_at) < (b.received_at ?? b.created_at) ? -1 : 1,
    );
    const lastPayment = payments[payments.length - 1];
    const generated = [...calls].reverse().find((c) => c.outcome === "paid");
    const ptp = [...calls].reverse().find((c) => c.outcome === "promised");
    const callback = [...calls].reverse().find((c) => c.outcome === "callback");
    const missed = missedFollowUps(calls, todayIst);
    const links = calls
      .map((c) => input.recordingLinks?.get(c.call_id))
      .filter((l): l is string => !!l);
    const rings = calls.map((c) => c.ring_seconds).filter((s): s is number => s != null);
    const callbackLengths = calls
      .filter((c) => c.outcome === "callback")
      .map((c) => c.duration_seconds ?? 0);
    const callbackAvg = avg(callbackLengths);
    const ringAvg = avg(rings);

    loanRows.push([
      input.portfolioName,
      d.lender ?? input.lenderName ?? "",
      d.product_type ?? "",
      d.loan_reference ?? "",
      "",
      last ? dmy(istDay(last.created_at)) : "",
      owner?.agent_code ?? "",
      owner?.agent_name ??
        (d.assigned_agent_id ? (input.agentNames.get(d.assigned_agent_id) ?? "") : ""),
      owner?.manager_name ?? "",
      d.phone_primary ?? "",
      d.name,
      money(d.loan_amount),
      money(d.outstanding_balance),
      d.dpd ?? "",
      d.status ?? "",
      calls.length,
      connected.length,
      clampCell(links.join(" , "), " …"),
      owner?.team_name ?? "",
      connected.length ? dialModeLabel(connected[0].dial_mode) : "",
      missed.callback,
      missed.ptp,
      bestTimeToCall(calls),
      calls.length ? fmtSeconds(sum(calls.map((c) => c.duration_seconds ?? 0))) : "",
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
      contacted ? "Contact" : "No Contact",
      feedbackTrail(calls),
    ]);
  }

  return [
    { name: "Feedback by Loan", headers: LOAN_HEADERS, rows: loanRows },
    allFeedbackSheet(input),
    summarySheet(input),
  ];
}

function allFeedbackSheet(input: FeedbackInput): XlsxSheet {
  const debtorById = new Map(input.debtors.map((d) => [d.id, d]));
  const inRange = (iso: string) => {
    const day = istDay(iso);
    return day >= input.from && day <= input.to;
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
  for (const c of input.calls) {
    if (!c.debtor_id) continue;
    lines.push({
      at: c.created_at,
      cells: [
        ...base(c.debtor_id, c.created_at),
        "Call",
        c.agent_name,
        c.customer_phone ?? "",
        dialModeLabel(c.dial_mode),
        fmtSeconds(c.duration_seconds),
        isAnswered(c) ? "Answered" : "Not Answered",
        dispositionLabel(c.outcome),
        c.outcome_reason ?? "",
        c.raw_notes ?? "",
        c.outcome === "promised" ? money(c.promise_amount) : "",
        c.promise_date ? dmy(c.promise_date) : "",
        c.callback_date ? dmy(c.callback_date) : "",
        c.callback_time ?? "",
        c.outcome === "paid" ? money(c.promise_amount) : "",
        input.recordingLinks?.get(c.call_id) ?? "",
      ],
    });
  }
  const other = (
    debtorId: string,
    at: string,
    type: string,
    who: string,
    disposition: string,
    sub: string,
    remarks: string,
    amount: number | string,
  ) =>
    lines.push({
      at,
      cells: [
        ...base(debtorId, at),
        type,
        who,
        "",
        "",
        "",
        "",
        disposition,
        sub,
        remarks,
        "",
        "",
        "",
        "",
        amount,
        "",
      ],
    });
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
  lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return {
    name: "All Feedback",
    headers: [
      "Loan Account Number",
      "Customer Name",
      "Customer Mobile Number",
      "Date",
      "Time (IST)",
      "Feedback Type",
      "By",
      "Number Called",
      "Dial Type",
      "Call Duration",
      "Call Status",
      "Disposition",
      "Sub-Disposition",
      "Feedback / Remarks",
      "PTP Amount",
      "PTP Date",
      "Callback Date",
      "Callback Time",
      "Amount",
      "Call Record Link",
    ],
    rows: lines.map((l) => l.cells),
  };
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
    ["Period", `${dmy(input.from)} to ${dmy(input.to)}`],
    ["Total loans in portfolio", input.debtors.length],
    ["Loans called in period", called.size],
    ["Loans connected in period", connected.size],
    ["Total call attempts", input.calls.length],
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
