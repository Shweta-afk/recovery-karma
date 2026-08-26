import { supabase } from "./supabase";
import type { Debtor } from "./mock-debtors";

// The supabase client here is untyped (no generated Database type), so query rows come back
// as `any`. These interfaces describe the exact columns each select requests, so callers get
// real types instead of `any`. A Supabase to-one embed (e.g. `agents(name)`) is an object.

export type CallLogOutcome =
  | "paid"
  | "promised"
  | "refused"
  | "no_answer"
  | "voicemail"
  | "dispute"
  | "callback"
  | "wrong_number"
  | "deceased"
  | "escalated";

interface DebtorRow {
  id: string;
  name: string;
  phone_primary: string;
  loan_amount: number | string | null;
  dpd: number | null;
  ai_score: number | null;
  ai_score_reason: string | null;
  last_contacted_at: string | null;
  portfolios: { name: string } | null;
}

export interface CallLogRow {
  id: string;
  created_at: string;
  call_type: string;
  outcome: CallLogOutcome | null;
  duration_seconds: number | null;
  raw_notes: string | null;
  ai_notes: string | null;
  promise_amount: number | null;
  promise_date: string | null;
  agents: { name: string } | null;
}

export interface MessageRow {
  id: string;
  sent_at: string;
  channel: string;
  direction: "outbound" | "inbound";
  content: string;
  status: string | null;
  template_name: string | null;
  agents: { name: string } | null;
}

export interface PaymentRow {
  id: string;
  created_at: string;
  amount: number | string;
  payment_method: string | null;
  status: string;
  payment_type: string;
  received_at: string | null;
}

export interface DisputeRow {
  id: string;
  created_at: string;
  dispute_type: string | null;
  debtor_reason: string | null;
  agent_notes: string | null;
  status: string;
  agents: { name: string } | null;
}

export interface DebtorHistory {
  callLogs: CallLogRow[];
  messages: MessageRow[];
  payments: PaymentRow[];
  disputes: DisputeRow[];
}

export interface DebtorDetails {
  risk_flags: string[] | null;
}

export async function fetchDebtorsByAgent(agentId: string): Promise<Debtor[]> {
  // Get agent's assigned portfolios
  const { data: portfolios, error: portfolioError } = await supabase
    .from("agent_portfolios")
    .select("portfolio_id")
    .eq("agent_id", agentId);

  if (portfolioError || !portfolios || portfolios.length === 0) {
    console.warn("No portfolios assigned to agent:", agentId);
    return [];
  }

  const portfolioIds = portfolios.map((p) => p.portfolio_id);

  // Fetch debtors from assigned portfolios
  const { data, error } = await supabase
    .from("debtors")
    .select(
      `
      id,
      name,
      phone_primary,
      loan_amount,
      dpd,
      ai_score,
      ai_score_reason,
      last_contacted_at,
      portfolios(name)
    `,
    )
    .in("portfolio_id", portfolioIds)
    .eq("status", "active")
    .order("ai_score", { ascending: false })
    .limit(200);

  if (error) {
    console.error("Error fetching debtors:", error);
    return [];
  }

  if (!data) return [];

  // Supabase types a to-one embed as an array, but returns an object at runtime — assert the
  // real shape through `unknown` (the columns are ours, from the select string above).
  return (data as unknown as DebtorRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone_primary,
    loanAmount: Number(row.loan_amount) || 0,
    dpd: row.dpd || 0,
    aiScore: row.ai_score || 0,
    scoreReason: row.ai_score_reason || "",
    lastContacted: row.last_contacted_at
      ? new Date(row.last_contacted_at).toISOString().split("T")[0]
      : null,
    portfolio: row.portfolios?.name || "Unknown Portfolio",
    language: "Hindi",
  })) as Debtor[];
}

export async function fetchDebtors(clientId?: string): Promise<Debtor[]> {
  // Fallback to fetching all active debtors (no agent filter)
  const { data, error } = await supabase
    .from("debtors")
    .select(
      `
      id,
      name,
      phone_primary,
      loan_amount,
      dpd,
      ai_score,
      ai_score_reason,
      last_contacted_at,
      portfolios(name)
    `,
    )
    .eq("status", "active")
    .order("ai_score", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Error fetching debtors from Supabase:", error);
    return [];
  }

  if (!data) return [];

  // Supabase types a to-one embed as an array, but returns an object at runtime — assert the
  // real shape through `unknown` (the columns are ours, from the select string above).
  return (data as unknown as DebtorRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone_primary,
    loanAmount: Number(row.loan_amount) || 0,
    dpd: row.dpd || 0,
    aiScore: row.ai_score || 0,
    scoreReason: row.ai_score_reason || "",
    lastContacted: row.last_contacted_at
      ? new Date(row.last_contacted_at).toISOString().split("T")[0]
      : null,
    portfolio: row.portfolios?.name || "Unknown Portfolio",
    language: "Hindi",
  })) as Debtor[];
}

