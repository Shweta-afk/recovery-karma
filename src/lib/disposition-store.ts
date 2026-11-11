import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";
import { fetchDebtorsByIds } from "./debtors-fetch";
import { createJsonCache } from "./json-cache";
// Type-only (erased) — the valid call_logs.outcome union, shared with fetch-debtors.
import type { CallLogOutcome } from "./fetch-debtors";
import type { DialMode } from "./call-queue/types";
import { addDoNotCall, reportDisposition } from "./telephony-actions.server";
import { getAccessToken } from "./access-token";

export type CallOutcome =
  | "paid"
  | "promised"
  | "refused"
  | "no_answer"
  | "callback"
  | "voicemail"
  | "dispute"
  | "settlement";

/** Manager-assigned call tone/QA tag — the actual point of Call Audit. Outcome says what
 * happened on the call; sentiment says how the debtor was treated and how it went. Manual only
 * (no transcription/sentiment pipeline wired up) — null until a manager reviews the call.
 * Requires migrations/20260811_call_logs_sentiment.sql. */
export type CallSentiment = "happy" | "neutral" | "frustrated" | "rude";

export interface DispositionRecord {
  id: string;
  /** Add this debtor's number to the company's do-not-call list on save */
  doNotCall?: boolean;
  debtorId: string;
  debtorName: string;
  phone: string;
  agentId: string; // email
  agentName: string;
  teamId?: string;
  portfolioId?: string;
  portfolioName?: string;
  outcome: CallOutcome;
  /** Sub-reason for the outcome (e.g. "Switched Off" for no_answer) — see OUTCOME_REASONS in
   * call-queue/types.ts. Requires migrations/20260811_call_logs_outcome_reason.sql. */
  reason?: string;
  notes: string;
  ptpAmount?: number;
  ptpDate?: string;
  /** HH:mm the agent committed to call the debtor back at on ptpDate. Requires
   * migrations/20260811_call_logs_promise_time.sql — absent until then. */
  ptpTime?: string;
  /** When a "callback" disposition agreed to ring back. Deliberately separate from
   * ptpDate/ptpTime: a callback is not a promise to pay, carries no promise_amount, and
   * overloading the promise columns would make every "rows with a promise_date" query start
   * counting callbacks. Requires migrations/20260827_case_escalations.sql. */
  callbackDate?: string;
  callbackTime?: string;
  paidAmount?: number;
  paidRef?: string; // already folded into `notes` by the caller before saving — not read back
  loanAmount?: number;
  dpd?: number;
  /** Provider-hosted recording of the call, when one is available. */
  recordingUrl?: string;
  durationSeconds?: number;
  /** Who handled the call — drives the channel shown in Activity History. */
  callType?: "human" | "ai" | "ivr" | "bot";
  /** How the call was PLACED (manual dock, queue click, multi-line, sequential) — orthogonal
   * to callType above, which is who handled it. Undefined for calls logged before
   * migrations/20260827_call_logs_dial_mode.sql; shown as "Before tracking", never guessed. */
  dialMode?: DialMode;
  /** Provider's id for the call, used to backfill the recording once it is published. */
  providerCallId?: string;
  /** Seconds from dial to answer/abandon. Real, captured by the dialer — this used to be
   * invented by a seeded RNG in agent-time-stats.ts. Undefined for calls logged before
   * migrations/20260830_agent_time_tracking.sql. */
  ringSeconds?: number;
  /** Seconds from call end to disposition submit — the agent's wrap time. Same provenance. */
  wrapSeconds?: number;
  /** Manager's QA tag for this call's tone — see CallSentiment. Absent on any call not yet
   * audited, and always absent until 20260811_call_logs_sentiment.sql has been applied. */
  sentiment?: CallSentiment;
  /** Name of the manager/admin who last set `sentiment`, for display next to the tag. */
  auditedByName?: string;
  auditedAt?: string; // ISO
  /** AI-suggested tone (Groq transcription + Gemini classification), triggered on-demand by a
   * manager from Call Audit — separate from the manual `sentiment` tag above, which it never
   * overwrites. Absent until analyzed, and always absent until
   * 20260814_call_logs_ai_sentiment.sql has been applied. See call-sentiment-actions.server.ts. */
  aiTranscript?: string;
  aiAgentTone?: CallSentiment;
  aiDebtorTone?: CallSentiment;
  aiSentiment?: CallSentiment;
  aiSentimentConfidence?: number;
  aiSentimentReasoning?: string;
  aiSentimentAnalyzedAt?: string; // ISO
  time: string; // ISO
  /** The loan this call is about: loan reference + borrower name, lowercased. The same loan
   * uploaded again (next month's file, a continued portfolio) is a NEW debtor row, so follow-ups
   * group calls by this rather than by debtorId — a PTP on last month's row is settled by a
   * "paid" logged on this month's row. Absent for ad-hoc calls and rows cached before 2026-11-11. */
  loanKey?: string;
  /** The account is no longer worked: paid (bank file), removed, or its portfolio was closed. Its
   * open PTPs and callbacks are not follow-ups any more. */
  accountClosed?: boolean;
}

