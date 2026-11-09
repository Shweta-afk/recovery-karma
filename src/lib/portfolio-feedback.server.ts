// Loads one portfolio's feedback for the banker's file (see portfolio-feedback.ts).
//
// Who gets which portfolios, enforced here on every request: a manager only those on their own
// teams; admins and call auditors every portfolio of their company. Rows are read with the service
// role and always scoped to the caller's company.
import { createServerFn } from "@tanstack/react-start";
import { z, tokenSchema, idSchema, isoDateSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, type VerifiedCaller } from "./supabase-admin.server";
import { appError } from "./app-error";
import { CALL_RECORDINGS_BUCKET, parseRecordingMarker } from "./telephony/recording-marker";
import { istDayKeyDaysAgo, istRangeBounds, type AuditCallRow } from "./call-audit";
import {
  linkEarlierRows,
  loanKey,
  matchManualCalls,
  mergeLoanRows,
  phoneKey,
  phoneKeysOf,
  type FeedbackCall,
  type FeedbackDebtor,
  type FeedbackDispute,
  type FeedbackMessage,
  type FeedbackPayment,
  type FeedbackReminder,
  type FeedbackRetention,
  type FeedbackSettlement,
} from "./portfolio-feedback";

/* eslint-disable @typescript-eslint/no-explicit-any -- newer tables and views than the generated types */

const PAGE = 1000;
const CONCURRENT_CHUNKS = 4;
/** A banker's copy of a recording link keeps working this long, then stops. */
const SHARE_LINK_SECONDS = 7 * 86_400;

async function requireCaller(accessToken: string): Promise<VerifiedCaller> {
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Your session has expired — please sign in again.");
  if (caller.role !== "manager" && caller.role !== "admin" && caller.role !== "auditor") {
    throw new Error("Only managers, admins and call auditors can download feedback files.");
  }
  return caller;
}

async function pageAll<T>(fetchPage: (from: number, to: number) => PromiseLike<any>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await fetchPage(from, from + PAGE - 1);
    if (error) throw appError("SX-7201", "Could not load the feedback file.", error);
    out.push(...(data as T[]));
    if ((data as T[]).length < PAGE) return out;
  }
}

/** Runs `fetch` over chunks of `items`, a few at a time, and joins the results in order. */
async function inChunks<I, T>(
  items: I[],
  size: number,
  fetch: (chunk: I[]) => Promise<T[]>,
): Promise<T[]> {
  const chunks: I[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const out: T[][] = [];
  for (let i = 0; i < chunks.length; i += CONCURRENT_CHUNKS) {
    out.push(...(await Promise.all(chunks.slice(i, i + CONCURRENT_CHUNKS).map(fetch))));
  }
  return out.flat();
}

type OtherRow = Pick<
  FeedbackDebtor,
  "id" | "name" | "phone_primary" | "phone_alternate" | "alt_phones" | "loan_reference"
> & { portfolio_id: string | null };

/** Limits a portfolios query to what this caller may download. */
async function portfolioScope(caller: VerifiedCaller) {
  if (caller.role !== "manager") return (q: any) => q;
  if (!caller.agentId) throw new Error("Your session has expired — please sign in again.");
  const { data: teams, error } = await (getSupabaseAdmin() as any)
    .from("teams")
    .select("id")
    .eq("client_id", caller.clientId)
    .eq("manager_id", caller.agentId);
  if (error) throw appError("SX-7204", "Could not load your teams.", error);
  const ids = (teams as { id: string }[]).map((t) => t.id);
  const mine = ids.length
    ? `manager_id.eq.${caller.agentId},team_id.in.(${ids.join(",")})`
    : `manager_id.eq.${caller.agentId}`;
  return (q: any) => q.or(mine);
}

export const listFeedbackPortfolios = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const admin = getSupabaseAdmin() as any;
    const inScope = await portfolioScope(caller);
    const [portfolios, teams, agents] = await Promise.all([
      pageAll<{
        id: string;
        name: string;
        lender_name: string | null;
        total_accounts: number | null;
        closed_at: string | null;
        team_id: string | null;
      }>((a, b) =>
        inScope(
          admin
            .from("portfolios")
            .select("id, name, lender_name, total_accounts, closed_at, team_id")
            .eq("client_id", caller.clientId)
            .is("deleted_at", null),
        )
          .order("uploaded_at", { ascending: false })
          .order("id")
          .range(a, b),
      ),
      pageAll<{ id: string; name: string; manager_id: string | null }>((a, b) =>
        admin
          .from("teams")
          .select("id, name, manager_id")
          .eq("client_id", caller.clientId)
          .order("id")
          .range(a, b),
      ),
      pageAll<{ id: string; name: string }>((a, b) =>
        admin
          .from("agents")
          .select("id, name")
          .eq("client_id", caller.clientId)
          .order("id")
          .range(a, b),
      ),
    ]);
    const teamById = new Map(teams.map((t) => [t.id, t]));
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return portfolios.map((p) => {
      const team = p.team_id ? teamById.get(p.team_id) : undefined;
      return {
        ...p,
        team_name: team?.name ?? null,
        manager_name: team?.manager_id ? (nameById.get(team.manager_id) ?? null) : null,
      };
    });
  });