export async function fetchDebtorHistory(debtorId: string): Promise<DebtorHistory> {
  // Fetch call logs
  const { data: callLogs } = await supabase
    .from("call_logs")
    .select(
      `
      id,
      created_at,
      call_type,
      outcome,
      duration_seconds,
      raw_notes,
      ai_notes,
      promise_amount,
      promise_date,
      agents(name)
    `,
    )
    .eq("debtor_id", debtorId)
    .order("created_at", { ascending: false });

  // Fetch messages
  const { data: messages } = await supabase
    .from("messages")
    .select(
      `
      id,
      sent_at,
      channel,
      direction,
      content,
      status,
      template_name,
      agents(name)
    `,
    )
    .eq("debtor_id", debtorId)
    .order("sent_at", { ascending: false });

  // Fetch payments
  const { data: payments } = await supabase
    .from("payments")
    .select(
      `
      id,
      created_at,
      amount,
      payment_method,
      status,
      payment_type,
      received_at
    `,
    )
    .eq("debtor_id", debtorId)
    .order("created_at", { ascending: false });

  // Fetch disputes
  const { data: disputes } = await supabase
    .from("disputes")
    .select(
      `
      id,
      created_at,
      dispute_type,
      debtor_reason,
      agent_notes,
      status,
      agents(name)
    `,
    )
    .eq("debtor_id", debtorId)
    .order("created_at", { ascending: false });

  return {
    callLogs: (callLogs as unknown as CallLogRow[] | null) ?? [],
    messages: (messages as unknown as MessageRow[] | null) ?? [],
    payments: (payments as PaymentRow[] | null) ?? [],
    disputes: (disputes as unknown as DisputeRow[] | null) ?? [],
  };
}

export interface AssignedAgent {
  name: string;
  email: string;
  /** AGT-0001 / MGR-0002 — null for rows predating migrations/20260820_agent_code.sql. */
  agentCode: string | null;
}

/**
 * Who is working this account. Read from the debtor row rather than any cached roster, so it
 * reflects a reassignment the moment it happens; RLS scopes it exactly as `debtors_select` does,
 * so an agent only ever resolves this for a debtor they can already see.
 *
 * Returns null both when the debtor is unassigned and when the viewer cannot see the row — the
 * caller renders "Unassigned" either way, which is the honest thing to show someone who isn't
 * permitted to know.
 */
export async function fetchAssignedAgent(debtorId: string): Promise<AssignedAgent | null> {
  const { data } = await supabase
    .from("debtors")
    .select("agents(name, email, agent_code)")
    .eq("id", debtorId)
    .maybeSingle();

  // PostgREST returns an embedded to-one relation as an object, but some client/schema
  // combinations surface it as a single-element array — accept both rather than silently
  // rendering "Unassigned" for every debtor if that shape ever changes.
  const raw = (data as { agents?: unknown } | null)?.agents;
  const agent = (Array.isArray(raw) ? raw[0] : raw) as
    | { name?: string; email?: string; agent_code?: string | null }
    | undefined;
  if (!agent?.name && !agent?.email) return null;

  return {
    name: agent.name ?? agent.email ?? "Unknown",
    email: agent.email ?? "",
    agentCode: agent.agent_code ?? null,
  };
}

export async function fetchDebtorDetails(debtorId: string): Promise<DebtorDetails | null> {
  const { data } = await supabase
    .from("debtors")
    .select(
      `
      *,
      portfolios(name, lender_name),
      agents(name, email)
    `,
    )
    .eq("id", debtorId)
    .single();

  return (data as DebtorDetails | null) ?? null;
}

export async function logCallOutcome(
  debtorId: string,
  agentId: string,
  outcome: CallLogOutcome,
  notes: string,
  promiseAmount?: number,
  promiseDate?: string,
  durationSeconds?: number,
) {
  const { data, error } = await supabase
    .from("call_logs")
    .insert([
      {
        debtor_id: debtorId,
        agent_id: agentId,
        call_type: "human",
        outcome,
        raw_notes: notes,
        promise_amount: promiseAmount || null,
        promise_date: promiseDate || null,
        duration_seconds: durationSeconds || 0,
      },
    ])
    .select();

  if (error) {
    console.error("Error logging call:", error);
    return null;
  }

  return data?.[0];
}

export async function fetchDebtorStats(): Promise<{
  callsMade: number;
  target: number;
  outcomes: { paid: number; promised: number; refused: number; noAnswer: number };
}> {
  // For now, return mock stats. Can be extended to calculate from call_logs
  return {
    callsMade: 0,
    target: 80,
    outcomes: {
      paid: 0,
      promised: 0,
      refused: 0,
      noAnswer: 0,
    },
  };
}
