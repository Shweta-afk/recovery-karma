// The Call Auditor's rules (2026-11-09): the scorecard, how a call is scored, and the shapes the
// server hands to the portal. Pure, no imports with side effects, so the browser and server share
// one definition and scripts/call-audit.test.ts can pin it.
//
// The server recomputes every score from the raw answers (call-audit.server.ts); a score sent by
// the browser is never stored.
//
// Changing the scorecard: bump SCORECARD_VERSION. Old audits keep their answers in `scores`, and
// reports show a parameter that no longer exists as blank rather than failing.

export const SCORECARD_VERSION = 1;

export type ScoreValue = "yes" | "partial" | "no" | "na";

export interface ScoreParam {
  id: string;
  section: string;
  label: string;
  weight: number;
}

export const SCORECARD: ScoreParam[] = [
  { id: "greeting", section: "Opening", label: "Greeted the customer properly", weight: 5 },
  { id: "self_intro", section: "Opening", label: "Gave own name and company", weight: 5 },
  { id: "right_party", section: "Opening", label: "Confirmed the right person", weight: 10 },
  { id: "purpose", section: "Opening", label: "Stated purpose of the call clearly", weight: 5 },
  { id: "tone", section: "Communication", label: "Polite, respectful tone", weight: 10 },
  { id: "listening", section: "Communication", label: "Listened without interrupting", weight: 5 },
  { id: "language", section: "Communication", label: "Used the customer's language", weight: 5 },
  { id: "dues", section: "Negotiation", label: "Explained dues correctly", weight: 10 },
  { id: "probing", section: "Negotiation", label: "Asked the reason for non-payment", weight: 10 },
  { id: "objections", section: "Negotiation", label: "Handled objections well", weight: 10 },
  { id: "commitment", section: "Closing", label: "Tried for a date and amount", weight: 10 },
  { id: "summary", section: "Closing", label: "Summarised next steps", weight: 5 },
  {
    id: "disposition",
    section: "Closing",
    label: "Disposition and notes are accurate",
    weight: 10,
  },
];

/** Any one of these fails the call outright, whatever else went well. */
export const FATAL_ERRORS: { id: string; label: string }[] = [
  { id: "abuse", label: "Abusive or threatening language" },
  { id: "third_party", label: "Disclosed the debt to someone else" },
  { id: "false_info", label: "Gave false information or false threats" },
  { id: "harassment", label: "Harassment or repeated pressure" },
  { id: "payment_misguide", label: "Asked for payment outside approved channels" },
  { id: "outside_hours", label: "Called outside permitted hours" },
];

export const SCORE_FRACTION: Record<Exclude<ScoreValue, "na">, number> = {
  yes: 1,
  partial: 0.5,
  no: 0,
};

export type ScoreAnswers = Record<string, { value: ScoreValue; remark?: string }>;

export type Grade = "Excellent" | "Good" | "Needs Improvement" | "Poor" | "Fatal";

export function gradeFor(percent: number, fatal: boolean): Grade {
  if (fatal) return "Fatal";
  if (percent >= 90) return "Excellent";
  if (percent >= 75) return "Good";
  if (percent >= 60) return "Needs Improvement";
  return "Poor";
}

