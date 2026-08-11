import { supabase } from "./supabase";

export type PaymentMethod = "upi" | "card" | "netbanking" | "cash" | "cheque" | "link";
export type PaymentStatus = "pending" | "completed" | "failed" | "refunded";
export type PaymentType = "full" | "partial" | "settlement" | "emi";
/** 'agent' — an agent logged this via a call disposition. 'bank_reported' — a manager's bulk
 * paid-file upload marked it (see applyBulkPaidFile in portfolio-store.ts); no agent gets
 * credit for these. Requires migrations/20260811_payments_source.sql — defaults to 'agent'. */
export type PaymentSource = "agent" | "bank_reported";

export interface PaymentRecord {
  id: string;
  debtorId: string;
  debtorName: string;
  loanId: string;
  phone: string;
  portfolioId?: string;
  portfolioName?: string;
  lender?: string;
  product?: string;
  agentName: string;
  amount: number;
  method: PaymentMethod | null;
  status: PaymentStatus;
  paymentType: PaymentType;
  /** 'agent' when absent — see PaymentSource. */
  source: PaymentSource;
  notes: string;
  dpd?: number;
  receivedAt?: string;
  createdAt: string;
}

export type SettlementStatus = "pending_manager" | "approved" | "rejected" | "sent_to_bank";

export interface SettlementRecord {
  id: string;
  debtorId: string;
  debtorName: string;
  loanId: string;
  originalAmount: number;
  proposedAmount: number;
  waiverPct: number;
  status: SettlementStatus;
  requestedByName: string;
  approvedByName?: string;
  notes: string;
  createdAt: string;
}

const PAY_KEY = "recoveryai_payments_cache";
const STL_KEY = "recoveryai_settlements_cache";

export function getPayments(): PaymentRecord[] {
  try {
    const raw = localStorage.getItem(PAY_KEY);
    return raw ? (JSON.parse(raw) as PaymentRecord[]) : [];
  } catch {
    return [];
  }
}

export function getSettlements(): SettlementRecord[] {
  try {
    const raw = localStorage.getItem(STL_KEY);
    return raw ? (JSON.parse(raw) as SettlementRecord[]) : [];
  } catch {
    return [];
  }
}

/** Pulls the `payments` table (joined against debtors/portfolios/agents for display fields)
 * and refreshes the local cache. Mirrors disposition-store.refreshDispositions(). */
