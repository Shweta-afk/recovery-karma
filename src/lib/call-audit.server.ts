// Server side of the Call Auditor portal (2026-11-09) and of the reviews agents and managers
// receive. Every read and write uses the service role after verifyCaller(), and every query is
// scoped by the caller's verified company: an auditor has no RLS access to these tables at all.
//
// Viewing the portal: auditors and admins. Writing a review: auditors only.
// Agents and managers only ever get listMyReviews(), which leaves out internal_note.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, isoDateSchema, limitSchema, offsetSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, type VerifiedCaller } from "./supabase-admin.server";
import { appError } from "./app-error";
import {
  SCORECARD_VERSION,
  MIN_AUDIT_SECONDS,
  auditHasContent,
  buildAuditQueue,
  buildTeamPerformance,
  computeScore,
  istRangeBounds,
  type AuditCallRow,
  type PerformanceRow,
  type QueueCall,
  type AuditSummary,
  type ScoreAnswers,
  type TeamReviewRow,
} from "./call-audit";

/* eslint-disable @typescript-eslint/no-explicit-any -- these tables and functions are newer than the generated types */

const text = (max = 4000) => z.string().trim().max(max).optional().nullable();
const filterSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  teamId: idSchema.optional(),
  managerId: idSchema.optional(),
  agentId: idSchema.optional(),
  portfolioId: idSchema.optional(),
  outcome: z.string().max(40).optional(),
  audit: z.enum(["pending", "ai_waiting", "audited", "fatal", "exemplary", "coaching"]).optional(),
  recording: z.enum(["yes", "no"]).optional(),
  connected: z.boolean().optional(),
  minSeconds: z.number().int().min(0).max(86_400).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "oldest", "longest", "score_high", "score_low"]).optional(),
});
type Filters = z.infer<typeof filterSchema>;

async function requireViewer(accessToken: string): Promise<VerifiedCaller> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Your session has expired — please sign in again.");
  if (caller.role !== "auditor" && caller.role !== "admin") {
    throw new Error("Only call auditors and admins can open this.");
  }
  return caller;
}

async function requireAuditor(accessToken: string): Promise<VerifiedCaller & { agentId: string }> {
  const caller = await requireViewer(accessToken);
  if (caller.role !== "auditor" || !caller.agentId) {
    throw new Error("Only a call auditor can submit reviews.");
  }
  return caller as VerifiedCaller & { agentId: string };
}

function listParams(clientId: string, f: Filters) {
  const b = istRangeBounds(f.from, f.to);
  return {
    client_id: clientId,
    from: b.from,
    to: b.to,
    team_id: f.teamId,
    manager_id: f.managerId,
    agent_id: f.agentId,
    portfolio_id: f.portfolioId,
    outcome: f.outcome,
    audit: f.audit,
    recording: f.recording,
    connected: f.connected || undefined,
    min_seconds: f.minSeconds,
    search: f.search || undefined,
    sort: f.sort,
  };
}

async function callList(params: Record<string, unknown>) {
  const { data, error } = await (getSupabaseAdmin() as any).rpc("call_audit_list", { p: params });
  if (error) throw appError("SX-7101", "Could not load calls.", error);
  return data as { rows: AuditCallRow[]; total: number | null };
}

