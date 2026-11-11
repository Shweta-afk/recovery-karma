// The Call Auditor's Excel reports (2026-11-09). Pure: rows in, sheets out; tested in
// scripts/call-audit.test.ts. The call log follows the company's own export column for column,
// then keeps going with everything else we hold, ending with one column per bank-file field.
//
// Blank means "not recorded", never zero. Some sample columns have no source today: Cause Code,
// Drop Reason, Provider Cause and the Tea / Meeting / Mobile / Bio breaks.
import type { XlsxCell, XlsxSheet } from "./xlsx-export";
import {
  DISPOSITION_RANK,
  FATAL_ERRORS,
  SCORECARD,
  SCORE_FRACTION,
  disconnectedBy,
  dispositionLabel,
  fmtSeconds,
  isAnswered,
  isConnectedOutcome,
  type AuditCallRow,
  type TeamReviewRow,
} from "./call-audit";
import {
  bestCall,
  dialModeLabel,
  dmy,
  firstPtpBy,
  istDateTime,
  istDay,
  loanKey,
  type PtpMark,
} from "./portfolio-feedback";

export interface PresenceRow {
  agent_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
}

/** Excel's own limit on columns, less the fixed ones. */
const MAX_BANK_COLUMNS = 16_000;

const yn = (v: boolean | null | undefined) =>
  v === null || v === undefined ? "" : v ? "Yes" : "No";
const num = (v: number | string | null | undefined) =>
  v === null || v === undefined || v === "" ? "" : Number(v);
const str = (v: unknown): XlsxCell => {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return v;
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.length > 32_000 ? s.slice(0, 32_000) : s;
};
const callLink = (origin: string, c: AuditCallRow) => `${origin}/auditor/calls?call=${c.call_id}`;

const seqBy = <T>(items: T[], key: (t: T) => string) => {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
};

