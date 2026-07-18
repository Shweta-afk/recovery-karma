import { supabase } from "./supabase";

export type CallOutcome = "paid" | "promised" | "refused" | "no_answer" | "callback" | "voicemail" | "dispute" | "settlement";

export interface DispositionRecord {
  id: string;
  debtorId: string;
  debtorName: string;
  phone: string;
  agentId: string;   // email
  agentName: string;
  teamId?: string;
  portfolioId?: string;
  portfolioName?: string;
  outcome: CallOutcome;
  notes: string;
  ptpAmount?: number;
  ptpDate?: string;
  paidAmount?: number;
  paidRef?: string;  // already folded into `notes` by the caller before saving — not read back
  loanAmount?: number;
  dpd?: number;
  time: string; // ISO
}

const KEY = "recoveryai_dispositions_cache";

export function getDispositions(): DispositionRecord[] {
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
  const [
    { data: logs, error },
    { data: debtorRows },
    { data: portfolioRows },
    { data: agentRows },
    { data: teamAgentRows },
  ] = await Promise.all([
    supabase.from("call_logs")
      .select("id, debtor_id, agent_id, outcome, promise_amount, promise_date, raw_notes, created_at")
      .order("created_at", { ascending: false }),
    supabase.from("debtors").select("id, name, phone_primary, portfolio_id, loan_amount, dpd"),
    supabase.from("portfolios").select("id, name"),
    supabase.from("agents").select("id, email, name"),
    supabase.from("team_agents").select("team_id, agent_id"),
  ]);
  if (error || !logs || !debtorRows || !portfolioRows || !agentRows || !teamAgentRows) return;

  const debtorById = new Map(debtorRows.map(d => [d.id, d]));
  const portfolioById = new Map(portfolioRows.map(p => [p.id, p]));
  const agentById = new Map(agentRows.map(a => [a.id, a]));
  const teamByAgentId = new Map(teamAgentRows.map(ta => [ta.agent_id, ta.team_id]));

  const disps: DispositionRecord[] = logs.map(l => {
    const debtor = debtorById.get(l.debtor_id);
    const portfolio = debtor?.portfolio_id ? portfolioById.get(debtor.portfolio_id) : undefined;
    const agent = agentById.get(l.agent_id);
    const amount = l.promise_amount != null ? Number(l.promise_amount) : undefined;
    return {
      id: l.id,
      debtorId: l.debtor_id,
      debtorName: debtor?.name ?? "",
      phone: debtor?.phone_primary ?? "",
      agentId: agent?.email ?? "",
      agentName: agent?.name ?? "",
      teamId: teamByAgentId.get(l.agent_id),
      portfolioId: debtor?.portfolio_id ?? undefined,
      portfolioName: portfolio?.name,
      outcome: l.outcome as CallOutcome,
      notes: l.raw_notes ?? "",
      ptpAmount: l.outcome === "promised" ? amount : undefined,
      ptpDate: l.outcome === "promised" ? (l.promise_date ?? undefined) : undefined,
      paidAmount: l.outcome === "paid" ? amount : undefined,
      loanAmount: debtor ? Number(debtor.loan_amount ?? 0) : undefined,
      dpd: debtor?.dpd ?? undefined,
      time: l.created_at,
    };
  });

  localStorage.setItem(KEY, JSON.stringify(disps));
  window.dispatchEvent(new CustomEvent("dispositions-updated"));
}

export async function saveDisposition(d: DispositionRecord): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map(a => [a.email, a.id]));
  const agentUuid = idByEmail.get(d.agentId);
  if (!agentUuid) throw new Error(`No agent account found for ${d.agentId}`);

  // promise_amount is dual-purpose: the PTP amount for "promised", the paid amount for "paid"
  // — the two outcomes are mutually exclusive so this needs no extra column.
  const amount = d.outcome === "promised" ? d.ptpAmount : d.outcome === "paid" ? d.paidAmount : undefined;

  const { error } = await supabase.from("call_logs").insert({
    id: d.id,
    debtor_id: d.debtorId,
    agent_id: agentUuid,
    call_type: "human",
    outcome: d.outcome,
    promise_amount: amount ?? null,
    promise_date: d.outcome === "promised" ? (d.ptpDate ?? null) : null,
    raw_notes: d.notes,
  });
  if (error) throw error;

  // Financial audit trail — separate from the call log so payments reporting has its own
  // real table, matching the schema's original intent.
  if (d.outcome === "paid" && d.paidAmount) {
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

export function getAgentDispositions(agentId: string): DispositionRecord[] {
  return getDispositions().filter(d => d.agentId === agentId);
}

export function getTeamDispositions(teamId: string): DispositionRecord[] {
  return getDispositions().filter(d => d.teamId === teamId);
}

export function getDispositionsByPortfolio(portfolioId: string): DispositionRecord[] {
  return getDispositions().filter(d => d.portfolioId === portfolioId);
}

// Aggregated stats for a list of dispositions
export function calcStats(disps: DispositionRecord[]) {
  const total = disps.length;
  const ptps  = disps.filter(d => d.outcome === "promised");
  const paid  = disps.filter(d => d.outcome === "paid");
  const ptpAmount  = ptps.reduce((s, d) => s + (d.ptpAmount ?? 0), 0);
  const paidAmount = paid.reduce((s, d) => s + (d.paidAmount ?? 0), 0);
  const contactRate = total > 0
    ? Math.round((disps.filter(d => !["no_answer", "voicemail"].includes(d.outcome)).length / total) * 100)
    : 0;
  return { total, ptps: ptps.length, paid: paid.length, ptpAmount, paidAmount, contactRate };
}