/** Who and what can be filtered on: every team with its manager, every agent, every portfolio. */
export const getAuditOrg = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    const admin = getSupabaseAdmin() as any;
    const [teams, agents, portfolios] = await Promise.all([
      admin.from("teams").select("id, name, manager_id").eq("client_id", caller.clientId),
      admin
        .from("agents")
        .select("id, name, role, is_active")
        .eq("client_id", caller.clientId)
        .in("role", ["agent", "manager"])
        .order("name"),
      admin
        .from("portfolios")
        .select("id, name")
        .eq("client_id", caller.clientId)
        .is("deleted_at", null)
        .order("uploaded_at", { ascending: false }),
    ]);
    const failed = teams.error ?? agents.error ?? portfolios.error;
    if (failed) throw appError("SX-7102", "Could not load teams.", failed);
    const nameById = new Map<string, string>(
      (agents.data as { id: string; name: string }[]).map((a) => [a.id, a.name]),
    );
    return {
      canReview: caller.role === "auditor",
      teams: (teams.data as { id: string; name: string; manager_id: string | null }[]).map((t) => ({
        id: t.id,
        name: t.name,
        managerId: t.manager_id,
        managerName: t.manager_id ? (nameById.get(t.manager_id) ?? null) : null,
      })),
      agents: agents.data as { id: string; name: string; role: string; is_active: boolean }[],
      portfolios: portfolios.data as { id: string; name: string }[],
    };
  });

export const listAuditCalls = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        filters: filterSchema,
        limit: limitSchema.max(200),
        offset: offsetSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    return callList({
      ...listParams(caller.clientId, data.filters),
      limit: data.limit,
      offset: data.offset,
      with_total: data.offset === 0,
    });
  });

/** One page of full rows (transcript and bank-file columns included) for the Excel reports. */
export const getAuditExportPage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        filters: filterSchema,
        limit: limitSchema,
        offset: offsetSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    return callList({
      ...listParams(caller.clientId, data.filters),
      sort: "oldest",
      detail: true,
      limit: data.limit,
      offset: data.offset,
      with_total: data.offset === 0,
    });
  });

export const getAuditCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, callId: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    const { data: row, error } = await (getSupabaseAdmin() as any)
      .from("call_audit_rows")
      .select("*")
      .eq("client_id", caller.clientId)
      .eq("call_id", data.callId)
      .maybeSingle();
    if (error) throw appError("SX-7103", "Could not load this call.", error);
    if (!row) throw new Error("Call not found.");
    return row as AuditCallRow;
  });

export const getAuditSummary = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, from: isoDateSchema, to: isoDateSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    const b = istRangeBounds(data.from, data.to);
    const { data: summary, error } = await (getSupabaseAdmin() as any).rpc("call_audit_summary", {
      p: { client_id: caller.clientId, from: b.from, to: b.to },
    });
    if (error) throw appError("SX-7104", "Could not load the overview.", error);
    return summary as AuditSummary;
  });

const scoreSchema = z.record(
  z.string().max(40),
  z.object({
    value: z.enum(["yes", "partial", "no", "na"]),
    remark: z.string().max(1000).optional(),
  }),
);