export function callLogSheet(
  rows: AuditCallRow[],
  origin: string,
  /** PTPs marked before the report's period, so Genration Date stays the true first day. */
  earlierPtps: PtpMark[] = [],
): XlsxSheet {
  const ptpKey = (m: PtpMark) => loanKey(m.loan_reference) ?? m.debtor_id;
  const firstPtps = firstPtpBy(
    [...earlierPtps, ...rows.filter((r) => r.outcome === "promised")],
    ptpKey,
  );
  const byDebtor = seqBy(
    rows.filter((r) => r.debtor_id),
    (r) => r.debtor_id as string,
  );
  const bestFor = new Map<string, AuditCallRow>();
  const lastFor = new Map<string, AuditCallRow>();
  for (const [id, calls] of byDebtor) {
    const b = bestCall(calls);
    if (b) bestFor.set(id, b);
    lastFor.set(
      id,
      calls.reduce((a, c) => (c.created_at >= a.created_at ? c : a)),
    );
  }
  const bankKeys = bankColumns(rows);
  const headers = [
    "Allocator Name",
    "Allocation File Name",
    "Agency ID",
    "Loan Account Number",
    "Call Date",
    "Agent ID",
    "Agent Name",
    "Supervisor Name",
    "Customer Number",
    "Customer Name",
    "Call Start Time",
    "Call End Time",
    "Call Duration",
    "Ringing Duration",
    "Direction",
    "Record URL",
    "GSM/PRI",
    "Call Status",
    "Allocation Record ID",
    "Campaign Name",
    "Campaign Type",
    "Cause Code",
    "Drop Reason",
    "Provider Cause",
    "Is Failed Call",
    "Disposition Remarks",
    "Disposition",
    "Sub-Disposition",
    "Disconnected By",
    "Reference ID",
    "Product",
    "Bucket",
    "Genration Date",
    "Genration Amount",
    "PTP Date",
    "PTP Amount",
    "Callback Date",
    "Callback Time",
    "Paid Date",
    "Paid Amount",
    "Payment Mode",
    "Agency Name",
    "Best Disposition Name",
    "Best Disposition Rank",
    "Best Disposition Remarks",
    "Last Disposition Name",
    "Last Disposition Rank",
    "Last Disposition Remarks",
    "Grouping Disposition",
    // Beyond the sample: everything else recorded about the call.
    "Call ID",
    "Agent Code",
    "Agent Email",
    "Agent Extension",
    "Team",
    "Manager",
    "Portfolio",
    "Lender",
    "Product Type",
    "Product Code",
    "Loan Amount",
    "Outstanding",
    "Principal",
    "EMI",
    "DPD",
    "Account Status",
    "Customer Email",
    "Alternate Phone",
    "Other Phones",
    "Call Type",
    "Wrap-up Seconds",
    "PTP Time",
    "Telephony Provider",
    "Telephony Status",
    "Provider Call ID",
    "Vendor Call ID",
    "Our Number (DID)",
    "Agent Line",
    "Line Start",
    "Line Answered",
    "Line End",
    "Line Duration",
    "Recording Status",
    "Open in SamvadX",
    "Manager Tone Tag",
    "Manager Tagged By",
    "Manager Tagged At",
    "AI Agent Tone",
    "AI Customer Tone",
    "AI Overall Tone",
    "AI Confidence",
    "AI Reasoning",
    "AI Analysed At",
    "AI Transcript",
    "Audited",
    "Audit Score %",
    "Audit Grade",
    "Fatal Error",
    "Auditor",
    ...bankKeys.map((k) => `Bank: ${k}`),
  ];
  const out = rows.map((c) => {
    const best = c.debtor_id ? bestFor.get(c.debtor_id) : undefined;
    const last = c.debtor_id ? lastFor.get(c.debtor_id) : undefined;
    const start = new Date(c.created_at).getTime();
    const answered = isAnswered(c);
    const contact = isConnectedOutcome(c.outcome);
    const generated = c.outcome === "promised" ? firstPtps.get(ptpKey(c) ?? "") : undefined;
    const cells: XlsxCell[] = [
      c.portfolio_lender ?? c.lender ?? "",
      c.portfolio_name ?? "",
      "",
      c.loan_reference ?? "",
      dmy(istDay(c.created_at)),
      c.agent_code ?? "",
      c.agent_name,
      c.manager_name ?? "",
      c.customer_phone ?? "",
      c.customer_name ?? "",
      istDateTime(c.ledger_started_at ?? c.created_at),
      c.ledger_ended_at
        ? istDateTime(c.ledger_ended_at)
        : istDateTime(new Date(start + (c.duration_seconds ?? 0) * 1000).toISOString()),
      num(c.duration_seconds),
      num(c.ring_seconds),
      c.direction ?? "",
      c.recording_url ? callLink(origin, c) : "",
      c.did_number ?? "",
      answered ? "Answered" : "Not Answered",
      c.debtor_id ?? "",
      c.team_name ?? "",
      dialModeLabel(c.dial_mode),
      "",
      "",
      "",
      c.ledger_status ? (c.ledger_status === "failed" ? "TRUE" : "FALSE") : "",
      c.raw_notes ?? "",
      dispositionLabel(c.outcome),
      c.outcome_reason ?? "",
      disconnectedBy(c),
      "",
      c.product_type ?? c.portfolio_product ?? "",
      num(c.dpd),
      generated ? dmy(istDay(generated.created_at)) : "",
      generated ? num(generated.promise_amount) : "",
      c.outcome === "promised" && c.promise_date ? dmy(c.promise_date) : "",
      c.outcome === "promised" ? num(c.promise_amount) : "",
      c.callback_date ? dmy(c.callback_date) : "",
      c.callback_time ?? "",
      c.outcome === "paid" ? dmy(istDay(c.created_at)) : "",
      c.outcome === "paid" ? num(c.promise_amount) : "",
      "",
      "",
      best ? dispositionLabel(best.outcome) : "",
      best ? (DISPOSITION_RANK[best.outcome] ?? "") : "",
      best ? (best.raw_notes ?? best.outcome_reason ?? "") : "",
      last ? dispositionLabel(last.outcome) : "",
      last ? (DISPOSITION_RANK[last.outcome] ?? "") : "",
      last ? (last.raw_notes ?? last.outcome_reason ?? "") : "",
      contact ? "Contact" : "No Contact",
      c.call_id,
      c.agent_code ?? "",
      c.agent_email ?? "",
      c.agent_extension ?? "",
      c.team_name ?? "",
      c.manager_name ?? "",
      c.portfolio_name ?? "",
      c.lender ?? c.portfolio_lender ?? "",
      c.product_type ?? "",
      c.product_code ?? "",
      num(c.loan_amount),
      num(c.outstanding_balance),
      num(c.principal_amount),
      num(c.emi_amount),
      num(c.dpd),
      c.debtor_status ?? "",
      c.customer_email ?? "",
      c.phone_alternate ?? "",
      (c.alt_phones ?? []).join(", "),
      c.call_type ?? "",
      num(c.wrap_seconds),
      c.promise_time ?? "",
      c.ledger_provider ?? "",
      c.ledger_status ?? "",
      c.provider_call_id ?? "",
      c.vendor_callid ?? "",
      c.did_number ?? "",
      c.agent_handle ?? "",
      istDateTime(c.ledger_started_at),
      istDateTime(c.ledger_answered_at),
      istDateTime(c.ledger_ended_at),
      num(c.ledger_duration_seconds),
      c.recording_status ?? "",
      callLink(origin, c),
      c.manager_sentiment ?? "",
      c.manager_audited_by ?? "",
      istDateTime(c.manager_audited_at),
      c.ai_agent_tone ?? "",
      c.ai_debtor_tone ?? "",
      c.ai_sentiment ?? "",
      num(c.ai_sentiment_confidence),
      c.ai_sentiment_reasoning ?? "",
      istDateTime(c.ai_sentiment_analyzed_at),
      str(c.ai_transcript),
      c.audit_id ? "Yes" : "No",
      num(c.final_percent),
      c.grade ?? "",
      yn(c.fatal),
      c.auditor_name ?? "",
      ...bankKeys.map((k) => str(c.extra?.[k])),
    ];
    return cells;
  });
  return { name: "Call Log", headers, rows: out };
}