export const getPortfolioFeedbackData = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        portfolioId: idSchema,
        // Both left out: every piece of feedback ever recorded on these loans.
        from: isoDateSchema.optional(),
        to: isoDateSchema.optional(),
        includeRecordingLinks: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const inScope = await portfolioScope(caller);
    const { data: portfolio, error: pfErr } = await inScope(
      (getSupabaseAdmin() as any)
        .from("portfolios")
        .select("id, name, lender_name")
        .eq("id", data.portfolioId)
        .eq("client_id", caller.clientId)
        .is("deleted_at", null),
    ).maybeSingle();
    if (pfErr) throw appError("SX-7203", "Could not load this portfolio.", pfErr);
    if (!portfolio) throw new Error("This portfolio isn't available to you.");

    const admin = getSupabaseAdmin() as any;
    // No dates means everything: the earliest call on the platform is years after this.
    const bounds = istRangeBounds(data.from ?? "2000-01-01", data.to ?? istDayKeyDaysAgo(0));
    const callColumns =
      "call_id, created_at, agent_id, agent_name, agent_code, dial_mode, outcome, outcome_reason, promise_amount, promise_date, callback_date, callback_time, duration_seconds, ring_seconds, raw_notes, recording_url, debtor_id, customer_phone, team_name, manager_name, ledger_status";

    const [rawDebtors, portfolioCalls, agents, manualCalls, deletedPortfolios] = await Promise.all([
      pageAll<FeedbackDebtor>((a, b) =>
        admin
          .from("debtors")
          .select(
            "id, name, phone_primary, phone_alternate, alt_phones, loan_reference, loan_amount, outstanding_balance, dpd, lender, product_type, status, assigned_agent_id",
          )
          .eq("client_id", caller.clientId)
          .eq("portfolio_id", data.portfolioId)
          .order("id")
          .range(a, b),
      ),
      pageAll<AuditCallRow>((a, b) =>
        admin
          .from("call_audit_rows")
          .select(callColumns)
          .eq("client_id", caller.clientId)
          .eq("portfolio_id", data.portfolioId)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.to)
          .order("created_at")
          .order("call_id")
          .range(a, b),
      ),
      pageAll<{ id: string; name: string }>((a, b) =>
        admin
          .from("agents")
          .select("id, name")
          .eq("client_id", caller.clientId)
          .order("id")
          .range(a, b),
      ),
      pageAll<AuditCallRow>((a, b) =>
        admin
          .from("call_audit_rows")
          .select(callColumns)
          .eq("client_id", caller.clientId)
          .is("debtor_id", null)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.to)
          .order("created_at")
          .order("call_id")
          .range(a, b),
      ),
      pageAll<{ id: string }>((a, b) =>
        admin
          .from("portfolios")
          .select("id")
          .eq("client_id", caller.clientId)
          .not("deleted_at", "is", null)
          .order("id")
          .range(a, b),
      ),
    ]);

    const { loans: debtors, canonicalOf } = mergeLoanRows(rawDebtors);

    // The same loans on other uploads.
    const deleted = new Set(deletedPortfolios.map((p) => p.id));
    const references = [
      ...new Set(rawDebtors.map((d) => d.loan_reference?.trim()).filter(Boolean)),
    ] as string[];
    const otherRows = (
      await inChunks(references, 200, (chunk) =>
        pageAll<OtherRow>((a, b) =>
          admin
            .from("debtors")
            .select(
              "id, name, phone_primary, phone_alternate, alt_phones, loan_reference, portfolio_id",
            )
            .eq("client_id", caller.clientId)
            .in("loan_reference", chunk)
            .order("id")
            .range(a, b),
        ),
      )
    ).filter((o) => o.portfolio_id !== data.portfolioId && !deleted.has(o.portfolio_id ?? ""));
    const earlier = linkEarlierRows(debtors, otherRows);
    const earlierIds = [...earlier.keys()];
    for (const [id, loanId] of earlier) canonicalOf.set(id, loanId);

    const earlierCalls = await inChunks(earlierIds, 200, (chunk) =>
      pageAll<AuditCallRow>((a, b) =>
        admin
          .from("call_audit_rows")
          .select(callColumns)
          .eq("client_id", caller.clientId)
          .in("debtor_id", chunk)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.to)
          .order("created_at")
          .order("call_id")
          .range(a, b),
      ),
    );

    // Who else holds each number that a manual call dialled.
    const dialled = [
      ...new Set(
        manualCalls.map((c) => phoneKey(c.customer_phone)).filter((k): k is string => !!k),
      ),
    ];
    const matched = new Set(debtors.flatMap(phoneKeysOf));
    const relevant = dialled.filter((k) => matched.has(k));
    const holders = await inChunks(relevant, 50, (chunk) =>
      pageAll<{
        phone_primary: string | null;
        loan_reference: string | null;
        portfolio_id: string | null;
      }>((a, b) =>
        admin
          .from("debtors")
          .select("phone_primary, loan_reference, portfolio_id")
          .eq("client_id", caller.clientId)
          .in(
            "phone_primary",
            chunk.flatMap((k) => [k, `91${k}`, `+91${k}`, `0${k}`]),
          )
          .order("id")
          .range(a, b),
      ),
    );
    const loansByNumber = new Map<string, Set<string>>();
    for (const h of holders) {
      if (deleted.has(h.portfolio_id ?? "")) continue;
      const key = phoneKey(h.phone_primary);
      const loan = loanKey(h.loan_reference);
      if (!key || !loan) continue;
      const owners = loansByNumber.get(key) ?? new Set<string>();
      owners.add(loan);
      loansByNumber.set(key, owners);
    }

    const toLoan = <T extends { debtor_id: string | null }>(row: T) => ({
      ...row,
      debtor_id: canonicalOf.get(row.debtor_id ?? "") ?? row.debtor_id,
    });
    const calls: FeedbackCall[] = [
      ...portfolioCalls.map(toLoan),
      ...earlierCalls.map((c) => ({ ...toLoan(c), link: "earlier_allocation" as const })),
      ...matchManualCalls(manualCalls, debtors, loansByNumber),
    ];

    const everyRow = [...rawDebtors.map((d) => d.id), ...earlierIds];
    const related = async <T extends { debtor_id: string }>(
      table: string,
      columns: string,
      order: string,
    ) =>
      (
        await inChunks(everyRow, 200, (chunk) =>
          pageAll<T>((a, b) =>
            admin
              .from(table)
              .select(columns)
              .in("debtor_id", chunk)
              .order(order)
              .order("id")
              .range(a, b),
          ),
        )
      ).map(toLoan) as T[];
    const [payments, settlements, disputes, messages, retentions, reminders] = await Promise.all([
      related<FeedbackPayment>(
        "payments",
        "debtor_id, amount, status, source, payment_method, notes, received_at, created_at",
        "created_at",
      ),
      related<FeedbackSettlement>(
        "settlement_requests",
        "debtor_id, original_amount, proposed_amount, status, agent_notes, created_at",
        "created_at",
      ),
      related<FeedbackDispute>(
        "disputes",
        "debtor_id, dispute_type, debtor_reason, agent_notes, status, created_at",
        "created_at",
      ),
      related<FeedbackMessage>(
        "messages",
        "debtor_id, channel, direction, content, status, sent_at",
        "sent_at",
      ),
      related<FeedbackRetention>(
        "retention_requests",
        "debtor_id, reason, status, created_at",
        "created_at",
      ),
      related<FeedbackReminder>(
        "reminders",
        "debtor_id, kind, amount, due_date, due_time, message, created_at",
        "created_at",
      ),
    ]);

    const recordingLinks: Record<string, string> = {};
    if (data.includeRecordingLinks) {
      const withRecording = calls.filter((c) => c.recording_url);
      const objects = new Map<string, string>();
      const ledgerIds = withRecording
        .map((c) => parseRecordingMarker(c.recording_url))
        .filter((id): id is string => !!id);
      for (let i = 0; i < ledgerIds.length; i += 200) {
        const { data: rows } = await admin
          .from("telephony_calls")
          .select("id, recording_object")
          .eq("client_id", caller.clientId)
          .in("id", ledgerIds.slice(i, i + 200));
        for (const r of rows ?? []) if (r.recording_object) objects.set(r.id, r.recording_object);
      }
      const paths = [...objects.values()];
      const urlByPath = new Map<string, string>();
      for (let i = 0; i < paths.length; i += 500) {
        const { data: signed } = await admin.storage
          .from(CALL_RECORDINGS_BUCKET)
          .createSignedUrls(paths.slice(i, i + 500), SHARE_LINK_SECONDS);
        for (const s of signed ?? []) if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
      }
      for (const c of withRecording) {
        const ledgerId = parseRecordingMarker(c.recording_url);
        if (!ledgerId) {
          recordingLinks[c.call_id] = c.recording_url as string;
          continue;
        }
        const url = urlByPath.get(objects.get(ledgerId) ?? "");
        if (url) recordingLinks[c.call_id] = url;
      }
    }

    return {
      portfolioName: portfolio.name as string,
      lenderName: (portfolio.lender_name as string | null) ?? null,
      debtors,
      calls,
      payments,
      settlements,
      disputes,
      messages,
      retentions,
      reminders,
      agentNames: agents,
      recordingLinks,
    };
  });