export const saveCallAudit = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        callId: idSchema,
        scores: scoreSchema,
        fatalCodes: z.array(z.string().max(40)).max(20),
        sentiment: z.enum(["happy", "neutral", "frustrated", "rude"]),
        aiAgreement: z.enum(["agree", "partly", "disagree"]).optional().nullable(),
        aiComment: text(),
        exemplary: z.boolean(),
        coachingRequired: z.boolean(),
        strengths: text(),
        improvements: text(),
        feedbackAgent: z.string().trim().min(1).max(4000),
        feedbackManager: text(),
        internalNote: text(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireAuditor(data.accessToken);
    const answers = data.scores as ScoreAnswers;
    if (!auditHasContent(answers, data.fatalCodes)) {
      throw new Error("Score at least one parameter, or mark a fatal error.");
    }
    const admin = getSupabaseAdmin() as any;
    const { data: call, error: callErr } = await admin
      .from("call_audit_rows")
      .select(
        "call_id, agent_id, agent_name, team_id, manager_id, audit_id, audit_revision, customer_name",
      )
      .eq("client_id", caller.clientId)
      .eq("call_id", data.callId)
      .maybeSingle();
    if (callErr) throw appError("SX-7105", "Could not load this call.", callErr);
    if (!call) throw new Error("Call not found.");

    const s = computeScore(answers, data.fatalCodes);
    const row = {
      client_id: caller.clientId,
      call_log_id: call.call_id,
      agent_id: call.agent_id,
      auditor_id: caller.agentId,
      team_id: call.team_id,
      manager_id: call.manager_id,
      scorecard_version: SCORECARD_VERSION,
      scores: answers,
      score_earned: s.earned,
      score_possible: s.possible,
      raw_percent: s.rawPercent,
      final_percent: s.finalPercent,
      grade: s.grade,
      fatal: s.fatal,
      fatal_codes: s.fatalCodes,
      sentiment: data.sentiment,
      ai_agreement: data.aiAgreement ?? null,
      ai_comment: data.aiComment || null,
      exemplary: data.exemplary,
      coaching_required: data.coachingRequired,
      strengths: data.strengths || null,
      improvements: data.improvements || null,
      feedback_agent: data.feedbackAgent,
      feedback_manager: data.feedbackManager || null,
      internal_note: data.internalNote || null,
      revision: (call.audit_revision ?? 0) + 1,
      updated_at: new Date().toISOString(),
      // A changed review must be read again.
      agent_ack_at: null,
      agent_response: null,
      manager_seen_at: null,
    };
    const { error } = await admin.from("call_audits").upsert(row, { onConflict: "call_log_id" });
    if (error) throw appError("SX-7106", "Could not save this review.", error);

    const { data: me } = await admin
      .from("agents")
      .select("name")
      .eq("id", caller.agentId)
      .single();
    const fromName = (me?.name as string | undefined) ?? "Call Auditor";
    const who = call.customer_name ? ` on ${call.customer_name}` : "";
    const notices = [
      {
        client_id: caller.clientId,
        to_agent_id: call.agent_id,
        from_name: fromName,
        message: `Your call${who} was reviewed: ${s.finalPercent}% (${s.grade}). See My Call Reviews.`,
      },
      ...(call.manager_id && call.manager_id !== call.agent_id
        ? [
            {
              client_id: caller.clientId,
              to_agent_id: call.manager_id,
              from_name: fromName,
              message: `${call.agent_name}'s call${who} was reviewed: ${s.finalPercent}% (${s.grade}).`,
            },
          ]
        : []),
    ];
    // The review is saved either way; a missed notice must not report the save as failed.
    await admin
      .from("notifications")
      .insert(notices)
      .then(({ error: e }: { error: unknown }) => {
        if (e) console.warn("[call-audit] notification failed:", e);
      });
    return { ok: true as const, score: s };
  });

function withNames(rows: any[], nameById: Map<string, string>): TeamReviewRow[] {
  return rows.map((r) => ({
    ...r,
    manager_name: r.manager_id ? (nameById.get(r.manager_id) ?? null) : null,
    auditor_name: r.auditor_id ? (nameById.get(r.auditor_id) ?? null) : null,
  }));
}

async function agentNames(clientId: string) {
  const { data } = await (getSupabaseAdmin() as any)
    .from("agents")
    .select("id, name")
    .eq("client_id", clientId);
  return new Map<string, string>((data ?? []).map((a: any) => [a.id, a.name]));
}

export const saveTeamReview = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        teamId: idSchema,
        from: isoDateSchema,
        to: isoDateSchema,
        rating: z.number().int().min(1).max(5),
        summary: z.string().trim().min(1).max(4000),
        strengths: text(),
        improvements: text(),
        actionItems: text(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireAuditor(data.accessToken);
    const admin = getSupabaseAdmin() as any;
    const { data: team } = await admin
      .from("teams")
      .select("id, name, manager_id")
      .eq("id", data.teamId)
      .eq("client_id", caller.clientId)
      .maybeSingle();
    if (!team) throw new Error("Team not found.");
    const { error } = await admin.from("team_audit_reviews").insert({
      client_id: caller.clientId,
      team_id: team.id,
      team_name: team.name,
      manager_id: team.manager_id,
      auditor_id: caller.agentId,
      period_from: data.from,
      period_to: data.to,
      rating: data.rating,
      summary: data.summary,
      strengths: data.strengths || null,
      improvements: data.improvements || null,
      action_items: data.actionItems || null,
    });
    if (error) throw appError("SX-7107", "Could not save this review.", error);
    if (team.manager_id) {
      const { data: me } = await admin
        .from("agents")
        .select("name")
        .eq("id", caller.agentId)
        .single();
      await admin
        .from("notifications")
        .insert({
          client_id: caller.clientId,
          to_agent_id: team.manager_id,
          from_name: me?.name ?? "Call Auditor",
          message: `New review of ${team.name}: ${data.rating}/5. Open Call Audit → Reviews.`,
        })
        .then(({ error: e }: { error: unknown }) => {
          if (e) console.warn("[call-audit] notification failed:", e);
        });
    }
    return { ok: true as const };
  });

