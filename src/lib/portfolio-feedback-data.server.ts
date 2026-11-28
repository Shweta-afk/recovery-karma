// Loads one portfolio's feedback for the banker's file (see portfolio-feedback.ts). Plain server
// module: used by the Feedback File download (after its access checks) and by scheduled feedback
// emails. Callers have already decided the company may see this portfolio.
import { getSupabaseAdmin } from "./supabase-admin.server";
import { appError } from "./app-error";
import { parseRecordingMarker } from "./telephony/recording-marker";
import { RECORDING_LINK_PATH_PREFIX, recordingLinkToken } from "./recording-share-link.server";
import { companyAppLink } from "./billing-delivery";
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
  type PtpMark,
} from "./portfolio-feedback";

/* eslint-disable @typescript-eslint/no-explicit-any -- newer tables and views than the generated types */

const PAGE = 1000;
const CONCURRENT_CHUNKS = 4;
/** A banker's copy of a recording link keeps working this long, then stops. */
const SHARE_LINK_SECONDS = 7 * 86_400;

export async function pageAll<T>(
  fetchPage: (from: number, to: number) => PromiseLike<any>,
): Promise<T[]> {
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

export async function loadPortfolioFeedback(
  clientId: string,
  portfolio: { id: string; name: string; lender_name: string | null },
  opts: { from?: string; to?: string; includeRecordingLinks: boolean },
) {
  const admin = getSupabaseAdmin() as any;
  // No dates means everything: the earliest call on the platform is years after this.
  const bounds = istRangeBounds(opts.from ?? "2000-01-01", opts.to ?? istDayKeyDaysAgo(0));
  const callColumns =
    "call_id, created_at, agent_id, agent_name, agent_code, dial_mode, outcome, outcome_reason, promise_amount, promise_date, callback_date, callback_time, duration_seconds, ring_seconds, raw_notes, recording_url, debtor_id, customer_phone, team_name, manager_name, ledger_status, did_number, ended_by";

  const [rawDebtors, portfolioCalls, agents, manualCalls, deletedPortfolios] = await Promise.all([
    pageAll<FeedbackDebtor>((a, b) =>
      admin
        .from("debtors")
        .select(
          "id, name, phone_primary, phone_alternate, alt_phones, loan_reference, loan_amount, outstanding_balance, dpd, lender, product_type, status, assigned_agent_id",
        )
        .eq("client_id", clientId)
        .eq("portfolio_id", portfolio.id)
        .order("id")
        .range(a, b),
    ),
    pageAll<AuditCallRow>((a, b) =>
      admin
        .from("call_audit_rows")
        .select(callColumns)
        .eq("client_id", clientId)
        .eq("portfolio_id", portfolio.id)
        .gte("created_at", bounds.from)
        .lt("created_at", bounds.to)
        .order("created_at")
        .order("call_id")
        .range(a, b),
    ),
    pageAll<{ id: string; name: string }>((a, b) =>
      admin.from("agents").select("id, name").eq("client_id", clientId).order("id").range(a, b),
    ),
    pageAll<AuditCallRow>((a, b) =>
      admin
        .from("call_audit_rows")
        .select(callColumns)
        .eq("client_id", clientId)
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
        .eq("client_id", clientId)
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
          .eq("client_id", clientId)
          .in("loan_reference", chunk)
          .order("id")
          .range(a, b),
      ),
    )
  ).filter((o) => o.portfolio_id !== portfolio.id && !deleted.has(o.portfolio_id ?? ""));
  const earlier = linkEarlierRows(debtors, otherRows);
  const earlierIds = [...earlier.keys()];
  for (const [id, loanId] of earlier) canonicalOf.set(id, loanId);

  const earlierCalls = await inChunks(earlierIds, 200, (chunk) =>
    pageAll<AuditCallRow>((a, b) =>
      admin
        .from("call_audit_rows")
        .select(callColumns)
        .eq("client_id", clientId)
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
    ...new Set(manualCalls.map((c) => phoneKey(c.customer_phone)).filter((k): k is string => !!k)),
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
        .eq("client_id", clientId)
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
  // A period that starts late must still show when each loan's first PTP was marked.
  const olderPtps = opts.from
    ? await inChunks(everyRow, 200, (chunk) =>
        pageAll<PtpMark>((a, b) =>
          admin
            .from("call_audit_rows")
            .select("debtor_id, created_at, promise_amount")
            .eq("client_id", clientId)
            .eq("outcome", "promised")
            .in("debtor_id", chunk)
            .lt("created_at", bounds.from)
            .order("created_at")
            .order("call_id")
            .range(a, b),
        ),
      )
    : [];
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
  if (opts.includeRecordingLinks) {
    const withRecording = calls.filter((c) => c.recording_url);
    const objects = new Map<string, string>();
    const ledgerIds = withRecording
      .map((c) => parseRecordingMarker(c.recording_url))
      .filter((id): id is string => !!id);
    for (let i = 0; i < ledgerIds.length; i += 200) {
      const { data: rows } = await admin
        .from("telephony_calls")
        .select("id, recording_object")
        .eq("client_id", clientId)
        .in("id", ledgerIds.slice(i, i + 200));
      for (const r of rows ?? []) if (r.recording_object) objects.set(r.id, r.recording_object);
    }
    const { data: company } = await admin
      .from("clients")
      .select("subdomain")
      .eq("id", clientId)
      .maybeSingle();
    const expiresAt = Date.now() / 1000 + SHARE_LINK_SECONDS;
    for (const c of withRecording) {
      const ledgerId = parseRecordingMarker(c.recording_url);
      if (!ledgerId) {
        recordingLinks[c.call_id] = c.recording_url as string;
        continue;
      }
      // A short link on the company's own address, never the Storage path (2026-11-25).
      if (objects.has(ledgerId)) {
        recordingLinks[c.call_id] = companyAppLink(
          company?.subdomain,
          `${RECORDING_LINK_PATH_PREFIX}${recordingLinkToken(ledgerId, expiresAt)}`,
        );
      }
    }
  }

  return {
    portfolioName: portfolio.name as string,
    lenderName: (portfolio.lender_name as string | null) ?? null,
    debtors,
    calls,
    earlierPtps: olderPtps.map(toLoan),
    payments,
    settlements,
    disputes,
    messages,
    retentions,
    reminders,
    agentNames: agents,
    recordingLinks,
  };
}
