// Persisted escalations — an agent escalates a debtor to their manager, who works it in
// their own "My Queue". Backed by Supabase's `escalations` table, joined against debtors/
// portfolios/agents at read time for display fields (no denormalized snapshot to keep in sync).

import { supabase, getMyAgentRow } from "./supabase";

export type EscalationPriority = "normal" | "urgent" | "critical";

// Mirrors the fields on QueueDebtor (dashboard.call-queue.tsx) so the manager's "My Queue"
// can reconstruct a full call target from a persisted escalation, without the lib layer
// importing a type from a route file. `language`/`queueStatus`/`scheduledAt`/`ptpAmount` are
// queue-position concepts, not debtor-intrinsic data, so they aren't persisted — they're
// given sensible defaults for an escalated debtor entering the manager's queue.
export interface EscalationDebtorSnapshot {
  id: string;
  name: string;
  phone: string;
  altPhone?: string;
  loanAmount: number;
  dpd: number;
  aiScore: number;
  scoreReason: string;
  lastContacted: string | null;
  portfolio: string;
  language: string;
  queueStatus: "fresh" | "callback" | "ptp" | "escalated" | "no_answer";
  scheduledAt: string;
  ptpAmount?: number;
}

export interface Escalation {
  id: string;
  debtor: EscalationDebtorSnapshot;
  reason: string;
  priority: EscalationPriority;
  notes: string;
  agentId: string; // email
  agentName: string;
  createdAt: string; // ISO
  resolved: boolean;
}

const KEY = "recoveryai_escalations_cache";

export function getEscalations(): Escalation[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Escalation[]) : [];
  } catch {
    return [];
  }
}

export function getOpenEscalations(): Escalation[] {
  return getEscalations()
    .filter((e) => !e.resolved)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export async function refreshEscalations(): Promise<void> {
  const [
    { data: rows, error },
    { data: debtorRows },
    { data: portfolioRows },
    { data: agentRows },
  ] = await Promise.all([
    supabase
      .from("escalations")
      .select("id, debtor_id, reason, priority, notes, agent_id, resolved, created_at"),
    supabase
      .from("debtors")
      .select(
        "id, name, phone_primary, phone_alternate, loan_amount, dpd, ai_score, ai_score_reason, last_contacted_at, portfolio_id",
      ),
    supabase.from("portfolios").select("id, name"),
    supabase.from("agents").select("id, email, name"),
  ]);
  if (error || !rows || !debtorRows || !portfolioRows || !agentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const portfolioById = new Map(portfolioRows.map((p) => [p.id, p]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  const escalations: Escalation[] = rows.map((e) => {
    const debtor = debtorById.get(e.debtor_id);
    const portfolio = debtor?.portfolio_id ? portfolioById.get(debtor.portfolio_id) : undefined;
    const agent = agentById.get(e.agent_id);
    return {
      id: e.id,
      debtor: {
        id: e.debtor_id,
        name: debtor?.name ?? "",
        phone: debtor?.phone_primary ?? "",
        altPhone: debtor?.phone_alternate ?? undefined,
        loanAmount: debtor ? Number(debtor.loan_amount ?? 0) : 0,
        dpd: debtor?.dpd ?? 0,
        aiScore: debtor?.ai_score ?? 0,
        scoreReason: debtor?.ai_score_reason ?? "",
        lastContacted: debtor?.last_contacted_at ?? null,
        portfolio: portfolio?.name ?? "",
        language: "English",
        queueStatus: "escalated",
        scheduledAt: "—",
      },
      reason: e.reason ?? "",
      priority: (e.priority as EscalationPriority) ?? "normal",
      notes: e.notes ?? "",
      agentId: agent?.email ?? "",
      agentName: agent?.name ?? "",
      createdAt: e.created_at,
      resolved: e.resolved,
    };
  });

  localStorage.setItem(KEY, JSON.stringify(escalations));
  window.dispatchEvent(new CustomEvent("escalations-updated"));
}

export async function saveEscalation(
  e: Omit<Escalation, "id" | "createdAt" | "resolved">,
): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const agentUuid = idByEmail.get(e.agentId);
  if (!agentUuid) throw new Error(`No agent account found for ${e.agentId}`);

  const me = await getMyAgentRow();
  const { error } = await supabase.from("escalations").insert({
    client_id: me?.client_id,
    debtor_id: e.debtor.id,
    reason: e.reason,
    priority: e.priority,
    notes: e.notes,
    agent_id: agentUuid,
  });
  if (error) throw error;
  await refreshEscalations();
}

export async function resolveEscalation(id: string): Promise<void> {
  const { error } = await supabase.from("escalations").update({ resolved: true }).eq("id", id);
  if (error) throw error;
  await refreshEscalations();
}