export const listTeamReviews = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, from: isoDateSchema, to: isoDateSchema }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    const b = istRangeBounds(data.from, data.to);
    const { data: rows, error } = await (getSupabaseAdmin() as any)
      .from("team_audit_reviews")
      .select("*")
      .eq("client_id", caller.clientId)
      .gte("created_at", b.from)
      .lt("created_at", b.to)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) throw appError("SX-7108", "Could not load reviews.", error);
    return withNames(rows, await agentNames(caller.clientId));
  });

/** Presence intervals for the Performance report. Only what agents actually recorded. */
export const getAuditPresence = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        from: isoDateSchema,
        to: isoDateSchema,
        limit: limitSchema,
        offset: offsetSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    const b = istRangeBounds(data.from, data.to);
    const { data: rows, error } = await (getSupabaseAdmin() as any)
      .from("agent_status_log")
      .select("agent_id, status, started_at, ended_at")
      .eq("client_id", caller.clientId)
      .gte("started_at", b.from)
      .lt("started_at", b.to)
      .order("started_at")
      .range(data.offset, data.offset + data.limit - 1);
    if (error) throw appError("SX-7109", "Could not load agent time.", error);
    return rows as {
      agent_id: string;
      status: string;
      started_at: string;
      ended_at: string | null;
    }[];
  });

/* ─── what agents and managers receive ──────────────────────────────────────── */

export interface ReceivedAudit {
  id: string;
  call_id: string;
  created_at: string;
  updated_at: string;
  agent_id: string | null;
  agent_name: string;
  customer_name: string | null;
  loan_reference: string | null;
  call_time: string;
  outcome: string;
  duration_seconds: number | null;
  recording_url: string | null;
  scores: ScoreAnswers;
  final_percent: number;
  grade: string;
  fatal: boolean;
  fatal_codes: string[];
  strengths: string | null;
  improvements: string | null;
  feedback_agent: string | null;
  /** Empty for the agent themself: this one is addressed to the manager. */
  feedback_manager: string | null;
  auditor_name: string | null;
  agent_ack_at: string | null;
  agent_response: string | null;
}

const RECEIVED_LIMIT = 200;

