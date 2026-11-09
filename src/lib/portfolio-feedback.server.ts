// Loads one portfolio's feedback for the banker's file (see portfolio-feedback.ts).
//
// A manager may only download a portfolio their own RLS shows them: the check runs AS the caller,
// then the rows are read with the service role, which pages them without per-row policy cost.
import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z, tokenSchema, idSchema, isoDateSchema } from "./schemas";
import { getSupabaseAdmin, verifyCaller, type VerifiedCaller } from "./supabase-admin.server";
import { appError } from "./app-error";
import { CALL_RECORDINGS_BUCKET, parseRecordingMarker } from "./telephony/recording-marker";
import { istRangeBounds, type AuditCallRow } from "./call-audit";
import type {
  FeedbackDebtor,
  FeedbackDispute,
  FeedbackPayment,
  FeedbackSettlement,
} from "./portfolio-feedback";

/* eslint-disable @typescript-eslint/no-explicit-any -- newer tables and views than the generated types */

const PAGE = 1000;
/** A banker's copy of a recording link keeps working this long, then stops. */
const SHARE_LINK_SECONDS = 7 * 86_400;

function asCaller(accessToken: string) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("This is not available right now.");
  return createClient(url, anon, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  }) as any;
}

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

export const listFeedbackPortfolios = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ accessToken: tokenSchema }).parse(d))
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const client =
      caller.role === "auditor" ? (getSupabaseAdmin() as any) : asCaller(data.accessToken);
    const { data: rows, error } = await client
      .from("portfolios")
      .select("id, name, lender_name, total_accounts, closed_at")
      .eq("client_id", caller.clientId)
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: false });
    if (error) throw appError("SX-7202", "Could not load portfolios.", error);
    return rows as {
      id: string;
      name: string;
      lender_name: string | null;
      total_accounts: number | null;
      closed_at: string | null;
    }[];
  });

export const getPortfolioFeedbackData = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        portfolioId: idSchema,
        from: isoDateSchema,
        to: isoDateSchema,
        includeRecordingLinks: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    const reader =
      caller.role === "auditor" ? (getSupabaseAdmin() as any) : asCaller(data.accessToken);
    const { data: portfolio, error: pfErr } = await reader
      .from("portfolios")
      .select("id, name, lender_name")
      .eq("id", data.portfolioId)
      .eq("client_id", caller.clientId)
      .maybeSingle();
    if (pfErr) throw appError("SX-7203", "Could not load this portfolio.", pfErr);
    if (!portfolio) throw new Error("Portfolio not found.");

    const admin = getSupabaseAdmin() as any;
    const bounds = istRangeBounds(data.from, data.to);
    const [debtors, calls, agents] = await Promise.all([
      pageAll<FeedbackDebtor>((a, b) =>
        admin
          .from("debtors")
          .select(
            "id, name, phone_primary, loan_reference, loan_amount, outstanding_balance, dpd, lender, product_type, status, assigned_agent_id",
          )
          .eq("client_id", caller.clientId)
          .eq("portfolio_id", data.portfolioId)
          .order("id")
          .range(a, b),
      ),
      pageAll<AuditCallRow>((a, b) =>
        admin
          .from("call_audit_rows")
          .select(
            "call_id, created_at, agent_id, agent_name, agent_code, dial_mode, outcome, outcome_reason, promise_amount, promise_date, callback_date, callback_time, duration_seconds, ring_seconds, raw_notes, recording_url, debtor_id, customer_phone, team_name, manager_name, ledger_status",
          )
          .eq("client_id", caller.clientId)
          .eq("portfolio_id", data.portfolioId)
          .gte("created_at", bounds.from)
          .lt("created_at", bounds.to)
          .order("created_at")
          .range(a, b),
      ),
      pageAll<{ id: string; name: string }>((a, b) =>
        admin.from("agents").select("id, name").eq("client_id", caller.clientId).range(a, b),
      ),
    ]);

    const inPortfolio = <T>(table: string, columns: string) =>
      pageAll<T>((a, b) =>
        admin
          .from(table)
          .select(`${columns}, debtors!inner(portfolio_id)`)
          .eq("debtors.portfolio_id", data.portfolioId)
          .order("created_at")
          .range(a, b),
      );
    const [payments, settlements, disputes] = await Promise.all([
      inPortfolio<FeedbackPayment>(
        "payments",
        "debtor_id, amount, status, source, payment_method, notes, received_at, created_at",
      ),
      inPortfolio<FeedbackSettlement>(
        "settlement_requests",
        "debtor_id, original_amount, proposed_amount, status, agent_notes, created_at",
      ),
      inPortfolio<FeedbackDispute>(
        "disputes",
        "debtor_id, dispute_type, debtor_reason, agent_notes, status, created_at",
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
      agentNames: agents,
      recordingLinks,
    };
  });