function bankColumns(rows: AuditCallRow[]): string[] {
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.extra ?? {})) {
      keys.add(k);
      if (keys.size >= MAX_BANK_COLUMNS) return [...keys];
    }
  }
  return [...keys];
}

/** Every review with the call it judged, the agent's feedback, the AI's view and the replies. */
export function auditFeedbackSheet(
  rows: AuditCallRow[],
  origin: string,
  audience: "auditor" | "manager" = "auditor",
): XlsxSheet {
  const audited = rows.filter((r) => r.audit_id);
  const paramHeaders = SCORECARD.flatMap((p) => [
    `${p.section}: ${p.label}`,
    `${p.label} (Points of ${p.weight})`,
    `${p.label} (Remark)`,
  ]);
  const fatalHeaders = FATAL_ERRORS.map((f) => `Fatal: ${f.label}`);
  const headers = [
    "Audit Date",
    "Audit Last Updated",
    "Times Revised",
    "Auditor",
    "Call Date",
    "Call Time",
    "Loan Account Number",
    "Customer Name",
    "Customer Number",
    "Portfolio",
    "Lender",
    "Team",
    "Manager",
    "Agent Code",
    "Agent Name",
    "Dial Type",
    "DID Used",
    "Call Duration",
    "Disposition",
    "Sub-Disposition",
    "Agent's Call Feedback",
    "PTP Amount",
    "PTP Date",
    "Callback Date",
    "Score Earned",
    "Score Possible",
    "Score % (before fatal)",
    "Final Score %",
    "Grade",
    "Fatal Error",
    ...paramHeaders,
    ...fatalHeaders,
    "Auditor's Tone Verdict",
    "AI Agent Tone",
    "AI Customer Tone",
    "AI Overall Tone",
    "AI Confidence",
    "AI Reasoning",
    "Auditor vs AI",
    "Auditor's Comment on AI",
    "Manager Tone Tag",
    "Best Call",
    "Coaching Required",
    "Strengths",
    "Improvements",
    "Feedback to Agent",
    "Feedback to Manager",
    ...(audience === "manager" ? [] : ["Internal Note"]),
    "Agent Acknowledged At",
    "Agent's Reply",
    "Manager Seen At",
    "Open Call",
  ];
  return {
    name: "Audit + Feedback",
    headers,
    rows: audited.map((c) => {
      const params = SCORECARD.flatMap((p) => {
        const a = c.scores?.[p.id];
        if (!a) return ["", "", ""];
        return [
          a.value === "na" ? "N/A" : a.value[0].toUpperCase() + a.value.slice(1),
          a.value === "na" ? "" : p.weight * SCORE_FRACTION[a.value],
          a.remark ?? "",
        ];
      });
      const fatals = FATAL_ERRORS.map((f) => ((c.fatal_codes ?? []).includes(f.id) ? "Yes" : "No"));
      return [
        istDateTime(c.audit_created_at),
        istDateTime(c.audit_updated_at),
        num(c.audit_revision),
        c.auditor_name ?? "",
        dmy(istDay(c.created_at)),
        istDateTime(c.created_at).slice(11),
        c.loan_reference ?? "",
        c.customer_name ?? "",
        c.customer_phone ?? "",
        c.portfolio_name ?? "",
        c.lender ?? c.portfolio_lender ?? "",
        c.team_name ?? "",
        c.manager_name ?? "",
        c.agent_code ?? "",
        c.agent_name,
        dialModeLabel(c.dial_mode),
        c.did_number ?? "",
        fmtSeconds(c.duration_seconds),
        dispositionLabel(c.outcome),
        c.outcome_reason ?? "",
        c.raw_notes ?? "",
        c.outcome === "promised" ? num(c.promise_amount) : "",
        c.promise_date ? dmy(c.promise_date) : "",
        c.callback_date ? dmy(c.callback_date) : "",
        num(c.score_earned),
        num(c.score_possible),
        num(c.raw_percent),
        num(c.final_percent),
        c.grade ?? "",
        yn(c.fatal),
        ...params,
        ...fatals,
        c.audit_sentiment ?? "",
        c.ai_agent_tone ?? "",
        c.ai_debtor_tone ?? "",
        c.ai_sentiment ?? "",
        num(c.ai_sentiment_confidence),
        c.ai_sentiment_reasoning ?? "",
        c.ai_agreement ?? "",
        c.ai_comment ?? "",
        c.manager_sentiment ?? "",
        yn(c.exemplary),
        yn(c.coaching_required),
        c.strengths ?? "",
        c.improvements ?? "",
        c.feedback_agent ?? "",
        c.feedback_manager ?? "",
        ...(audience === "manager" ? [] : [c.internal_note ?? ""]),
        istDateTime(c.agent_ack_at),
        c.agent_response ?? "",
        istDateTime(c.manager_seen_at),
        audience === "manager" ? `${origin}/manager/audit?call=${c.call_id}` : callLink(origin, c),
      ];
    }),
  };
}

