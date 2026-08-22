import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";
import { fetchDebtorsShared } from "./debtors-fetch";
// Type-only (erased) — the valid call_logs.outcome union, shared with fetch-debtors.
import type { CallLogOutcome } from "./fetch-debtors";

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
  debtorId: string;
  debtorName: string;
  phone: string;
  agentId: string; // email
  agentName: string;
  teamId?: string;
  portfolioId?: string;
  portfolioName?: string;
  outcome: CallOutcome;
  /** Sub-reason for the outcome (e.g. "Switched off" for no_answer) — see OUTCOME_REASONS in
   * active-call.tsx. Requires migrations/20260811_call_logs_outcome_reason.sql. */
  reason?: string;
  notes: string;
  ptpAmount?: number;
  ptpDate?: string;
  /** HH:mm the agent committed to call the debtor back at on ptpDate. Requires
   * migrations/20260811_call_logs_promise_time.sql — absent until then. */
  ptpTime?: string;
  paidAmount?: number;
  paidRef?: string; // already folded into `notes` by the caller before saving — not read back
  loanAmount?: number;
  dpd?: number;
  /** Provider-hosted recording of the call, when one is available. */
  recordingUrl?: string;
  durationSeconds?: number;
  /** Who handled the call — drives the channel shown in Activity History. */
  callType?: "human" | "ai" | "ivr" | "bot";
  /** Provider's id for the call, used to backfill the recording once it is published. */
  providerCallId?: string;
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
}

const KEY = "recoveryai_dispositions_cache";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Distinguishes a real debtor/log id from Manual Dial's synthetic `manual-<timestamp>`.
 * Exported: any table with a UUID debtor_id FK needs this same ad-hoc-id guard —
 * reminders hit the identical bug (see reminder-store.saveReminder) from omitting it. */
export function isUuid(v: string | undefined | null): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}

// Set only when the cache write below fails (quota exceeded — see refreshDispositions()) so
// this tab keeps serving its own freshest fetch instead of silently falling back to whatever
// smaller/stale snapshot localStorage still holds. Mirrors portfolio-store's fallback, and is
// cleared again the next time a write succeeds, so the normal path is unaffected.
let inMemoryFallback: DispositionRecord[] | null = null;

export function getDispositions(): DispositionRecord[] {
  if (inMemoryFallback) return inMemoryFallback;
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DispositionRecord[]) : [];
  } catch {
    return [];
  }
}

/** Pulls call_logs (joined against debtors/portfolios/agents/team_agents for display fields
 * that aren't denormalized onto call_logs itself) and refreshes the local cache. `teamId` is
 * derived from team membership at read time — never stored — so it can't go stale like the
 * old localStorage version's manually-set `teamId` field did. */