export const listMyReviews = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, teamId: idSchema.optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller?.agentId) throw new Error("Your session has expired — please sign in again.");
    if (caller.role !== "agent" && caller.role !== "manager") {
      throw new Error("Call reviews are shown to agents and managers.");
    }
    const admin = getSupabaseAdmin() as any;
    const isManager = caller.role === "manager";
    let q = admin
      .from("call_audits")
      .select("*")
      .eq("client_id", caller.clientId)
      .order("updated_at", { ascending: false })
      .limit(RECEIVED_LIMIT);
    // A manager sees audits of their team's calls AND their own calls, if they dial.
    q = isManager
      ? q.or(`manager_id.eq.${caller.agentId},agent_id.eq.${caller.agentId}`)
      : q.eq("agent_id", caller.agentId);
    if (isManager && data.teamId) q = q.eq("team_id", data.teamId);
    const { data: audits, error } = await q;
    if (error) throw appError("SX-7110", "Could not load your reviews.", error);

    const callIds = (audits as any[]).map((a) => a.call_log_id);
    const [{ data: calls }, names] = await Promise.all([
      callIds.length
        ? admin
            .from("call_audit_rows")
            .select(
              "call_id, created_at, customer_name, loan_reference, outcome, duration_seconds, recording_url",
            )
            .eq("client_id", caller.clientId)
            .in("call_id", callIds)
        : Promise.resolve({ data: [] }),
      agentNames(caller.clientId),
    ]);
    const callById = new Map<string, any>((calls ?? []).map((c: any) => [c.call_id, c]));

    const reviews: ReceivedAudit[] = (audits as any[]).map((a) => {
      const c = callById.get(a.call_log_id);
      return {
        id: a.id,
        call_id: a.call_log_id,
        created_at: a.created_at,
        updated_at: a.updated_at,
        agent_id: a.agent_id,
        agent_name: a.agent_id ? (names.get(a.agent_id) ?? "") : "",
        customer_name: c?.customer_name ?? null,
        loan_reference: c?.loan_reference ?? null,
        call_time: c?.created_at ?? a.created_at,
        outcome: c?.outcome ?? "",
        duration_seconds: c?.duration_seconds ?? null,
        recording_url: c?.recording_url ?? null,
        scores: a.scores,
        final_percent: Number(a.final_percent),
        grade: a.grade,
        fatal: a.fatal,
        fatal_codes: a.fatal_codes,
        strengths: a.strengths,
        improvements: a.improvements,
        feedback_agent: a.feedback_agent,
        feedback_manager: isManager && a.manager_id === caller.agentId ? a.feedback_manager : null,
        auditor_name: a.auditor_id ? (names.get(a.auditor_id) ?? null) : null,
        agent_ack_at: a.agent_ack_at,
        agent_response: a.agent_response,
      };
    });

    let teamReviews: TeamReviewRow[] = [];
    if (isManager) {
      let teamQuery = admin
        .from("team_audit_reviews")
        .select("*")
        .eq("client_id", caller.clientId)
        .eq("manager_id", caller.agentId)
        .order("created_at", { ascending: false })
        .limit(RECEIVED_LIMIT);
      if (data.teamId) teamQuery = teamQuery.eq("team_id", data.teamId);
      const { data: rows, error: teamErr } = await teamQuery;
      if (teamErr) throw appError("SX-7111", "Could not load your reviews.", teamErr);
      teamReviews = withNames(rows, names);
    }

    // Opening the page is what "seen by the manager" means.
    if (isManager) {
      const unseen = (audits as any[])
        .filter((a) => a.manager_id === caller.agentId && !a.manager_seen_at)
        .map((a) => a.id);
      if (unseen.length) {
        await admin
          .from("call_audits")
          .update({ manager_seen_at: new Date().toISOString() })
          .in("id", unseen);
      }
    }
    return { myAgentId: caller.agentId, isManager, reviews, teamReviews };
  });

/** The audited agent signs off on their own review, with an optional reply. */
export const acknowledgeReview = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, auditId: idSchema, response: text(2000) }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller?.agentId) throw new Error("Your session has expired — please sign in again.");
    const { data: updated, error } = await (getSupabaseAdmin() as any)
      .from("call_audits")
      .update({ agent_ack_at: new Date().toISOString(), agent_response: data.response || null })
      .eq("id", data.auditId)
      .eq("client_id", caller.clientId)
      .eq("agent_id", caller.agentId)
      .select("id");
    if (error) throw appError("SX-7112", "Could not save your reply.", error);
    if (!updated?.length) throw new Error("Review not found.");
    return { ok: true as const };
  });