function avgOf(nums: (number | null | undefined)[]): number | "" {
  const ok = nums.filter((n): n is number => n !== null && n !== undefined).map(Number);
  return ok.length ? Math.round((ok.reduce((a, b) => a + b, 0) / ok.length) * 100) / 100 : "";
}

function scorecardColumns(audited: AuditCallRow[]): XlsxCell[] {
  return SCORECARD.map((p) => {
    let earned = 0;
    let possible = 0;
    for (const c of audited) {
      const v = c.scores?.[p.id]?.value;
      if (!v || v === "na") continue;
      possible += p.weight;
      earned += p.weight * SCORE_FRACTION[v];
    }
    return possible ? Math.round((earned / possible) * 10_000) / 100 : "";
  });
}

function rollup(
  name: string,
  idHeaders: string[],
  rows: AuditCallRow[],
  key: (c: AuditCallRow) => string,
  idCells: (c: AuditCallRow) => XlsxCell[],
): XlsxSheet {
  const headers = [
    ...idHeaders,
    "Total Calls",
    "Connected",
    "Connect %",
    "Talk Time",
    "With Recording",
    "AI Analysed",
    "Audited",
    "Audited % of Connected",
    "Average Score %",
    "Lowest Score %",
    "Highest Score %",
    "Excellent",
    "Good",
    "Needs Improvement",
    "Poor",
    "Fatal",
    "Best Calls",
    "Coaching Required",
    "Reviews Acknowledged",
    ...SCORECARD.map((p) => `${p.label} %`),
  ];
  const out: XlsxCell[][] = [];
  for (const calls of seqBy(rows, key).values()) {
    const connected = calls.filter(isAnswered).length;
    const audited = calls.filter((c) => c.audit_id);
    const scores = audited.map((c) => Number(c.final_percent));
    const grade = (g: string) => audited.filter((c) => c.grade === g).length;
    out.push([
      ...idCells(calls[0]),
      calls.length,
      connected,
      Math.round((connected / calls.length) * 10_000) / 100,
      fmtSeconds(calls.reduce((a, c) => a + (c.duration_seconds ?? 0), 0)),
      calls.filter((c) => c.recording_url).length,
      calls.filter((c) => c.ai_sentiment).length,
      audited.length,
      connected ? Math.round((audited.length / connected) * 10_000) / 100 : "",
      avgOf(scores),
      scores.length ? Math.min(...scores) : "",
      scores.length ? Math.max(...scores) : "",
      grade("Excellent"),
      grade("Good"),
      grade("Needs Improvement"),
      grade("Poor"),
      grade("Fatal"),
      audited.filter((c) => c.exemplary).length,
      audited.filter((c) => c.coaching_required).length,
      audited.filter((c) => c.agent_ack_at).length,
      ...scorecardColumns(audited),
    ]);
  }
  return { name, headers, rows: out };
}

