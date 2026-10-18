// Retention requests — an agent asks to keep working a specific debtor account into the next
// portfolio cycle (e.g. an active PTP, mid-negotiation) instead of it being recalled once the
// bank's next file replaces the current portfolio. A manager reviews the ask; approval only
// means "we're asking the bank" — see reconcileRetentionRequests in portfolio-store.ts for how
// 'sent_to_bank' resolves to 'carried' or 'not_honored' once the next portfolio is uploaded.
// Same localStorage-cache-over-Supabase shape as escalation-store.ts.

import { supabase, getMyAgentRow } from "./supabase";
import { fetchDebtorsByIds } from "./debtors-fetch";

export type RetentionStatus =
  "pending_manager" | "approved" | "rejected" | "sent_to_bank" | "carried" | "not_honored";

export interface RetentionRequest {
  id: string;
  debtorId: string;
  debtorName: string;
  debtorPhone: string;
  loanReference?: string;
  portfolioId: string; // the portfolio requested FROM (the old/closing one)
  portfolioName: string;
  requestedBy: string; // agent name
  reason: string;
  status: RetentionStatus;
  reviewedBy?: string; // agent name
  reviewedAt?: string;
  sentToBankAt?: string;
  carriedAt?: string;
  createdAt: string;
}

const KEY = "recoveryai_retention_requests_cache";

export function getRetentionRequests(): RetentionRequest[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as RetentionRequest[]) : [];
  } catch {
    return [];
  }
}

export function getRetentionRequestsFor(debtorId: string): RetentionRequest[] {
  return getRetentionRequests().filter((r) => r.debtorId === debtorId);
}

export function getPendingRetentionRequests(portfolioId?: string): RetentionRequest[] {
  return getRetentionRequests().filter(
    (r) => r.status === "pending_manager" && (!portfolioId || r.portfolioId === portfolioId),
  );
}

export async function refreshRetentionRequests(): Promise<void> {
  const [{ data: rows, error }, { data: portfolioRows }, { data: agentRows }] = await Promise.all([
    supabase
      .from("retention_requests")
      .select(
        "id, debtor_id, portfolio_id, requested_by, reason, status, reviewed_by, reviewed_at, sent_to_bank_at, carried_at, created_at",
      )
      .order("created_at", { ascending: false }),
    supabase.from("portfolios").select("id, name"),
    supabase.from("agents").select("id, name"),
  ]);
  if (error || !rows || !portfolioRows || !agentRows) return;
  // Debtors fetched by id (fetchDebtorsByIds), not `select ... from debtors`: that unpaged read
  // returned only the first 1,000 debtors, so for a larger company a row on any other debtor
  // showed no name, and it downloaded 1,000 debtors to label a handful of rows (2026-10-18).
  const { data: debtorRows, error: dErr } = await fetchDebtorsByIds(rows.map((r) => r.debtor_id));
  if (dErr) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const portfolioById = new Map(portfolioRows.map((p) => [p.id, p]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  const requests: RetentionRequest[] = rows.map((r) => {
    const debtor = debtorById.get(r.debtor_id);
    const portfolio = portfolioById.get(r.portfolio_id);
    return {
      id: r.id,
      debtorId: r.debtor_id,
      debtorName: debtor?.name ?? "",
      debtorPhone: debtor?.phone_primary ?? "",
      loanReference: debtor?.loan_reference ?? undefined,
      portfolioId: r.portfolio_id,
      portfolioName: portfolio?.name ?? "",
      requestedBy: (r.requested_by ? agentById.get(r.requested_by)?.name : undefined) ?? "",
      reason: r.reason ?? "",
      status: r.status as RetentionStatus,
      reviewedBy: r.reviewed_by ? agentById.get(r.reviewed_by)?.name : undefined,
      reviewedAt: r.reviewed_at ?? undefined,
      sentToBankAt: r.sent_to_bank_at ?? undefined,
      carriedAt: r.carried_at ?? undefined,
      createdAt: r.created_at,
    };
  });

  localStorage.setItem(KEY, JSON.stringify(requests));
  window.dispatchEvent(new CustomEvent("retention-requests-updated"));
}

/** Agent action: ask to keep working this debtor into the next portfolio cycle. */
export async function requestRetention(args: {
  debtorId: string;
  portfolioId: string;
  reason: string;
}): Promise<void> {
  const me = await getMyAgentRow();
  if (!me) throw new Error("Not signed in");
  const { error } = await supabase.from("retention_requests").insert({
    debtor_id: args.debtorId,
    portfolio_id: args.portfolioId,
    requested_by: me.id,
    reason: args.reason,
  });
  if (error) throw error;
  await refreshRetentionRequests();
}

/** Manager action: approve or reject a pending request. Rejected never reaches the bank. */
export async function reviewRetentionRequest(
  id: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const me = await getMyAgentRow();
  const { error } = await supabase
    .from("retention_requests")
    .update({ status: decision, reviewed_by: me?.id, reviewed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  await refreshRetentionRequests();
}

/** Manager action: mark approved requests as sent, right after exporting them for the bank. */
export async function markRetentionRequestsSent(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await supabase
    .from("retention_requests")
    .update({ status: "sent_to_bank", sent_to_bank_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
  await refreshRetentionRequests();
}