export const acknowledgeTeamReview = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z.object({ accessToken: tokenSchema, reviewId: idSchema, response: text(2000) }).parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await verifyCaller(data.accessToken);
    if (!caller?.agentId) throw new Error("Your session has expired — please sign in again.");
    const { data: updated, error } = await (getSupabaseAdmin() as any)
      .from("team_audit_reviews")
      .update({
        acknowledged_at: new Date().toISOString(),
        manager_response: data.response || null,
      })
      .eq("id", data.reviewId)
      .eq("client_id", caller.clientId)
      .eq("manager_id", caller.agentId)
      .select("id");
    if (error) throw appError("SX-7113", "Could not save your reply.", error);
    if (!updated?.length) throw new Error("Review not found.");
    return { ok: true as const };
  });

/* ─── a manager's own team ─────────────────────────────────────────────────────
 *
 * Every query below is pinned to manager_id = the verified caller. A team id from the browser
 * can only narrow that, never widen it. Columns are listed by name so internal_note cannot reach
 * a manager even by accident.
 */

const MANAGER_COLUMNS = [
  "call_id, created_at, agent_id, agent_name, agent_code, team_id, team_name, manager_id, manager_name",
  "call_type, dial_mode, outcome, outcome_reason, promise_amount, promise_date, callback_date, callback_time",
  "duration_seconds, raw_notes, recording_url, recording_status, ledger_status",
  "customer_name, customer_phone, loan_reference, dpd, lender, portfolio_id, portfolio_name, portfolio_lender",
  "manager_sentiment, manager_audited_by, manager_audited_at",
  "ai_agent_tone, ai_debtor_tone, ai_sentiment, ai_sentiment_confidence, ai_sentiment_reasoning, ai_sentiment_analyzed_at",
  "audit_id, auditor_name, scores, score_earned, score_possible, raw_percent, final_percent, grade, fatal, fatal_codes",
  "audit_sentiment, ai_agreement, ai_comment, exemplary, coaching_required, strengths, improvements",
  "feedback_agent, feedback_manager, agent_ack_at, agent_response, manager_seen_at, audit_revision, audit_created_at, audit_updated_at",
].join(", ");

const managerFilterSchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  teamId: idSchema.optional(),
  agentId: idSchema.optional(),
  outcome: z.string().max(40).optional(),
  audit: z.enum(["pending", "audited", "fatal", "exemplary", "coaching"]).optional(),
  managerTag: z.enum(["none", "happy", "neutral", "frustrated", "rude"]).optional(),
  caller: z.enum(["agent", "ai"]).optional(),
  bucket: z.enum(["X", "1", "2", "NPA", "WriteOff"]).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(["newest", "oldest", "longest", "score_high", "score_low"]).optional(),
});
type ManagerFilters = z.infer<typeof managerFilterSchema>;

async function requireManager(accessToken: string): Promise<VerifiedCaller & { agentId: string }> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Your session has expired — please sign in again.");
  if (caller.role !== "manager" || !caller.agentId) {
    throw new Error("Call Audit shows a manager their own team.");
  }
  return caller as VerifiedCaller & { agentId: string };
}

const DPD_BANDS: Record<NonNullable<ManagerFilters["bucket"]>, [number, number | null]> = {
  X: [0, 0],
  "1": [1, 30],
  "2": [31, 90],
  NPA: [91, 179],
  WriteOff: [180, null],
};