const KEY = "recoveryai_dispositions_cache";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Distinguishes a real debtor/log id from Manual Dial's synthetic `manual-<timestamp>`.
 * Exported: any table with a UUID debtor_id FK needs this same ad-hoc-id guard —
 * reminders hit the identical bug (see reminder-store.saveReminder) from omitting it. */
export function isUuid(v: string | undefined | null): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}

const cache = createJsonCache<DispositionRecord>(KEY);

export function getDispositions(): DispositionRecord[] {
  return cache.read();
}

/** Pulls call_logs (joined against debtors/portfolios/agents/team_agents for display fields
 * that aren't denormalized onto call_logs itself) and refreshes the local cache. `teamId` is
 * derived from team membership at read time — never stored — so it can't go stale like the
 * old localStorage version's manually-set `teamId` field did. */
export async function refreshDispositions(): Promise<void> {
  // call_logs crosses PostgREST's 1000-row cap on any real client, so it's paginated. `debtors`
  // used to be too (fetchDebtorsShared) — a full-table read just to look up the name/portfolio
  // of whichever debtor each call log happens to reference, meaning every debtor the caller can
  // see (16,617+ and growing) got downloaded to look up the ones that actually have a call
  // logged. Fetched by id, once call_logs' own debtor_ids are known, instead — still every
  // referenced debtor regardless of row-1000 truncation, just not every debtor that exists.
  const [callLogs, portfolios, agents, teamAgents] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("call_logs")
        // `*` rather than an explicit column list: naming contact_name/contact_phone here
        // makes the whole query 400 on any database where that migration has not been applied
        // yet, which silently empties every history view. Selecting all columns keeps reads
        // working across schema drift — the ad-hoc fields are simply absent until then.
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to),
    ),
    supabase.from("portfolios").select("id, name, team_id, closed_at"),
    supabase.from("agents").select("id, email, name"),
    supabase.from("team_agents").select("team_id, agent_id"),
  ]);
  const debtors = callLogs.error
    ? { data: [] as Awaited<ReturnType<typeof fetchDebtorsByIds>>["data"], error: null }
    : await fetchDebtorsByIds(
        (callLogs.data as { debtor_id: string | null }[])
          .map((l) => l.debtor_id)
          .filter((id): id is string => !!id),
      );

  // Each query used to fail this whole function silently (a bare `return`, no log) — so a
  // single broken table meant Activity History just showed nothing with no way to tell why.
  // Log every failure individually, with which table it was, before bailing.
  const named = [
    ["call_logs", callLogs] as const,
    ["debtors", debtors] as const,
    ["portfolios", portfolios] as const,
    ["agents", agents] as const,
    ["team_agents", teamAgents] as const,
  ];
  let failed = false;
  for (const [table, res] of named) {
    if (res.error) {
      console.error(`[dispositions] ${table} query failed:`, res.error.message, res.error);
      failed = true;
    }
  }
  if (failed) return;

  const { data: logs } = callLogs;
  const { data: debtorRows } = debtors;
  const { data: portfolioRows } = portfolios;
  const { data: agentRows } = agents;
  const { data: teamAgentRows } = teamAgents;
  if (!logs || !debtorRows || !portfolioRows || !agentRows || !teamAgentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const portfolioById = new Map(portfolioRows.map((p) => [p.id, p]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));
  // An agent can be on more than one team (one per manager whose portfolio they work), so a
  // call is credited to the team that owns the account's portfolio when the agent is on it,
  // else to the agent's first team (ad-hoc calls, or a portfolio with no team).
  const teamsByAgentId = new Map<string, string[]>();
  for (const ta of teamAgentRows) {
    const list = teamsByAgentId.get(ta.agent_id) ?? [];
    list.push(ta.team_id);
    teamsByAgentId.set(ta.agent_id, list);
  }
  const teamFor = (agentId: string, portfolioTeamId: string | null | undefined) => {
    const teams = teamsByAgentId.get(agentId);
    if (!teams?.length) return undefined;
    return portfolioTeamId && teams.includes(portfolioTeamId) ? portfolioTeamId : teams[0];
  };

  // The generated Supabase types don't cover these columns, so the rows widen to `never`
  // (as they already do throughout this file). Narrow to the shape we actually select.
  type CallLogRow = {
    id: string;
    debtor_id: string | null;
    agent_id: string;
    outcome: string;
    promise_amount: number | string | null;
    promise_date: string | null;
    // Optional: present only once 20260811_call_logs_promise_time.sql has been applied.
    promise_time?: string | null;
    raw_notes: string | null;
    created_at: string;
    recording_url: string | null;
    call_type: string | null;
    provider_call_id?: string | null;
    duration_seconds?: number | null;
    // Optional: present only once 20260731_call_logs_adhoc_contacts.sql has been applied.
    contact_name?: string | null;
    contact_phone?: string | null;
    // Optional: present only once 20260811_call_logs_sentiment.sql has been applied.
    sentiment?: string | null;
    audited_by?: string | null;
    audited_at?: string | null;
    // Optional: present only once 20260811_call_logs_outcome_reason.sql has been applied.
    outcome_reason?: string | null;
    // Optional: present only once 20260827_call_logs_dial_mode.sql has been applied.
    dial_mode?: string | null;
    // Optional: present only once 20260827_case_escalations.sql has been applied.
    callback_date?: string | null;
    callback_time?: string | null;
    // Optional: present only once 20260830_agent_time_tracking.sql has been applied.
    ring_seconds?: number | null;
    wrap_seconds?: number | null;
    // Optional: present only once 20260814_call_logs_ai_sentiment.sql has been applied.
    ai_transcript?: string | null;
    ai_agent_tone?: string | null;
    ai_debtor_tone?: string | null;
    ai_sentiment?: string | null;
    ai_sentiment_confidence?: number | string | null;
    ai_sentiment_reasoning?: string | null;
    ai_sentiment_analyzed_at?: string | null;
  };

  const disps: DispositionRecord[] = (logs as unknown as CallLogRow[]).map((l) => {
    // debtor_id is null for an ad-hoc Manual Dial call, which has no debtor row.
    const debtor = l.debtor_id ? debtorById.get(l.debtor_id) : undefined;
    const portfolio = debtor?.portfolio_id ? portfolioById.get(debtor.portfolio_id) : undefined;
    const agent = agentById.get(l.agent_id);
    const amount = l.promise_amount != null ? Number(l.promise_amount) : undefined;
    return {
      id: l.id,
      // Empty for an ad-hoc Manual Dial call, which has no debtor row to point at.
      debtorId: l.debtor_id ?? "",
      // Manual Dial calls have no debtor row — fall back to the ad-hoc contact captured
      // on the log itself, so they still show a name and number in history.
      debtorName: debtor?.name ?? l.contact_name ?? "",
      phone: debtor?.phone_primary ?? l.contact_phone ?? "",
      agentId: agent?.email ?? "",
      agentName: agent?.name ?? "",
      teamId: teamFor(l.agent_id, portfolio?.team_id),
      portfolioId: debtor?.portfolio_id ?? undefined,
      portfolioName: portfolio?.name,
      outcome: l.outcome as CallOutcome,
      reason: l.outcome_reason ?? undefined,
      dialMode: (l.dial_mode as DialMode | null) ?? undefined,
      callbackDate: l.callback_date ?? undefined,
      callbackTime: l.callback_time ?? undefined,
      ringSeconds: l.ring_seconds ?? undefined,
      wrapSeconds: l.wrap_seconds ?? undefined,
      notes: l.raw_notes ?? "",
      ptpAmount: l.outcome === "promised" ? amount : undefined,
      ptpDate: l.outcome === "promised" ? (l.promise_date ?? undefined) : undefined,
      ptpTime: l.outcome === "promised" ? (l.promise_time ?? undefined) : undefined,
      paidAmount: l.outcome === "paid" ? amount : undefined,
      loanAmount: debtor ? Number(debtor.loan_amount ?? 0) : undefined,
      dpd: debtor?.dpd ?? undefined,
      recordingUrl: l.recording_url ?? undefined,
      durationSeconds: l.duration_seconds ?? undefined,
      callType: (l.call_type as DispositionRecord["callType"]) ?? "human",
      providerCallId: l.provider_call_id ?? undefined,
      sentiment: (l.sentiment as CallSentiment | null) ?? undefined,
      auditedByName: l.audited_by ? agentById.get(l.audited_by)?.name : undefined,
      auditedAt: l.audited_at ?? undefined,
      aiTranscript: l.ai_transcript ?? undefined,
      aiAgentTone: (l.ai_agent_tone as CallSentiment | null) ?? undefined,
      aiDebtorTone: (l.ai_debtor_tone as CallSentiment | null) ?? undefined,
      aiSentiment: (l.ai_sentiment as CallSentiment | null) ?? undefined,
      aiSentimentConfidence:
        l.ai_sentiment_confidence != null ? Number(l.ai_sentiment_confidence) : undefined,
      aiSentimentReasoning: l.ai_sentiment_reasoning ?? undefined,
      aiSentimentAnalyzedAt: l.ai_sentiment_analyzed_at ?? undefined,
      time: l.created_at,
      loanKey: loanKeyOf(debtor?.loan_reference, debtor?.name),
      accountClosed: debtor
        ? debtor.status === "paid" ||
          debtor.status === "removed" ||
          !!(portfolio as { closed_at?: string | null } | undefined)?.closed_at
        : undefined,
    };
  });

  if (!cache.write(disps)) {
    console.warn(
      "[dispositions] localStorage quota exceeded — serving dispositions from memory only for this tab",
    );
  }
  window.dispatchEvent(new CustomEvent("dispositions-updated"));
}