export async function refreshPayments(): Promise<void> {
  const [payments, debtors, portfolios, agents] = await Promise.all([
    supabase.from("payments").select("*").order("created_at", { ascending: false }),
    supabase.from("debtors").select("id, name, phone_primary, portfolio_id, dpd, loan_reference"),
    supabase.from("portfolios").select("id, name, lender_name, product_type"),
    supabase.from("agents").select("id, name"),
  ]);

  const named = [
    ["payments", payments] as const,
    ["debtors", debtors] as const,
    ["portfolios", portfolios] as const,
    ["agents", agents] as const,
  ];
  let failed = false;
  for (const [table, res] of named) {
    if (res.error) {
      console.error(`[payments] ${table} query failed:`, res.error.message, res.error);
      failed = true;
    }
  }
  if (failed) return;

  const { data: rows } = payments;
  const { data: debtorRows } = debtors;
  const { data: portfolioRows } = portfolios;
  const { data: agentRows } = agents;
  if (!rows || !debtorRows || !portfolioRows || !agentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const portfolioById = new Map(portfolioRows.map((p) => [p.id, p]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  type PaymentRow = {
    id: string;
    debtor_id: string | null;
    agent_id: string | null;
    amount: number | string;
    payment_method: string | null;
    status: string;
    payment_type: string;
    // Optional: present only once 20260811_payments_source.sql has been applied.
    source?: string;
    notes: string | null;
    received_at: string | null;
    created_at: string;
  };

  const recs: PaymentRecord[] = (rows as unknown as PaymentRow[]).map((r) => {
    const debtor = r.debtor_id ? debtorById.get(r.debtor_id) : undefined;
    const portfolio = debtor?.portfolio_id ? portfolioById.get(debtor.portfolio_id) : undefined;
    const agent = r.agent_id ? agentById.get(r.agent_id) : undefined;
    return {
      id: r.id,
      debtorId: r.debtor_id ?? "",
      debtorName: debtor?.name ?? "",
      loanId: debtor?.loan_reference ?? r.debtor_id ?? "",
      phone: debtor?.phone_primary ?? "",
      portfolioId: debtor?.portfolio_id ?? undefined,
      portfolioName: portfolio?.name,
      lender: portfolio?.lender_name ?? undefined,
      product: portfolio?.product_type ?? undefined,
      agentName: agent?.name ?? "—",
      amount: Number(r.amount ?? 0),
      method: (r.payment_method as PaymentMethod) ?? null,
      status: r.status as PaymentStatus,
      paymentType: r.payment_type as PaymentType,
      source: (r.source as PaymentSource) ?? "agent",
      notes: r.notes ?? "",
      dpd: debtor?.dpd ?? undefined,
      receivedAt: r.received_at ?? undefined,
      createdAt: r.created_at,
    };
  });

  localStorage.setItem(PAY_KEY, JSON.stringify(recs));
  window.dispatchEvent(new CustomEvent("payments-updated"));
}

/** Pulls `settlement_requests` (joined against debtors/agents) and refreshes the cache. */
export async function refreshSettlements(): Promise<void> {
  const [settlements, debtors, agents] = await Promise.all([
    supabase.from("settlement_requests").select("*").order("created_at", { ascending: false }),
    supabase.from("debtors").select("id, name, loan_reference"),
    supabase.from("agents").select("id, name"),
  ]);

  const named = [
    ["settlement_requests", settlements] as const,
    ["debtors", debtors] as const,
    ["agents", agents] as const,
  ];
  let failed = false;
  for (const [table, res] of named) {
    if (res.error) {
      console.error(`[settlements] ${table} query failed:`, res.error.message, res.error);
      failed = true;
    }
  }
  if (failed) return;

  const { data: rows } = settlements;
  const { data: debtorRows } = debtors;
  const { data: agentRows } = agents;
  if (!rows || !debtorRows || !agentRows) return;

  const debtorById = new Map(debtorRows.map((d) => [d.id, d]));
  const agentById = new Map(agentRows.map((a) => [a.id, a]));

  type SettlementRow = {
    id: string;
    debtor_id: string | null;
    requested_by: string | null;
    approved_by: string | null;
    original_amount: number | string | null;
    proposed_amount: number | string | null;
    agent_notes: string | null;
    status: string;
    created_at: string;
  };

  const recs: SettlementRecord[] = (rows as unknown as SettlementRow[]).map((r) => {
    const debtor = r.debtor_id ? debtorById.get(r.debtor_id) : undefined;
    const original = Number(r.original_amount ?? 0);
    const proposed = Number(r.proposed_amount ?? 0);
    return {
      id: r.id,
      debtorId: r.debtor_id ?? "",
      debtorName: debtor?.name ?? "",
      loanId: debtor?.loan_reference ?? r.debtor_id ?? "",
      originalAmount: original,
      proposedAmount: proposed,
      waiverPct: original > 0 ? Math.round(((original - proposed) / original) * 100) : 0,
      status: r.status as SettlementStatus,
      requestedByName: (r.requested_by ? agentById.get(r.requested_by)?.name : undefined) ?? "—",
      approvedByName: r.approved_by ? agentById.get(r.approved_by)?.name : undefined,
      notes: r.agent_notes ?? "",
      createdAt: r.created_at,
    };
  });

  localStorage.setItem(STL_KEY, JSON.stringify(recs));
  window.dispatchEvent(new CustomEvent("settlements-updated"));
}