function managerQuery(
  caller: VerifiedCaller & { agentId: string },
  f: ManagerFilters,
  columns: string,
  options?: { count: "exact" },
) {
  const b = istRangeBounds(f.from, f.to);
  let q = (getSupabaseAdmin() as any)
    .from("call_audit_rows")
    .select(columns, options)
    .eq("client_id", caller.clientId)
    .eq("manager_id", caller.agentId)
    .gte("created_at", b.from)
    .lt("created_at", b.to);
  if (f.teamId) q = q.eq("team_id", f.teamId);
  if (f.agentId) q = q.eq("agent_id", f.agentId);
  if (f.outcome) q = q.eq("outcome", f.outcome);
  if (f.audit === "pending") q = q.is("audit_id", null);
  if (f.audit === "audited") q = q.not("audit_id", "is", null);
  if (f.audit === "fatal") q = q.eq("fatal", true);
  if (f.audit === "exemplary") q = q.eq("exemplary", true);
  if (f.audit === "coaching") q = q.eq("coaching_required", true);
  if (f.managerTag === "none") q = q.is("manager_sentiment", null);
  else if (f.managerTag) q = q.eq("manager_sentiment", f.managerTag);
  if (f.caller === "ai") q = q.in("call_type", ["ai", "bot"]);
  if (f.caller === "agent") q = q.eq("call_type", "human");
  if (f.bucket) {
    const [low, high] = DPD_BANDS[f.bucket];
    q = q.gte("dpd", low);
    if (high !== null) q = q.lte("dpd", high);
  }
  // Characters that mean something to the filter syntax are dropped, not escaped.
  const search = f.search?.replace(/[,()*%"\\:.]/g, " ").trim();
  if (search) {
    q = q.or(
      ["customer_name", "customer_phone", "loan_reference", "agent_name"]
        .map((c) => `${c}.ilike.*${search}*`)
        .join(","),
    );
  }
  return q;
}

function sorted(q: any, sort: ManagerFilters["sort"]) {
  if (sort === "oldest") return q.order("created_at", { ascending: true });
  if (sort === "longest") {
    return q
      .order("duration_seconds", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
  }
  if (sort === "score_high" || sort === "score_low") {
    return q
      .order("final_percent", { ascending: sort === "score_low", nullsFirst: false })
      .order("created_at", { ascending: false });
  }
  return q.order("created_at", { ascending: false });
}

/** The manager's teams and the people on them, for the page's filters. */
export const getManagerScope = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireManager(data.accessToken);
    const admin = getSupabaseAdmin() as any;
    const { data: teams, error } = await admin
      .from("teams")
      .select("id, name")
      .eq("client_id", caller.clientId)
      .eq("manager_id", caller.agentId);
    if (error) throw appError("SX-7114", "Could not load your team.", error);
    const teamIds = (teams as { id: string }[]).map((t) => t.id);
    const { data: links, error: linkErr } = teamIds.length
      ? await admin.from("team_agents").select("team_id, agent_id").in("team_id", teamIds)
      : { data: [], error: null };
    if (linkErr) throw appError("SX-7115", "Could not load your team.", linkErr);
    const ids = [...new Set((links as { agent_id: string }[]).map((l) => l.agent_id))];
    const names = await agentNames(caller.clientId);
    return {
      teams: teams as { id: string; name: string }[],
      agents: ids
        .map((id) => ({
          id,
          name: names.get(id) ?? "",
          teamIds: (links as { team_id: string; agent_id: string }[])
            .filter((l) => l.agent_id === id)
            .map((l) => l.team_id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

export const listManagerCalls = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        filters: managerFilterSchema,
        limit: limitSchema.max(200),
        offset: offsetSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireManager(data.accessToken);
    const query = managerQuery(
      caller,
      data.filters,
      MANAGER_COLUMNS,
      data.offset === 0 ? { count: "exact" } : undefined,
    );
    const {
      data: rows,
      error,
      count,
    } = await sorted(query, data.filters.sort).range(data.offset, data.offset + data.limit - 1);
    if (error) throw appError("SX-7116", "Could not load calls.", error);
    return { rows: rows as AuditCallRow[], total: (count ?? null) as number | null };
  });

export const getManagerCall = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema, callId: idSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireManager(data.accessToken);
    const { data: row, error } = await (getSupabaseAdmin() as any)
      .from("call_audit_rows")
      .select(`${MANAGER_COLUMNS}, ai_transcript`)
      .eq("client_id", caller.clientId)
      .eq("manager_id", caller.agentId)
      .eq("call_id", data.callId)
      .maybeSingle();
    if (error) throw appError("SX-7117", "Could not load this call.", error);
    if (!row) throw new Error("This call is not on your team.");
    return row as AuditCallRow;
  });

/** The manager's own tone tag. Separate from the auditor's score, which they cannot change. */
export const setManagerTone = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        callId: idSchema,
        sentiment: z.enum(["happy", "neutral", "frustrated", "rude"]),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireManager(data.accessToken);
    const admin = getSupabaseAdmin() as any;
    const { data: call } = await admin
      .from("call_audit_rows")
      .select("call_id")
      .eq("client_id", caller.clientId)
      .eq("manager_id", caller.agentId)
      .eq("call_id", data.callId)
      .maybeSingle();
    if (!call) throw new Error("This call is not on your team.");
    const { error } = await admin
      .from("call_logs")
      .update({
        sentiment: data.sentiment,
        audited_by: caller.agentId,
        audited_at: new Date().toISOString(),
      })
      .eq("id", data.callId);
    if (error) throw appError("SX-7118", "Could not save your tag.", error);
    return { ok: true as const };
  });

const PAGE_ROWS = 1000;

async function everyPage<T>(
  fetchPage: (from: number, to: number) => PromiseLike<any>,
  code: string,
) {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE_ROWS) {
    const { data, error } = await fetchPage(from, from + PAGE_ROWS - 1);
    if (error) throw appError(code, "Could not load this report.", error);
    out.push(...(data as T[]));
    if ((data as T[]).length < PAGE_ROWS) return out;
  }
}

export const getManagerPerformance = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        from: isoDateSchema,
        to: isoDateSchema,
        teamId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireManager(data.accessToken);
    const rows = await everyPage<PerformanceRow>(
      (from, to) =>
        managerQuery(
          caller,
          { from: data.from, to: data.to, teamId: data.teamId },
          "call_id, created_at, agent_id, agent_name, outcome, ledger_status, duration_seconds, audit_id, final_percent, fatal, coaching_required, exemplary, scores",
        )
          .order("created_at")
          .order("call_id")
          .range(from, to),
      "SX-7119",
    );
    return buildTeamPerformance(rows);
  });