export async function saveDisposition(d: DispositionRecord): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const agentUuid = idByEmail.get(d.agentId);
  if (!agentUuid) throw new Error(`No agent account found for ${d.agentId}`);

  // promise_amount is dual-purpose: the PTP amount for "promised", the paid amount for "paid"
  // — the two outcomes are mutually exclusive so this needs no extra column.
  const amount =
    d.outcome === "promised" ? d.ptpAmount : d.outcome === "paid" ? d.paidAmount : undefined;

  // Manual Dial invents an id like `manual-1785496287078` for a number that has no debtor
  // row. call_logs.debtor_id is a UUID FK, so passing that straight through was rejected
  // with a 400 and the call vanished. Store such calls with a NULL debtor_id and keep the
  // contact details on the log instead.
  const isAdHoc = !isUuid(d.debtorId);

  const logId = isUuid(d.id) ? d.id : crypto.randomUUID();

  // ONE insert with every field. Until 2026-11-05 only the core columns went in the insert, and
  // reason / call-back date+time / PTP time / dial type / ring+wrap time / dialled number were
  // written by a follow-up UPDATE. Agents have no UPDATE policy on call_logs (only managers and
  // admins, for audits), so that UPDATE silently changed 0 rows on EVERY agent call: callbacks
  // were saved with no date, reasons vanished, and dial type read blank. All of those columns
  // are live (checked 2026-11-05), so they now go in with the row.
  //
  // `created_at` is the moment the disposition was made (d.time), so the call is filed on the
  // day it was dispositioned — reports, history and the day filters all read this column.
  const core = {
    id: logId,
    debtor_id: isAdHoc ? null : d.debtorId,
    contact_name: isAdHoc ? d.debtorName || null : null,
    contact_phone: isAdHoc ? d.phone || null : null,
    agent_id: agentUuid,
    call_type: "human",
    outcome: d.outcome,
    promise_amount: amount ?? null,
    promise_date: d.outcome === "promised" ? (d.ptpDate ?? null) : null,
    raw_notes: d.notes,
    recording_url: d.recordingUrl ?? null,
    provider_call_id: d.providerCallId ?? null,
    created_at: d.time || new Date().toISOString(),
  };
  const full = {
    ...core,
    outcome_reason: d.reason || null,
    promise_time: d.outcome === "promised" ? d.ptpTime || null : null,
    dial_mode: d.dialMode ?? null,
    callback_date: d.outcome === "callback" ? d.callbackDate || null : null,
    callback_time: d.outcome === "callback" ? d.callbackTime || null : null,
    ring_seconds: d.ringSeconds ?? null,
    wrap_seconds: d.wrapSeconds ?? null,
    dialed_phone: d.phone || null,
  };
  let { error } = await supabase.from("call_logs").insert(full as never);
  if (error && /column|schema cache/i.test(error.message)) {
    // A database missing one of the newer columns must still keep the disposition itself.
    console.warn("[dispositions] full insert refused, saving core fields only:", error.message);
    ({ error } = await supabase.from("call_logs").insert(core as never));
  }
  if (error) throw error;

  // Financial audit trail — separate from the call log so payments reporting has its own
  // real table, matching the schema's original intent.
  // payments.debtor_id is also a UUID FK. A payment that cannot be attributed to a debtor
  // has no place in the financial audit trail, so an ad-hoc call records the outcome on the
  // call log only — the amount still reaches reporting via promise_amount.
  if (d.outcome === "paid" && d.paidAmount && !isAdHoc) {
    const { error: payErr } = await supabase.from("payments").insert({
      debtor_id: d.debtorId,
      agent_id: agentUuid,
      amount: d.paidAmount,
      status: "completed",
      payment_type: "full",
      notes: d.paidRef ? `Ref: ${d.paidRef}` : null,
      received_at: d.time,
    });
    if (payErr) throw payErr;
  }

  // Every call, with or without an id: without one the server finds the agent's latest call to
  // this number.
  void mirrorToProvider(d);
  if (d.doNotCall) await markDoNotCall(d, isAdHoc);
  await refreshDispositions();
}

