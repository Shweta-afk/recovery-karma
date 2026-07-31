import { supabase } from "./supabase";
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
  notes: string;
  ptpAmount?: number;
  ptpDate?: string;
  paidAmount?: number;
  paidRef?: string; // already folded into `notes` by the caller before saving — not read back
  loanAmount?: number;
  dpd?: number;
  time: string; // ISO
}

const KEY = "recoveryai_dispositions_cache";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Distinguishes a real debtor/log id from Manual Dial's synthetic `manual-<timestamp>`. */
function isUuid(v: string | undefined | null): boolean {
  return typeof v === "string" && UUID_RE.test(v);
}

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
    supabase
      .from("call_logs")
      // `*` rather than an explicit column list: naming contact_name/contact_phone here
      // makes the whole query 400 on any database where that migration has not been applied
      // yet, which silently empties every history view. Selecting all columns keeps reads
      // working across schema drift — the ad-hoc fields are simply absent until then.
      .select("*")
      .order("created_at", { ascending: false }),
    supabase.from("debtors").select("id, name, phone_primary, portfolio_id, loan_amount, dpd"),
    supabase.from("portfolios").select("id, name"),
    supabase.from("agents").select("id, email, name"),
    supabase.from("team_agents").select("team_id, agent_id"),
  ]);
  if (error || !logs || !debtorRows || !portfolioRows || !agentRows || !teamAgentRows) return;

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
    raw_notes: string | null;
    created_at: string;
    // Optional: present only once 20260731_call_logs_adhoc_contacts.sql has been applied.
    contact_name?: string | null;
    contact_phone?: string | null;
  };

  const disps: DispositionRecord[] = (logs as unknown as CallLogRow[]).map((l) => {
    const debtor = debtorById.get(l.debtor_id);
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

  const { error } = await supabase.from("call_logs").insert({
    id: isUuid(d.id) ? d.id : crypto.randomUUID(),
    debtor_id: isAdHoc ? null : d.debtorId,
    contact_name: isAdHoc ? (d.debtorName || null) : null,
    contact_phone: isAdHoc ? (d.phone || null) : null,
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

export function getTeamDispositions(teamId: string): DispositionRecord[] {
  return getDispositions().filter((d) => d.teamId === teamId);
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
