import { supabase } from "./supabase";
import { fetchAllRows } from "./fetch-all-rows";
import { fetchDebtorsByIds } from "./debtors-fetch";
import { createJsonCache } from "./json-cache";

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
  /** The collector's account email, or null for a bank-reported payment nobody collected.
   * Needed to filter by person — agentName alone breaks on duplicate names. */
  agentId: string | null;
  /** Role of whoever collected it. Managers do collect (their own escalation queue, and
   * behalf-dialling from Agent Live View), and their collections were previously
   * indistinguishable from an agent's in every total on this page. 'bank' for a paid-file
   * upload, which no person collected. */
  collectorRole: "agent" | "manager" | "admin" | "bank";
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

const payCache = createJsonCache<PaymentRecord>(PAY_KEY);
const stlCache = createJsonCache<SettlementRecord>(STL_KEY);

export function getPayments(): PaymentRecord[] {
  return payCache.read();
}

export function getSettlements(): SettlementRecord[] {
  return stlCache.read();
}

/** Every completed payment against a portfolio's debtors, whichever way it arrived: an agent
 * logging a "paid" disposition (saveDisposition writes the payments row too) or a manager's
 * bulk paid-file upload (applyBulkPaidFile — agent_id null, source 'bank_reported'). The
 * payments table is the whole financial record, so summing it here never double-counts a
 * call-logged payment. Feeds toPortfolio()'s Recovered KPI, which used to read call
 * dispositions alone and therefore could never reflect a bank-reported payment at all. */
export function getPortfolioRecovered(portfolioId: string): {
  total: number;
  bankReported: number;
} {
  const rows = getPayments().filter(
    (p) => p.portfolioId === portfolioId && p.status === "completed",
  );
  return {
    total: rows.reduce((s, p) => s + p.amount, 0),
    // Split out so the portfolio KPI can say how much of the recovery arrived via a paid-file
    // upload rather than agent collections — otherwise a manager uploads the bank's file and
    // has no way to tell from this screen whether it landed.
    bankReported: rows
      .filter((p) => p.source === "bank_reported")
      .reduce((s, p) => s + p.amount, 0),
  };
}

/** Pulls the `payments` table (joined against debtors/portfolios/agents for display fields)
 * and refreshes the local cache. Mirrors disposition-store.refreshDispositions(). */
export async function refreshPayments(): Promise<void> {
  // payments outgrows PostgREST's 1000-row cap, so it's paginated same as before. `debtors`
  // used to be a full-table read too (fetchDebtorsShared) purely to build a name/portfolio
  // lookup for whichever debtor each payment happens to reference — which meant downloading
  // every debtor the caller can see (16,617+ and growing) to look up the few hundred that
  // actually have a payment. Fetched by id, once payments' own debtor_ids are known, instead.
  const [payments, portfolios, agents] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("payments")
        .select("*")
        .order("created_at", { ascending: false })
        .range(from, to),
    ),
    supabase.from("portfolios").select("id, name, lender_name, product_type"),
    supabase.from("agents").select("id, name, email, role"),
  ]);
  const debtors = payments.error
    ? { data: [] as Awaited<ReturnType<typeof fetchDebtorsByIds>>["data"], error: null }
    : await fetchDebtorsByIds(
        (payments.data as { debtor_id: string | null }[])
          .map((p) => p.debtor_id)
          .filter((id): id is string => !!id),
      );

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
  // The generated Supabase types don't cover these columns and widen the row to `never` (as
  // the casts elsewhere in this file already work around). Narrow to what we actually select.
  type AgentRow = { id: string; name: string; email: string; role: string };
  const agentById = new Map((agentRows as unknown as AgentRow[]).map((a) => [a.id as string, a]));

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
      // NOT the debtor UUID as a fallback. A payment can be visible while its debtor is not:
      // bank-reported rows are client-wide, but debtors_select scopes an agent to their own
      // accounts. That fallback put a raw internal id in the Loan ID column, which means
      // nothing to a user and leaks a database identifier onto the screen. Empty instead, and
      // the UI says the account is not visible.
      loanId: debtor?.loan_reference ?? "",
      phone: debtor?.phone_primary ?? "",
      portfolioId: debtor?.portfolio_id ?? undefined,
      portfolioName: portfolio?.name,
      lender: portfolio?.lender_name ?? undefined,
      product: portfolio?.product_type ?? undefined,
      agentName: agent?.name ?? "—",
      agentId: (agent?.email as string | undefined) ?? null,
      collectorRole: r.agent_id
        ? ((agent?.role as PaymentRecord["collectorRole"]) ?? "agent")
        : "bank",
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

  if (!payCache.write(recs)) {
    console.warn(
      "[payments] localStorage quota exceeded — serving payments from memory only for this tab",
    );
  }
  window.dispatchEvent(new CustomEvent("payments-updated"));
}

/** Pulls `settlement_requests` (joined against debtors/agents) and refreshes the cache. */
export async function refreshSettlements(): Promise<void> {
  // Debtors fetched by id, like refreshPayments() above: this used to page the whole debtors
  // table (30 requests for a 29,813-debtor company, on every Payments / Admin Reports load)
  // just to label the settlement rows with a name and loan ID.
  const [settlements, agents] = await Promise.all([
    supabase.from("settlement_requests").select("*").order("created_at", { ascending: false }),
    supabase.from("agents").select("id, name, email, role"),
  ]);
  const debtors = settlements.error
    ? { data: [] as Awaited<ReturnType<typeof fetchDebtorsByIds>>["data"], error: null }
    : await fetchDebtorsByIds(
        ((settlements.data ?? []) as { debtor_id: string | null }[])
          .map((s) => s.debtor_id)
          .filter((id): id is string => !!id),
      );

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

  if (!stlCache.write(recs)) {
    console.warn(
      "[payments] localStorage quota exceeded — serving settlements from memory only for this tab",
    );
  }
  window.dispatchEvent(new CustomEvent("settlements-updated"));
}
