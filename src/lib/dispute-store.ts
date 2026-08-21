import { supabase } from "./supabase";

export type DisputeType =
  | "payment"
  | "identity"
  | "amount"
  | "legal_threat"
  | "harassment_claim"
  | "other";
export type DisputeStatus = "open" | "under_review" | "resolved" | "escalated_legal";

export interface DisputeRecord {
  id: string;
  debtorId: string;
  debtorName: string;
  loanId: string;
  portfolioName?: string;
  disputeType: DisputeType | null;
  status: DisputeStatus;
  debtorReason: string;
  agentNotes: string;
  raisedByName: string;
  resolvedByName?: string;
  resolvedAt?: string;
  createdAt: string;
}

const KEY = "recoveryai_disputes_cache";

export function getDisputes(): DisputeRecord[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DisputeRecord[]) : [];
  } catch {
    return [];
  }
}

/** Aggregate dispute report across every debtor — the per-debtor version of this same query
 * already lives in fetch-debtors.ts (one debtor's history tab); this is the client-wide roll-up
 * for Admin Reports. Mirrors payments-store.refreshPayments()'s join-and-cache shape. */
export async function refreshDisputes(): Promise<void> {
  const [disputes, debtors, portfolios, agents] = await Promise.all([
    supabase.from("disputes").select("*").order("created_at", { ascending: false }),
    supabase.from("debtors").select("id, name, portfolio_id, loan_reference"),
    supabase.from("portfolios").select("id, name"),
    supabase.from("agents").select("id, name"),
  ]);

  const named = [
    ["disputes", disputes] as const,
    ["debtors", debtors] as const,
    ["portfolios", portfolios] as const,
    ["agents", agents] as const,
  ];
  let failed = false;
  for (const [table, res] of named) {
    if (res.error) {
      console.error(`[disputes] ${table} query failed:`, res.error.message, res.error);
      failed = true;
    }
  }
  if (failed) return;

  const { data: rows } = disputes;
  const { data: debtorRows } = debtors;
  const { data: portfolioRows } = portfolios;
  const { data: agentRows } = agents;
  if (!rows || !debtorRows || !portfolioRows || !agentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const portfolioById = new Map(portfolioRows.map((p) => [p.id, p]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  type DisputeRow = {
    id: string;
    debtor_id: string | null;
    raised_by: string | null;
    dispute_type: string | null;
    debtor_reason: string | null;
    agent_notes: string | null;
    status: string;
    resolved_by: string | null;
    resolved_at: string | null;
    created_at: string;
  };

  const recs: DisputeRecord[] = (rows as unknown as DisputeRow[]).map((r) => {
    const debtor = r.debtor_id ? debtorById.get(r.debtor_id) : undefined;
    const portfolio = debtor?.portfolio_id ? portfolioById.get(debtor.portfolio_id) : undefined;
    return {
      id: r.id,
      debtorId: r.debtor_id ?? "",
      debtorName: debtor?.name ?? "",
      loanId: debtor?.loan_reference ?? r.debtor_id ?? "",
      portfolioName: portfolio?.name,
      disputeType: (r.dispute_type as DisputeType) ?? null,
      status: r.status as DisputeStatus,
      debtorReason: r.debtor_reason ?? "",
      agentNotes: r.agent_notes ?? "",
      raisedByName: (r.raised_by ? agentById.get(r.raised_by)?.name : undefined) ?? "—",
      resolvedByName: r.resolved_by ? agentById.get(r.resolved_by)?.name : undefined,
      resolvedAt: r.resolved_at ?? undefined,
      createdAt: r.created_at,
    };
  });

  localStorage.setItem(KEY, JSON.stringify(recs));
  window.dispatchEvent(new CustomEvent("disputes-updated"));
}