export const agentScorecardSheet = (rows: AuditCallRow[]) =>
  rollup(
    "Agent Scorecard",
    ["Agent Code", "Agent Name", "Team", "Manager"],
    rows,
    (c) => c.agent_id,
    (c) => [c.agent_code ?? "", c.agent_name, c.team_name ?? "", c.manager_name ?? ""],
  );

export const teamScorecardSheet = (rows: AuditCallRow[]) =>
  rollup(
    "Team Scorecard",
    ["Team", "Manager"],
    rows,
    (c) => c.team_id ?? "none",
    (c) => [c.team_name ?? "No team", c.manager_name ?? ""],
  );

export const portfolioScorecardSheet = (rows: AuditCallRow[]) =>
  rollup(
    "Portfolio Scorecard",
    ["Portfolio", "Lender"],
    rows,
    (c) => c.portfolio_id ?? "none",
    (c) => [c.portfolio_name ?? "Manual calls (no portfolio)", c.portfolio_lender ?? ""],
  );

export function fatalLogSheet(rows: AuditCallRow[], origin: string): XlsxSheet {
  const label = new Map(FATAL_ERRORS.map((f) => [f.id, f.label]));
  return {
    name: "Fatal Errors",
    headers: [
      "Audit Date",
      "Auditor",
      "Team",
      "Manager",
      "Agent Name",
      "Call Date",
      "Loan Account Number",
      "Customer Name",
      "DID Used",
      "Fatal Errors",
      "Feedback to Agent",
      "Agent's Reply",
      "Open Call",
    ],
    rows: rows
      .filter((c) => c.fatal)
      .map((c) => [
        istDateTime(c.audit_created_at),
        c.auditor_name ?? "",
        c.team_name ?? "",
        c.manager_name ?? "",
        c.agent_name,
        istDateTime(c.created_at),
        c.loan_reference ?? "",
        c.customer_name ?? "",
        c.did_number ?? "",
        (c.fatal_codes ?? []).map((f) => label.get(f) ?? f).join(", "),
        c.feedback_agent ?? "",
        c.agent_response ?? "",
        callLink(origin, c),
      ]),
  };
}

export function aiVsAuditorSheet(rows: AuditCallRow[], origin: string): XlsxSheet {
  return {
    name: "AI vs Auditor",
    headers: [
      "Call Date",
      "Team",
      "Agent Name",
      "Loan Account Number",
      "DID Used",
      "AI Agent Tone",
      "AI Customer Tone",
      "AI Overall Tone",
      "AI Confidence",
      "AI Reasoning",
      "Status",
      "Auditor",
      "Auditor's Tone Verdict",
      "Same as AI",
      "Auditor vs AI",
      "Auditor's Comment on AI",
      "Open Call",
    ],
    rows: rows
      .filter((c) => c.ai_sentiment)
      .map((c) => [
        istDateTime(c.created_at),
        c.team_name ?? "",
        c.agent_name,
        c.loan_reference ?? "",
        c.did_number ?? "",
        c.ai_agent_tone ?? "",
        c.ai_debtor_tone ?? "",
        c.ai_sentiment ?? "",
        num(c.ai_sentiment_confidence),
        c.ai_sentiment_reasoning ?? "",
        c.audit_id ? "Reviewed" : "Waiting for auditor",
        c.auditor_name ?? "",
        c.audit_sentiment ?? "",
        c.audit_id ? yn(c.audit_sentiment === c.ai_sentiment) : "",
        c.ai_agreement ?? "",
        c.ai_comment ?? "",
        callLink(origin, c),
      ]),
  };
}