async function markDoNotCall(d: DispositionRecord, isAdHoc: boolean): Promise<void> {
  await addDoNotCall({
    data: {
      accessToken: await getAccessToken(),
      ...(isAdHoc ? { phone: d.phone } : { debtorId: d.debtorId }),
      reason: "Borrower asked not to be called",
    },
  });
}

/** Copy the outcome into the telephony vendor's own records (SkyCRM disposition_api). No-op
 *  for other providers; never blocks or fails the save. */
async function mirrorToProvider(d: DispositionRecord): Promise<void> {
  try {
    const followUp =
      d.outcome === "callback"
        ? { date: d.callbackDate, time: d.callbackTime }
        : d.outcome === "promised"
          ? { date: d.ptpDate, time: d.ptpTime }
          : null;
    await reportDisposition({
      data: {
        accessToken: await getAccessToken(),
        providerCallId: d.providerCallId || undefined,
        phone: d.phone || undefined,
        outcome: d.outcome,
        reason: d.reason || undefined,
        remark: d.notes,
        followUpDate: followUp?.date || undefined,
        followUpTime: followUp?.time || undefined,
      },
    });
  } catch (err) {
    console.warn("[dispositions] provider disposition sync failed:", err);
  }
}

/** Insert a call outcome into call_logs directly (no disposition form). Used to auto-log
 * dialer legs a human never dispositioned — AI and IVR calls. `agentEmail` is optional;
 * AI/IVR legs persist with a null agent_id. */