export interface ScoreResult {
  earned: number;
  possible: number;
  rawPercent: number;
  finalPercent: number;
  grade: Grade;
  fatal: boolean;
  fatalCodes: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** An unanswered or "N/A" parameter leaves the denominator: it cannot help or hurt the agent. */
export function computeScore(answers: ScoreAnswers, fatalCodes: string[]): ScoreResult {
  let earned = 0;
  let possible = 0;
  for (const p of SCORECARD) {
    const value = answers[p.id]?.value;
    if (!value || value === "na") continue;
    possible += p.weight;
    earned += p.weight * SCORE_FRACTION[value];
  }
  const known = new Set(FATAL_ERRORS.map((f) => f.id));
  const codes = [...new Set(fatalCodes)].filter((c) => known.has(c));
  const fatal = codes.length > 0;
  const rawPercent = possible > 0 ? round2((earned / possible) * 100) : 0;
  const finalPercent = fatal ? 0 : rawPercent;
  return {
    earned: round2(earned),
    possible,
    rawPercent,
    finalPercent,
    grade: gradeFor(rawPercent, fatal),
    fatal,
    fatalCodes: codes,
  };
}

/** A review must judge something: at least one parameter answered, or a fatal error marked. */
export function auditHasContent(answers: ScoreAnswers, fatalCodes: string[]): boolean {
  return fatalCodes.length > 0 || SCORECARD.some((p) => !!answers[p.id]?.value);
}

export type AuditSentiment = "happy" | "neutral" | "frustrated" | "rude";
export type AiAgreement = "agree" | "partly" | "disagree";

export type AuditQueueFilter =
  "pending" | "ai_waiting" | "audited" | "fatal" | "exemplary" | "coaching";

/** One row of the SQL view call_audit_rows. Dates are ISO strings, money arrives as numbers. */
export interface AuditCallRow {
  client_id: string;
  call_id: string;
  created_at: string;
  agent_id: string;
  agent_name: string;
  agent_email: string | null;
  agent_code: string | null;
  agent_extension: string | null;
  call_type: string | null;
  dial_mode: string | null;
  outcome: string;
  outcome_reason: string | null;
  promise_amount: number | null;
  promise_date: string | null;
  promise_time: string | null;
  callback_date: string | null;
  callback_time: string | null;
  duration_seconds: number | null;
  ring_seconds: number | null;
  wrap_seconds: number | null;
  raw_notes: string | null;
  ai_notes: string | null;
  recording_url: string | null;
  provider_call_id: string | null;
  dialed_phone: string | null;
  manager_sentiment: string | null;
  manager_audited_at: string | null;
  manager_audited_by: string | null;
  ai_transcript?: string | null;
  ai_agent_tone: string | null;
  ai_debtor_tone: string | null;
  ai_sentiment: string | null;
  ai_sentiment_confidence: number | null;
  ai_sentiment_reasoning: string | null;
  ai_sentiment_analyzed_at: string | null;
  debtor_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  phone_alternate: string | null;
  alt_phones: string[] | null;
  customer_email: string | null;
  loan_reference: string | null;
  loan_amount: number | null;
  outstanding_balance: number | null;
  principal_amount: number | null;
  emi_amount: number | null;
  dpd: number | null;
  lender: string | null;
  product_type: string | null;
  product_code: string | null;
  debtor_status: string | null;
  ai_score: number | null;
  extra?: Record<string, string | number | boolean | null> | null;
  portfolio_id: string | null;
  portfolio_name: string | null;
  portfolio_lender: string | null;
  portfolio_product: string | null;
  portfolio_uploaded_at: string | null;
  team_id: string | null;
  team_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
  ledger_id: string | null;
  ledger_provider: string | null;
  direction: string | null;
  ledger_status: string | null;
  remote_phone: string | null;
  did_number: string | null;
  agent_handle: string | null;
  vendor_callid: string | null;
  ledger_started_at: string | null;
  ledger_answered_at: string | null;
  ledger_ended_at: string | null;
  ledger_duration_seconds: number | null;
  recording_status: string | null;
  recording_error?: string | null;
  audit_id: string | null;
  auditor_id: string | null;
  auditor_name: string | null;
  scorecard_version: number | null;
  scores: ScoreAnswers | null;
  score_earned: number | null;
  score_possible: number | null;
  raw_percent: number | null;
  final_percent: number | null;
  grade: string | null;
  fatal: boolean | null;
  fatal_codes: string[] | null;
  audit_sentiment: string | null;
  ai_agreement: string | null;
  ai_comment: string | null;
  exemplary: boolean | null;
  coaching_required: boolean | null;
  strengths: string | null;
  improvements: string | null;
  feedback_agent: string | null;
  feedback_manager: string | null;
  internal_note: string | null;
  agent_ack_at: string | null;
  agent_response: string | null;
  manager_seen_at: string | null;
  audit_revision: number | null;
  audit_created_at: string | null;
  audit_updated_at: string | null;
}

export interface AuditTeamSummary {
  team_id: string | null;
  team_name: string;
  manager_id: string | null;
  manager_name: string | null;
  calls: number;
  connected: number;
  talk_seconds: number;
  agents: number;
  with_recording: number;
  audited: number;
  avg_score: number | null;
  fatal: number;
  coaching: number;
}

export interface AuditAgentSummary {
  agent_id: string;
  agent_name: string;
  team_id: string | null;
  team_name: string;
  calls: number;
  connected: number;
  talk_seconds: number;
  audited: number;
  avg_score: number | null;
  fatal: number;
  exemplary: number;
}

export interface AuditSummary {
  totals: {
    calls: number;
    connected: number;
    talk_seconds: number;
    with_recording: number;
    ai_done: number;
    ai_waiting: number;
    audited: number;
    avg_score: number | null;
    fatal: number;
    exemplary: number;
    coaching: number;
  };
  teams: AuditTeamSummary[];
  agents: AuditAgentSummary[];
}

export interface TeamReviewRow {
  id: string;
  team_id: string | null;
  team_name: string;
  manager_id: string | null;
  manager_name: string | null;
  auditor_id: string | null;
  auditor_name: string | null;
  period_from: string;
  period_to: string;
  rating: number;
  summary: string;
  strengths: string | null;
  improvements: string | null;
  action_items: string | null;
  acknowledged_at: string | null;
  manager_response: string | null;
  created_at: string;
}

/** IST midnight bounds for a "YYYY-MM-DD" range. `to` is exclusive: the following midnight. */
export function istRangeBounds(from: string, to: string): { from: string; to: string } {
  const next = new Date(`${to}T00:00:00+05:30`).getTime() + 86_400_000;
  return { from: `${from}T00:00:00+05:30`, to: new Date(next).toISOString() };
}

/** "YYYY-MM-DD" in IST, `daysAgo` days before now. */
export function istDayKeyDaysAgo(daysAgo: number, now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 330 * 60_000 - daysAgo * 86_400_000);
  return ist.toISOString().slice(0, 10);
}