export function auditorProductivitySheet(rows: AuditCallRow[]): XlsxSheet {
  const audited = rows.filter((c) => c.audit_id);
  const headers = [
    "Audit Day",
    "Auditor",
    "Calls Audited",
    "Call Time Reviewed",
    "Average Score Given %",
    "Fatal Errors Marked",
    "Best Calls Marked",
    "Coaching Requested",
    "Agreed with AI",
    "Disagreed with AI",
  ];
  const out: XlsxCell[][] = [];
  for (const calls of seqBy(
    audited,
    (c) => `${istDay(c.audit_created_at as string)}|${c.auditor_id}`,
  ).values()) {
    out.push([
      dmy(istDay(calls[0].audit_created_at as string)),
      calls[0].auditor_name ?? "",
      calls.length,
      fmtSeconds(calls.reduce((a, c) => a + (c.duration_seconds ?? 0), 0)),
      avgOf(calls.map((c) => c.final_percent)),
      calls.filter((c) => c.fatal).length,
      calls.filter((c) => c.exemplary).length,
      calls.filter((c) => c.coaching_required).length,
      calls.filter((c) => c.ai_agreement === "agree").length,
      calls.filter((c) => c.ai_agreement === "disagree").length,
    ]);
  }
  out.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { name: "Auditor Productivity", headers, rows: out };
}

export function teamReviewsSheet(reviews: TeamReviewRow[]): XlsxSheet {
  return {
    name: "Team Reviews",
    headers: [
      "Written On",
      "Auditor",
      "Team",
      "Manager",
      "Period From",
      "Period To",
      "Rating (of 5)",
      "Summary",
      "Strengths",
      "Improvements",
      "Action Items",
      "Manager Acknowledged At",
      "Manager's Reply",
    ],
    rows: reviews.map((r) => [
      istDateTime(r.created_at),
      r.auditor_name ?? "",
      r.team_name,
      r.manager_name ?? "",
      dmy(r.period_from),
      dmy(r.period_to),
      r.rating,
      r.summary,
      r.strengths ?? "",
      r.improvements ?? "",
      r.action_items ?? "",
      istDateTime(r.acknowledged_at),
      r.manager_response ?? "",
    ]),
  };
}

const PRESENCE_END_CAP_MS = 12 * 3600 * 1000;

/** Seconds per status for one agent's day. An interval left open is unknown, so it counts as 0. */
function presenceTotals(rows: PresenceRow[]) {
  const totals = { available: 0, break: 0, lunch: 0, training: 0, offline: 0 };
  let firstLogin: string | null = null;
  let lastLogout: string | null = null;
  for (const r of rows) {
    if (r.status !== "offline" && (!firstLogin || r.started_at < firstLogin))
      firstLogin = r.started_at;
    if (!r.ended_at) continue;
    const ms = new Date(r.ended_at).getTime() - new Date(r.started_at).getTime();
    if (ms < 0 || ms > PRESENCE_END_CAP_MS) continue;
    if (r.status in totals) totals[r.status as keyof typeof totals] += ms / 1000;
    if (r.status !== "offline" && (!lastLogout || r.ended_at > lastLogout)) lastLogout = r.ended_at;
  }
  return { ...totals, firstLogin, lastLogout };
}

const pct = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 10_000) / 100 : "";
const timeOnly = (iso: string | null) => (iso ? istDateTime(iso).slice(11) : "");