export async function saveCallLog(r: {
  debtorId: string;
  agentEmail?: string;
  callType: "human" | "ai" | "ivr";
  outcome: CallLogOutcome;
  durationSeconds?: number;
  notes?: string;
}): Promise<void> {
  let agentUuid: string | null = null;
  if (r.agentEmail) {
    const { data: agentRows } = await supabase.from("agents").select("id, email");
    agentUuid = (agentRows ?? []).find((a) => a.email === r.agentEmail)?.id ?? null;
  }
  const { error } = await supabase.from("call_logs").insert({
    id: crypto.randomUUID(),
    debtor_id: r.debtorId,
    agent_id: agentUuid,
    call_type: r.callType,
    outcome: r.outcome,
    duration_seconds: r.durationSeconds ?? null,
    raw_notes: r.notes ?? null,
  });
  if (error) throw error;
  await refreshDispositions();
}

export function getAgentDispositions(agentId: string): DispositionRecord[] {
  return getDispositions().filter((d) => d.agentId === agentId);
}

/** Same as getAgentDispositions, for a set of agents at once — the manager combined-queue view
 * seeds its logged-outcomes map from this instead of one agent's dispositions. */
export function getAgentsDispositions(agentIds: string[]): DispositionRecord[] {
  const ids = new Set(agentIds);
  return getDispositions().filter((d) => ids.has(d.agentId));
}