/** Reviewed calls only: the rows of the manager's Audit + Feedback download. */
export const getManagerExportPage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        from: isoDateSchema,
        to: isoDateSchema,
        teamId: idSchema.optional(),
        limit: limitSchema,
        offset: offsetSchema,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireManager(data.accessToken);
    const { data: rows, error } = await managerQuery(
      caller,
      { from: data.from, to: data.to, teamId: data.teamId, audit: "audited" },
      MANAGER_COLUMNS,
    )
      .order("created_at")
      .order("call_id")
      .range(data.offset, data.offset + data.limit - 1);
    if (error) throw appError("SX-7120", "Could not load this report.", error);
    return rows as AuditCallRow[];
  });

/* ─── the auditor's queue ───────────────────────────────────────────────────── */

export const getAuditQueue = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        from: isoDateSchema,
        to: isoDateSchema,
        target: z.number().int().min(1).max(200),
        teamId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireViewer(data.accessToken);
    const b = istRangeBounds(data.from, data.to);
    const admin = getSupabaseAdmin() as any;
    const calls = await everyPage<QueueCall>((from, to) => {
      let q = admin
        .from("call_audit_rows")
        .select(
          "call_id, agent_id, agent_name, team_name, created_at, customer_name, loan_reference, outcome, duration_seconds, recording_url, ai_sentiment, audit_id",
        )
        .eq("client_id", caller.clientId)
        .gte("created_at", b.from)
        .lt("created_at", b.to)
        .gte("duration_seconds", MIN_AUDIT_SECONDS);
      if (data.teamId) q = q.eq("team_id", data.teamId);
      return q.order("created_at").order("call_id").range(from, to);
    }, "SX-7121");
    return { canReview: caller.role === "auditor", agents: buildAuditQueue(calls, data.target) };
  });