export async function refreshDispositions(): Promise<void> {
  // call_logs and debtors both cross PostgREST's 1000-row cap on any real client, so both go
  // through fetchAllRows(). Truncating `debtors` was the worse of the two: every call log
  // whose debtor fell past row 1000 resolved to `undefined` here, losing its portfolioId —
  // which silently zeroed out the per-portfolio KPI cards that group by it.
  const [callLogs, debtors, portfolios, agents, teamAgents] = await Promise.all([
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
    fetchDebtorsShared(),
    supabase.from("portfolios").select("id, name"),
    supabase.from("agents").select("id, email, name"),
    supabase.from("team_agents").select("team_id, agent_id"),
  ]);

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
  const teamByAgentId = new Map(teamAgentRows.map((ta) => [ta.agent_id, ta.team_id]));

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
      teamId: teamByAgentId.get(l.agent_id),
      portfolioId: debtor?.portfolio_id ?? undefined,
      portfolioName: portfolio?.name,
      outcome: l.outcome as CallOutcome,
      reason: l.outcome_reason ?? undefined,
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
    };
  });

  try {
    localStorage.setItem(KEY, JSON.stringify(disps));
    inMemoryFallback = null;
  } catch (e) {
    // Unguarded, this threw straight out of refreshDispositions() once the log history got
    // big enough — before the event below ever fired — so every listening view stayed pinned
    // to a stale cache with nothing logged. Serve from memory for this tab instead; only
    // cross-tab live sync pauses.
    console.warn(
      "[dispositions] localStorage quota exceeded — serving dispositions from memory only for this tab",
      e,
    );
    inMemoryFallback = disps;
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

  // Core columns only — every one of these has existed since the original schema.sql, so this
  // insert can never fail because of a migration nobody's run yet. outcome_reason/promise_time
  // are newer (20260811_call_logs_outcome_reason.sql / _promise_time.sql) — writing them in the
  // SAME insert meant a call_logs row with either column still missing rejected the ENTIRE
  // disposition with a "column does not exist" error, so nothing saved at all, on every call,
  // until someone ran those migrations. Now they're a separate best-effort update after the
  // core save succeeds — worst case the reason/call-back-time is silently dropped, not the
  // whole disposition.
  const { error } = await supabase.from("call_logs").insert({
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
  });
  if (error) throw error;

  if (d.reason || d.ptpTime) {
    const { error: extraErr } = await supabase
      .from("call_logs")
      .update({
        outcome_reason: d.reason || null,
        promise_time: d.outcome === "promised" ? (d.ptpTime ?? null) : null,
      } as never)
      .eq("id", logId);
    if (extraErr) {
      console.warn(
        `[dispositions] saved ${logId} but couldn't set reason/call-back time — ` +
          `run migrations/20260811_call_logs_outcome_reason.sql and _promise_time.sql:`,
        extraErr.message,
      );
    }
  }

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

  await refreshDispositions();
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

/** Shared by getPtpFollowups (one agent) and getTeamPtpFollowups (a manager's whole team) —
 * the "still open" logic (only the latest disposition per debtor counts) doesn't change based
 * on whose calls are being looked at. */
function computePtpFollowups(disps: DispositionRecord[]): PtpFollowup[] {
  const byDebtor = new Map<string, DispositionRecord[]>();
  for (const d of disps) {
    const list = byDebtor.get(d.debtorId);
    if (list) list.push(d);
    else byDebtor.set(d.debtorId, [d]);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows: PtpFollowup[] = [];
  for (const [debtorId, records] of byDebtor) {
    const sorted = [...records].sort(
      (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
    );
    const latest = sorted[0];
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
      prevAttempts: sorted.length - 1,
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
  return computePtpFollowups(getAgentDispositions(agentId));
}

/** Same as getPtpFollowups but across every agent on a manager's team — feeds the manager-side
 * half of the PTP miss-escalation chain (see ptp-escalation-store.ts), which needs to know
 * about overdue PTPs regardless of which of the manager's agents logged them. */
export function getTeamPtpFollowups(agentIds: string[]): PtpFollowup[] {
  const idSet = new Set(agentIds);
  return computePtpFollowups(getDispositions().filter((d) => idSet.has(d.agentId)));
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
  const found = await fetchRecordings({
    data: { providerCallIds: pending.map((r) => r.providerCallId!) },
  });

  let filled = 0;
  for (const rec of pending) {
    const url = found[rec.providerCallId!];
    if (!url) continue;
    const { error } = await supabase
      .from("call_logs")
      // Cast for the same reason as the reads above: the generated Supabase types don't
      // cover this table's columns, so writes widen to `never`.
      .update({ recording_url: url } as never)
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

/** Manager sets/edits a call's QA sentiment tag (happy/neutral/frustrated/rude) — the manual
 * audit judgment Call Audit is actually for. RLS (20260811_call_logs_sentiment.sql) restricts
 * this to managers of the calling agent's team and admins, same as the read scoping. Stamps
 * who set it and when so it reads as a real audit trail. `auditedByEmail` is the signed-in
 * manager/admin's email (same "agentId means email" convention as everywhere else in this
 * file) — resolved to agents.id here, the same way saveDisposition() resolves the caller. */
export async function setCallSentiment(
  callId: string,
  sentiment: CallSentiment,
  auditedByEmail: string,
): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const agentUuid = (agentRows ?? []).find((a) => a.email === auditedByEmail)?.id;
  if (!agentUuid) throw new Error(`No agent account found for ${auditedByEmail}`);

  const { error } = await supabase
    .from("call_logs")
    // Cast for the same reason as backfillRecordings above: the generated Supabase types
    // don't cover this table's columns, so writes widen to `never`.
    .update({
      sentiment,
      audited_by: agentUuid,
      audited_at: new Date().toISOString(),
    } as never)
    .eq("id", callId);
  if (error) throw error;
  await refreshDispositions();
}