export function fmtSeconds(total: number | null | undefined): string {
  const s = Math.max(0, Math.round(total ?? 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const OUTCOME_LABEL: Record<string, string> = {
  paid: "Paid",
  promised: "PTP",
  refused: "RTP",
  no_answer: "Not Contacted",
  callback: "Call Back",
  voicemail: "Not Contacted",
  dispute: "Dispute",
  settlement: "Settlement",
};

export const isConnectedOutcome = (outcome: string | null | undefined) =>
  !!outcome && outcome !== "no_answer" && outcome !== "voicemail";

/** Did the line connect? Telephony's answer when it has one (the company's own "Call Status" is
 *  separate from the disposition: an answered call can still be "Not Contacted"); the
 *  disposition only for calls with no ledger row. */
export const isAnswered = (c: { ledger_status?: string | null; outcome: string | null }) =>
  c.ledger_status ? c.ledger_status === "completed" : isConnectedOutcome(c.outcome);

/** Higher = better result for "Best Disposition". Not Contacted is the floor. */
export const DISPOSITION_RANK: Record<string, number> = {
  paid: 900,
  settlement: 800,
  promised: 700,
  callback: 500,
  dispute: 400,
  refused: 300,
  voicemail: 100,
  no_answer: 100,
};

export const dispositionLabel = (outcome: string | null | undefined) =>
  outcome ? (OUTCOME_LABEL[outcome] ?? outcome) : "";

/* ─── a manager's view of their own team ─────────────────────────────────────── */

export type PerformanceRow = Pick<
  AuditCallRow,
  | "agent_id"
  | "agent_name"
  | "outcome"
  | "ledger_status"
  | "duration_seconds"
  | "audit_id"
  | "final_percent"
  | "fatal"
  | "coaching_required"
  | "exemplary"
  | "scores"
>;

export interface AgentPerformance {
  agent_id: string;
  agent_name: string;
  calls: number;
  connected: number;
  talk_seconds: number;
  audited: number;
  avg_score: number | null;
  fatal: number;
  coaching: number;
  best_calls: number;
  /** The scorecard question this agent loses most on, when one has been answered. */
  weakest: string | null;
}

export interface ParameterPerformance {
  id: string;
  section: string;
  label: string;
  answered: number;
  percent: number;
}

export interface TeamPerformance {
  calls: number;
  connected: number;
  talk_seconds: number;
  audited: number;
  not_audited: number;
  avg_score: number | null;
  fatal: number;
  coaching: number;
  best_calls: number;
  agents: AgentPerformance[];
  /** Weakest first. Only questions the auditor has answered. */
  parameters: ParameterPerformance[];
}

function parameterResults(rows: PerformanceRow[]): ParameterPerformance[] {
  const out: ParameterPerformance[] = [];
  for (const p of SCORECARD) {
    let earned = 0;
    let possible = 0;
    let answered = 0;
    for (const r of rows) {
      const v = r.scores?.[p.id]?.value;
      if (!v || v === "na") continue;
      answered++;
      possible += p.weight;
      earned += p.weight * SCORE_FRACTION[v];
    }
    if (possible) {
      out.push({
        id: p.id,
        section: p.section,
        label: p.label,
        answered,
        percent: round2((earned / possible) * 100),
      });
    }
  }
  return out.sort((a, b) => a.percent - b.percent);
}

const averageScore = (rows: PerformanceRow[]) =>
  rows.length
    ? Math.round((rows.reduce((a, r) => a + Number(r.final_percent), 0) / rows.length) * 10) / 10
    : null;

const talkSeconds = (rows: PerformanceRow[]) =>
  rows.reduce((a, r) => a + (r.duration_seconds ?? 0), 0);

export function buildTeamPerformance(rows: PerformanceRow[]): TeamPerformance {
  const reviewed = rows.filter((r) => r.audit_id);
  const byAgent = new Map<string, PerformanceRow[]>();
  for (const r of rows) {
    const list = byAgent.get(r.agent_id);
    if (list) list.push(r);
    else byAgent.set(r.agent_id, [r]);
  }
  const agents: AgentPerformance[] = [...byAgent.values()].map((calls) => {
    const audited = calls.filter((c) => c.audit_id);
    return {
      agent_id: calls[0].agent_id,
      agent_name: calls[0].agent_name,
      calls: calls.length,
      connected: calls.filter(isAnswered).length,
      talk_seconds: talkSeconds(calls),
      audited: audited.length,
      avg_score: averageScore(audited),
      fatal: audited.filter((c) => c.fatal).length,
      coaching: audited.filter((c) => c.coaching_required).length,
      best_calls: audited.filter((c) => c.exemplary).length,
      weakest: parameterResults(audited)[0]?.label ?? null,
    };
  });
  // Reviewed agents best first; agents nobody has reviewed yet go last.
  agents.sort((a, b) => (b.avg_score ?? -1) - (a.avg_score ?? -1) || b.calls - a.calls);
  return {
    calls: rows.length,
    connected: rows.filter(isAnswered).length,
    talk_seconds: talkSeconds(rows),
    audited: reviewed.length,
    not_audited: rows.length - reviewed.length,
    avg_score: averageScore(reviewed),
    fatal: reviewed.filter((r) => r.fatal).length,
    coaching: reviewed.filter((r) => r.coaching_required).length,
    best_calls: reviewed.filter((r) => r.exemplary).length,
    agents,
    parameters: parameterResults(reviewed),
  };
}

/* ─── the auditor's work queue ───────────────────────────────────────────────── */

/** Shorter calls have nothing to judge. */
export const MIN_AUDIT_SECONDS = 20;
export const DEFAULT_AUDIT_TARGET = 5;
/** One batch of AI analysis: each call costs transcription and classification. */
export const MAX_AI_BATCH = 50;

export type QueueCall = Pick<
  AuditCallRow,
  | "call_id"
  | "agent_id"
  | "agent_name"
  | "team_name"
  | "created_at"
  | "customer_name"
  | "loan_reference"
  | "outcome"
  | "duration_seconds"
  | "recording_url"
  | "ai_sentiment"
  | "audit_id"
>;

export interface QueueAgent {
  agent_id: string;
  agent_name: string;
  team_name: string;
  eligible: number;
  audited: number;
  target: number;
  remaining: number;
  picks: QueueCall[];
}

/** A stable shuffle: the same call lands in the same place every time the page loads, so two
 *  auditors see one sample and it doesn't reshuffle under them, with nothing to store. */
function sampleOrder(callId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < callId.length; i++) {
    h ^= callId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Per agent: how far along the target is, and which calls to review next. Calls that have a
 *  recording come first, since those are the ones an auditor can actually listen to. */
export function buildAuditQueue(calls: QueueCall[], target: number): QueueAgent[] {
  const byAgent = new Map<string, QueueCall[]>();
  for (const c of calls) {
    const list = byAgent.get(c.agent_id);
    if (list) list.push(c);
    else byAgent.set(c.agent_id, [c]);
  }
  const agents = [...byAgent.values()].map((list): QueueAgent => {
    const audited = list.filter((c) => c.audit_id).length;
    const remaining = Math.max(0, target - audited);
    const picks = list
      .filter((c) => !c.audit_id)
      .sort(
        (a, b) =>
          Number(!!b.recording_url) - Number(!!a.recording_url) ||
          sampleOrder(a.call_id) - sampleOrder(b.call_id),
      )
      .slice(0, remaining);
    return {
      agent_id: list[0].agent_id,
      agent_name: list[0].agent_name,
      team_name: list[0].team_name ?? "No team",
      eligible: list.length,
      audited,
      target,
      remaining,
      picks,
    };
  });
  return agents.sort(
    (a, b) => b.picks.length - a.picks.length || a.agent_name.localeCompare(b.agent_name),
  );
}

/** "YYYY-MM-DD" of this IST week's Monday. */
export function istWeekStart(now: Date = new Date()): string {
  const today = istDayKeyDaysAgo(0, now);
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  return istDayKeyDaysAgo((day + 6) % 7, now);
}