export interface PtpFollowup {
  id: string;
  debtorId: string;
  debtorName: string;
  phone: string;
  ptpAmount: number;
  /** ISO date the debtor promised to pay by. */
  ptpDateIso: string;
  /** HH:mm the agent committed to call back at, if one was captured. */
  ptpTime?: string;
  /** Negative when overdue. */
  daysLeft: number;
  /** Times this debtor was dispositioned before the promise that's currently active. */
  prevAttempts: number;
  notes: string;
  dpd?: number;
}

/** A commitment the debtor or agent made that has a due date and can therefore be MISSED —
 * the unit the escalation chain works in. Kept separate from PtpFollowup (which the PTP
 * tracker UI is built on, and whose fields are all PTP-specific) so a callback never has to
 * masquerade as a promise with a zero amount. */
export interface CaseFollowup {
  kind: "ptp" | "callback";
  id: string;
  debtorId: string;
  debtorName: string;
  phone: string;
  /** ISO date the commitment was due. */
  dueDateIso: string;
  /** HH:mm, when one was captured. */
  dueTime?: string;
  /** ₹ promised — PTPs only; a callback commits to a conversation, not a payment. */
  amount?: number;
  /** Negative when overdue. */
  daysLeft: number;
  notes: string;
}

/** See DispositionRecord.loanKey. */
export function loanKeyOf(
  loanReference: string | null | undefined,
  name: string | null | undefined,
): string | undefined {
  const loan = loanReference?.trim().toLowerCase();
  if (!loan) return undefined;
  return `${loan}|${(name ?? "").trim().toLowerCase().replace(/\s+/g, " ")}`;
}

function accountKey(d: DispositionRecord): string {
  return d.loanKey ? `loan:${d.loanKey}` : `debtor:${d.debtorId}`;
}

/**
 * The latest call on each account that `scope` (one agent's or one team's calls) has touched,
 * judged over EVERY call visible (`all`), kept only when that latest call is itself in scope and
 * the account is still live. Two bugs this fixes (2026-11-11):
 *  - a PTP on an earlier upload of a loan stayed "overdue" after the borrower paid and the agent
 *    logged Paid on the new upload's row — calls were grouped by debtor row, not by loan;
 *  - a PTP on an account whose portfolio had since been closed (or that the bank's paid file had
 *    marked paid) stayed on the tracker and kept escalating, although nobody works it any more;
 *    and a later call by someone outside the scope (another agent, the manager) was ignored.
 * Returns each account's latest call plus how many in-scope calls it has.
 */
function latestOpenPerAccount(
  scope: DispositionRecord[],
  all: DispositionRecord[],
): Array<{ latest: DispositionRecord; scopeCalls: number }> {
  const scopeIds = new Set(scope.map((d) => d.id));
  const scopeCount = new Map<string, number>();
  for (const d of scope) {
    if (!d.debtorId) continue;
    const k = accountKey(d);
    scopeCount.set(k, (scopeCount.get(k) ?? 0) + 1);
  }
  const latest = new Map<string, DispositionRecord>();
  const seen = new Set<string>();
  for (const d of [...scope, ...all]) {
    if (!d.debtorId || seen.has(d.id)) continue;
    seen.add(d.id);
    const k = accountKey(d);
    if (!scopeCount.has(k)) continue;
    const prev = latest.get(k);
    if (!prev || Date.parse(d.time) > Date.parse(prev.time)) latest.set(k, d);
  }
  const out: Array<{ latest: DispositionRecord; scopeCalls: number }> = [];
  for (const [k, d] of latest) {
    if (!scopeIds.has(d.id) || d.accountClosed) continue;
    out.push({ latest: d, scopeCalls: scopeCount.get(k) ?? 1 });
  }
  return out;
}