export function performanceSheet(rows: AuditCallRow[], presence: PresenceRow[]): XlsxSheet {
  const headers = [
    "Date",
    "Agent ID",
    "Agent Name",
    "Team Leader/Supervisor",
    "Total Calls",
    "Total Connect Calls",
    "Total Non Connect Calls",
    "Outbound Call",
    "Inbound Call",
    "Login Time",
    "Logout Time",
    "Total Login Hrs",
    "Total Shift Time(Last Logout-First Login)",
    "Offline Time",
    "Idle Time",
    "Call Duration",
    "Wrapup Duration",
    "Wrap %",
    "Talk %",
    "Ringing time",
    "avg Ringin",
    "Avg Callback",
    "Avg call duratrion",
    "Lunch Break",
    "Tea Break",
    "Meeting Break",
    "Mobile Break",
    "Bio Break",
    "Other Break",
    "Training",
    "Total Break",
    "Productive Aux",
    "Non-Productive Aux",
    "Non-Productive Aux %",
    "Utilisation %",
    "PTP Call Back",
    "Pay Later",
    "Claims Paid",
    "Status",
    "PTP Amount",
    "PTP Count",
    "Collected",
    "Today Genration Amount",
    "Today Genration Count",
    "Calls Audited",
    "Average Audit Score %",
    "Fatal Errors",
  ];
  const presenceByKey = seqBy(presence, (p) => `${istDay(p.started_at)}|${p.agent_id}`);
  const out: XlsxCell[][] = [];
  const grouped = seqBy(rows, (c) => `${istDay(c.created_at)}|${c.agent_id}`);
  const keys = [...grouped.keys()].sort();
  for (const key of keys) {
    const calls = grouped.get(key) as AuditCallRow[];
    const c0 = calls[0];
    const p = presenceTotals(presenceByKey.get(key) ?? []);
    const login = p.available + p.break + p.lunch + p.training;
    const talk = calls.reduce((a, c) => a + (c.duration_seconds ?? 0), 0);
    const wrap = calls.reduce((a, c) => a + (c.wrap_seconds ?? 0), 0);
    const rings = calls.map((c) => c.ring_seconds).filter((s): s is number => s != null);
    const ring = rings.reduce((a, b) => a + b, 0);
    const connected = calls.filter(isAnswered).length;
    const outbound = calls.filter((c) => c.direction !== "inbound").length;
    const callbackCalls = calls.filter((c) => c.outcome === "callback");
    const ptps = calls.filter((c) => c.outcome === "promised");
    const paid = calls.filter((c) => c.outcome === "paid");
    const audited = calls.filter((c) => c.audit_id);
    const breaks = p.break + p.lunch;
    const productive = talk + wrap;
    const hasPresence = login > 0;
    const when = (s: number) => (hasPresence ? fmtSeconds(s) : "");
    const shift =
      p.firstLogin && p.lastLogout
        ? (new Date(p.lastLogout).getTime() - new Date(p.firstLogin).getTime()) / 1000
        : null;
    const sumAmount = (list: AuditCallRow[]) =>
      list.reduce((a, c) => a + Number(c.promise_amount ?? 0), 0);
    out.push([
      dmy(key.slice(0, 10)),
      c0.agent_code ?? "",
      c0.agent_name,
      c0.manager_name ?? "",
      calls.length,
      connected,
      calls.length - connected,
      outbound,
      calls.length - outbound,
      timeOnly(p.firstLogin),
      timeOnly(p.lastLogout),
      when(login),
      shift != null ? fmtSeconds(shift) : "",
      when(p.offline),
      when(Math.max(0, p.available - productive - ring)),
      fmtSeconds(talk),
      fmtSeconds(wrap),
      hasPresence ? pct(wrap, login) : "",
      hasPresence ? pct(talk, login) : "",
      rings.length ? fmtSeconds(ring) : "",
      rings.length ? fmtSeconds(ring / rings.length) : "",
      callbackCalls.length
        ? fmtSeconds(
            callbackCalls.reduce((a, c) => a + (c.duration_seconds ?? 0), 0) / callbackCalls.length,
          )
        : "",
      connected ? fmtSeconds(talk / connected) : "",
      when(p.lunch),
      "",
      "",
      "",
      "",
      when(p.break),
      when(p.training),
      when(breaks),
      fmtSeconds(productive),
      when(breaks),
      hasPresence ? pct(breaks, login) : "",
      hasPresence ? pct(productive, login) : "",
      callbackCalls.length,
      ptps.length,
      paid.length,
      "",
      ptps.length ? sumAmount(ptps) : "",
      ptps.length,
      paid.length ? sumAmount(paid) : "",
      paid.length ? sumAmount(paid) : "",
      paid.length,
      audited.length,
      avgOf(audited.map((c) => c.final_percent)),
      audited.filter((c) => c.fatal).length,
    ]);
  }
  return { name: "Performance", headers, rows: out };
}