/**
 * Every open, dated commitment across these dispositions — PTPs and callbacks alike.
 *
 * "Open" means the same thing it means for PTPs: only the LATEST disposition per debtor
 * counts. A debtor who promised on Monday and was marked refused on Tuesday has no live
 * commitment, and a callback superseded by an actual conversation is not still owed.
 */
export function computeCaseFollowups(
  disps: DispositionRecord[],
  all: DispositionRecord[] = disps,
): CaseFollowup[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows: CaseFollowup[] = [];
  for (const { latest } of latestOpenPerAccount(disps, all)) {
    const debtorId = latest.debtorId;

    let kind: CaseFollowup["kind"];
    let dueDate: string | undefined;
    let dueTime: string | undefined;
    let amount: number | undefined;

    if (latest.outcome === "promised" && latest.ptpDate && latest.ptpAmount != null) {
      kind = "ptp";
      dueDate = latest.ptpDate;
      dueTime = latest.ptpTime;
      amount = latest.ptpAmount;
    } else if (latest.outcome === "callback" && latest.callbackDate) {
      // callbackDate is absent on any call logged before 20260827_case_escalations.sql, so
      // older callbacks simply never escalate rather than escalating with a wrong date.
      kind = "callback";
      dueDate = latest.callbackDate;
      dueTime = latest.callbackTime;
    } else {
      continue;
    }

    rows.push({
      kind,
      id: latest.id,
      debtorId,
      debtorName: latest.debtorName,
      phone: latest.phone,
      dueDateIso: dueDate,
      dueTime,
      amount,
      daysLeft: Math.round((new Date(dueDate).getTime() - today.getTime()) / 86_400_000),
      notes: latest.notes,
    });
  }

  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

/** One agent's open commitments — feeds step 1 of the escalation chain. */
export function getCaseFollowups(agentId: string): CaseFollowup[] {
  return computeCaseFollowups(getAgentDispositions(agentId), getDispositions());
}

/** Every commitment across a manager's team — feeds step 2. */
export function getTeamCaseFollowups(agentIds: string[]): CaseFollowup[] {
  const idSet = new Set(agentIds);
  const all = getDispositions();
  return computeCaseFollowups(
    all.filter((d) => idSet.has(d.agentId)),
    all,
  );
}

/** Shared by getPtpFollowups (one agent) and getTeamPtpFollowups (a manager's whole team) —
 * the "still open" logic (only the latest disposition per debtor counts) doesn't change based
 * on whose calls are being looked at. */
export function computePtpFollowups(
  disps: DispositionRecord[],
  all: DispositionRecord[] = disps,
): PtpFollowup[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows: PtpFollowup[] = [];
  for (const { latest, scopeCalls } of latestOpenPerAccount(disps, all)) {
    const debtorId = latest.debtorId;
    if (latest.outcome !== "promised" || !latest.ptpDate || latest.ptpAmount == null) continue;

    const daysLeft = Math.round(
      (new Date(latest.ptpDate).getTime() - today.getTime()) / 86_400_000,
    );
    rows.push({
      id: latest.id,
      debtorId,
      debtorName: latest.debtorName,
      phone: latest.phone,
      ptpAmount: latest.ptpAmount,
      ptpDateIso: latest.ptpDate,
      ptpTime: latest.ptpTime,
      daysLeft,
      prevAttempts: scopeCalls - 1,
      notes: latest.notes,
      dpd: latest.dpd,
    });
  }

  return rows.sort((a, b) => a.daysLeft - b.daysLeft);
}

/**
 * Debtors whose most recent logged call is still an open promise-to-pay — i.e. no later
 * disposition (paid, refused, another promise, ...) has superseded it. Replaces the
 * PTP_FOLLOWUPS mock fixture that used to feed the Call Queue's "PTP Follow-up Tracker".
 */
export function getPtpFollowups(agentId: string): PtpFollowup[] {
  return computePtpFollowups(getAgentDispositions(agentId), getDispositions());
}

/** Same as getPtpFollowups but across every agent on a manager's team — feeds the manager-side
 * half of the PTP miss-escalation chain (see ptp-escalation-store.ts), which needs to know
 * about overdue PTPs regardless of which of the manager's agents logged them. */
export function getTeamPtpFollowups(agentIds: string[]): PtpFollowup[] {
  const idSet = new Set(agentIds);
  const all = getDispositions();
  return computePtpFollowups(
    all.filter((d) => idSet.has(d.agentId)),
    all,
  );
}

export function getTeamDispositions(teamId: string): DispositionRecord[] {
  return getDispositions().filter((d) => d.teamId === teamId);
}

/** Most recent disposition per debtor, across every agent — "what is this account currently
 * marked as". Deliberately not filtered by agent: an account's state is whatever the last
 * person to call it recorded, not only what the signed-in user did with it.
 *
 * Shared by buildAssignedQueue (which derives the call queue's status pills from it) and the
 * Accounts table on the manager/admin portfolio dashboards, so the two can never disagree
 * about what an account is marked as. */
export function getLatestDispositionByDebtor(): Map<string, DispositionRecord> {
  const latest = new Map<string, DispositionRecord>();
  for (const d of getDispositions()) {
    if (!d.debtorId) continue;
    const prev = latest.get(d.debtorId);
    if (prev && prev.time >= d.time) continue;
    latest.set(d.debtorId, d);
  }
  return latest;
}

export function getDispositionsByPortfolio(portfolioId: string): DispositionRecord[] {
  return getDispositions().filter((d) => d.portfolioId === portfolioId);
}

// Aggregated stats for a list of dispositions
export function calcStats(disps: DispositionRecord[]) {
  const total = disps.length;
  const ptps = disps.filter((d) => d.outcome === "promised");
  const paid = disps.filter((d) => d.outcome === "paid");
  const ptpAmount = ptps.reduce((s, d) => s + (d.ptpAmount ?? 0), 0);
  const paidAmount = paid.reduce((s, d) => s + (d.paidAmount ?? 0), 0);
  const contactRate =
    total > 0
      ? Math.round(
          (disps.filter((d) => !["no_answer", "voicemail"].includes(d.outcome)).length / total) *
            100,
        )
      : 0;
  return { total, ptps: ptps.length, paid: paid.length, ptpAmount, paidAmount, contactRate };
}

/**
 * Attach recordings that the provider published after the call was logged.
 *
 * Some providers publish recordings asynchronously, arriving after the row is already saved
 * with no recording. The lookup
 * runs server-side (it needs the provider API token); the UPDATE runs here under the user's
 * own session, so RLS covers it and no service-role key is involved.
 *
 * Returns how many rows were filled in.
 */
export async function backfillRecordings(records: DispositionRecord[]): Promise<number> {
  const pending = records.filter((r) => r.providerCallId && !r.recordingUrl);
  if (!pending.length) return 0;

  const { fetchRecordings } = await import("@/lib/telephony/server");
  const { getAccessToken } = await import("@/lib/access-token");
  const found = await fetchRecordings({
    data: {
      accessToken: await getAccessToken(),
      providerCallIds: pending.map((r) => r.providerCallId!),
    },
  });

  let filled = 0;
  for (const rec of pending) {
    const url = found[rec.providerCallId!];
    if (!url) continue;
    const { error } = await supabase
      .from("call_logs")
      // Cast for the same reason as the reads above: the generated Supabase types don't
      // cover this table's columns, so writes widen to `never`.
      .update({ recording_url: url })
      .eq("id", rec.id);
    if (error) {
      console.warn(`[dispositions] could not attach recording to ${rec.id}: ${error.message}`);
      continue;
    }
    filled++;
  }

  if (filled) await refreshDispositions();
  return filled;
}
