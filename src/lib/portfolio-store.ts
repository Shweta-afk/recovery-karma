import type { DPDBucket } from "./mock-debtors";
import { supabase, getMyAgentRow } from "./supabase";

// The upload/edit forms show human-readable product labels, but portfolios.product_type has
// a CHECK constraint restricting it to this fixed snake_case enum (see schema.sql) — sending
// the raw label straight through fails that constraint on every save where a product is
// picked. Exported so every picker (upload wizard, edit dialog) reads the same option list.
export const PRODUCT_LABEL_TO_ENUM: Record<string, string> = {
  "Personal Loan": "personal_loan",
  "Credit Card NPA": "credit_card",
  "MSME Working Capital": "business_loan",
  "Two-Wheeler Auto": "vehicle_loan",
  "Home Loan": "home_loan",
  "Gold Loan": "gold_loan",
  Microfinance: "other",
};
const PRODUCT_ENUM_TO_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(PRODUCT_LABEL_TO_ENUM).map(([label, enumValue]) => [enumValue, label]),
);

export interface UploadedDebtor {
  id: string; // client-generated UUID — stable from the upload wizard through to debtors.id
  loanReference: string; // the CSV's own loan/account ID, for human display (debtors.loan_reference)
  name: string;
  phone: string;
  loanAmount: number;
  dpd: number;
  bucket: DPDBucket;
  email: string;
  assignedAgentId?: string; // agent's email — undefined = unassigned (debtors.assigned_agent_id)
  // any extra columns from the CSV land here
  extra: Record<string, string>;
}

// Moved here (from dashboard.call-queue.tsx) — call mode is a property of the portfolio,
// not a single global constant.
export type CallMode = "hybrid" | "ai_only" | "agent_only" | "ivr_agent";

export interface PortfolioSettings {
  callMode: CallMode;
  dialerMode: "predictive" | "preview" | "power" | "manual";
  callsPerCycle: number;
  autoRechurn: boolean;
  rechurnAfterDays: number;
  rechurnOnNoAnswer: boolean;
  rechurnOnBusy: boolean;
  rechurnOnVoicemail: boolean;
  rechurnMaxCycles: number;
  rechurnTimeWindow: string;
  ptpFollowupHours: number;
  callbackBufferMins: number;
  abandonRateTarget: number;
}

export const DEFAULT_PORTFOLIO_SETTINGS: PortfolioSettings = {
  callMode: "ivr_agent",
  dialerMode: "predictive",
  callsPerCycle: 5,
  autoRechurn: true,
  rechurnAfterDays: 1,
  rechurnOnNoAnswer: true,
  rechurnOnBusy: true,
  rechurnOnVoicemail: false,
  rechurnMaxCycles: 3,
  rechurnTimeWindow: "09:00-19:00",
  ptpFollowupHours: 24,
  callbackBufferMins: 10,
  abandonRateTarget: 3,
};

/** A manager-set collection goal for one agent on one portfolio — distinct from the agent's
 * account-wide agents.daily_target. Either field may be set alone. */
export interface AgentTarget {
  targetAmount?: number;
  targetAccounts?: number;
}

export interface UploadedPortfolio {
  id: string;
  name: string;
  lender: string;
  product: string;
  uploadedAt: string; // ISO string
  rows: UploadedDebtor[];
  managerId?: string; // owning manager's account email; undefined = unassigned
  teamId?: string;
  settings: PortfolioSettings;
  agentTargets: Record<string, AgentTarget>; // keyed by agent email
}

const KEY = "recoveryai_portfolios_cache";
const CHUNK_SIZE = 500; // stays comfortably under Supabase's request-size limits per insert

export function getPortfolios(): UploadedPortfolio[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as UploadedPortfolio[]) : [];
  } catch {
    return [];
  }
}

/** Pulls portfolios + their debtor rows from Supabase and refreshes the local cache.
 * Note: like the localStorage version this replaces, this fetches every debtor row the
 * client is allowed to see (client-scoped via RLS) in one go — fine at today's scale, but
 * would need pagination/streaming if portfolios grow into the tens of thousands of rows. */
export async function refreshPortfolios(): Promise<void> {
  const [
    { data: portfolioRows, error: pErr },
    { data: debtorRows, error: dErr },
    { data: agentRows },
  ] = await Promise.all([
    supabase
      .from("portfolios")
      .select("id, name, lender_name, product_type, uploaded_at, settings, team_id, manager_id"),
    supabase
      .from("debtors")
      .select(
        "id, portfolio_id, name, phone_primary, email, loan_amount, dpd, loan_reference, extra, assigned_agent_id",
      ),
    supabase.from("agents").select("id, email"),
  ]);
  if (pErr || dErr || !portfolioRows || !debtorRows || !agentRows) return;

  const emailById = new Map(agentRows.map((a) => [a.id, a.email]));

  // Best-effort: queried separately, and swallowed on failure (e.g. the
  // 20260806_portfolio_agent_targets.sql migration not applied yet) so a missing/broken
  // targets table never blocks the rest of the portfolio sync.
  const targetsByPortfolio = new Map<string, Record<string, AgentTarget>>();
  try {
    const { data: targetRows, error: tErr } = await supabase
      .from("portfolio_agent_targets")
      .select("portfolio_id, agent_id, target_amount, target_accounts");
    if (!tErr && targetRows) {
      for (const t of targetRows) {
        const email = emailById.get(t.agent_id);
        if (!email) continue;
        const forPortfolio = targetsByPortfolio.get(t.portfolio_id) ?? {};
        forPortfolio[email] = {
          targetAmount: t.target_amount != null ? Number(t.target_amount) : undefined,
          targetAccounts: t.target_accounts ?? undefined,
        };
        targetsByPortfolio.set(t.portfolio_id, forPortfolio);
      }
    }
  } catch {
    // ignore — targets are supplementary, not required for the rest of the app to work
  }

  const portfolios: UploadedPortfolio[] = portfolioRows.map((p) => ({
    id: p.id,
    name: p.name,
    lender: p.lender_name ?? "",
    product: p.product_type ? (PRODUCT_ENUM_TO_LABEL[p.product_type] ?? p.product_type) : "",
    uploadedAt: p.uploaded_at,
    managerId: p.manager_id ? emailById.get(p.manager_id) : undefined,
    teamId: p.team_id ?? undefined,
    settings: (p.settings as PortfolioSettings) ?? DEFAULT_PORTFOLIO_SETTINGS,
    agentTargets: targetsByPortfolio.get(p.id) ?? {},
    rows: debtorRows
      .filter((d) => d.portfolio_id === p.id)
      .map((d) => ({
        id: d.id,
        loanReference: d.loan_reference ?? d.id,
        name: d.name,
        phone: d.phone_primary,
        loanAmount: Number(d.loan_amount ?? 0),
        dpd: d.dpd ?? 0,
        bucket: dpd2bucket(d.dpd ?? 0),
        email: d.email ?? "",
        assignedAgentId: d.assigned_agent_id ? emailById.get(d.assigned_agent_id) : undefined,
        extra: (d.extra as Record<string, string>) ?? {},
      })),
  }));

  localStorage.setItem(KEY, JSON.stringify(portfolios));
  window.dispatchEvent(new CustomEvent("portfolios-updated"));
}

/** Creates a brand-new portfolio and inserts all of its debtor rows in one go — used once,
 * at upload time. `allocation` (agent email -> debtor IDs) is optional and, when given, sets
 * each debtor's assigned_agent_id at insert time instead of a separate follow-up write. */
export async function createPortfolio(
  p: UploadedPortfolio,
  allocation: Record<string, string[]> = {},
): Promise<void> {
  const me = await getMyAgentRow();
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
  const managerAgentId = p.managerId ? idByEmail.get(p.managerId) : undefined;

  const assignedIdFor = new Map<string, string>();
  for (const [agentEmail, debtorIds] of Object.entries(allocation)) {
    const agentUuid = idByEmail.get(agentEmail);
    if (!agentUuid) continue;
    for (const debtorId of debtorIds) assignedIdFor.set(debtorId, agentUuid);
  }

  const { error: pErr } = await supabase.from("portfolios").insert({
    id: p.id,
    client_id: me?.client_id,
    name: p.name,
    lender_name: p.lender,
    product_type: p.product ? (PRODUCT_LABEL_TO_ENUM[p.product] ?? null) : null,
    uploaded_by: me?.id,
    total_accounts: p.rows.length,
    manager_id: managerAgentId,
    team_id: p.teamId,
    settings: p.settings,
  });
  if (pErr) throw pErr;

  for (let i = 0; i < p.rows.length; i += CHUNK_SIZE) {
    const chunk = p.rows.slice(i, i + CHUNK_SIZE).map((r) => ({
      id: r.id,
      client_id: me?.client_id,
      portfolio_id: p.id,
      assigned_agent_id: assignedIdFor.get(r.id) ?? null,
      name: r.name,
      phone_primary: r.phone,
      email: r.email || null,
      loan_amount: r.loanAmount,
      outstanding_balance: r.loanAmount,
      dpd: r.dpd,
      loan_reference: r.loanReference,
      extra: r.extra,
    }));
    const { error: dErr } = await supabase.from("debtors").insert(chunk);
    if (dErr) throw dErr;
  }

  await refreshPortfolios();
}

/** Merges a re-uploaded/appended CSV into an existing portfolio: a row whose Loan/Account ID
 * matches an existing debtor updates that debtor's data (name/phone/amount/dpd/email/extra);
 * an unmatched row is inserted as a new, unassigned debtor. Never deletes a debtor and never
 * touches assigned_agent_id on a matched one — reassignment stays a separate, deliberate step
 * (Reassign / per-account transfer), not a side effect of fixing a typo in the source file. */
export async function mergePortfolioRows(
  portfolioId: string,
  rows: UploadedDebtor[],
): Promise<{ updated: number; added: number }> {
  const me = await getMyAgentRow();
  const { data: existing, error: exErr } = await supabase
    .from("debtors")
    .select("id, loan_reference")
    .eq("portfolio_id", portfolioId);
  if (exErr) throw exErr;

  const idByLoanRef = new Map(
    (existing ?? [])
      .filter((d) => d.loan_reference)
      .map((d) => [(d.loan_reference as string).trim().toLowerCase(), d.id as string]),
  );

  const toUpdate: { id: string; row: UploadedDebtor }[] = [];
  const toInsert: UploadedDebtor[] = [];
  for (const r of rows) {
    const existingId = idByLoanRef.get(r.loanReference.trim().toLowerCase());
    if (existingId) toUpdate.push({ id: existingId, row: r });
    else toInsert.push(r);
  }

  // Updates touch different rows with the same shape, so they can run concurrently — chunked
  // to avoid opening hundreds of simultaneous requests on a large re-upload.
  for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
    const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(({ id, row }) =>
        supabase
          .from("debtors")
          .update({
            name: row.name,
            phone_primary: row.phone,
            email: row.email || null,
            loan_amount: row.loanAmount,
            outstanding_balance: row.loanAmount,
            dpd: row.dpd,
            extra: row.extra,
          })
          .eq("id", id),
      ),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw failed.error;
  }

  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE).map((r) => ({
      id: r.id,
      client_id: me?.client_id,
      portfolio_id: portfolioId,
      assigned_agent_id: null,
      name: r.name,
      phone_primary: r.phone,
      email: r.email || null,
      loan_amount: r.loanAmount,
      outstanding_balance: r.loanAmount,
      dpd: r.dpd,
      loan_reference: r.loanReference,
      extra: r.extra,
    }));
    const { error } = await supabase.from("debtors").insert(chunk);
    if (error) throw error;
  }

  await refreshPortfolios();
  return { updated: toUpdate.length, added: toInsert.length };
}

/** Updates portfolio-level metadata (ownership/settings/details) — never touches debtor rows. */
export async function updatePortfolioMeta(
  id: string,
  patch: {
    managerId?: string;
    teamId?: string;
    settings?: PortfolioSettings;
    name?: string;
    lender?: string;
    product?: string;
  },
): Promise<void> {
  const update: Record<string, unknown> = {};
  if (patch.managerId !== undefined) {
    const { data: agentRows } = await supabase.from("agents").select("id, email");
    const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));
    update.manager_id = idByEmail.get(patch.managerId) ?? null;
  }
  if (patch.teamId !== undefined) update.team_id = patch.teamId || null;
  if (patch.settings !== undefined) update.settings = patch.settings;
  if (patch.name !== undefined) update.name = patch.name;
  if (patch.lender !== undefined) update.lender_name = patch.lender;
  if (patch.product !== undefined)
    update.product_type = patch.product ? (PRODUCT_LABEL_TO_ENUM[patch.product] ?? null) : null;

  const { error } = await supabase.from("portfolios").update(update).eq("id", id);
  if (error) throw error;
  await refreshPortfolios();
}

/** Upserts each agent's collection target for one portfolio. Passing an entry with both
 * fields undefined deletes that agent's row (clears the target back to "not set"). */
export async function setPortfolioAgentTargets(
  portfolioId: string,
  targets: Record<string, AgentTarget>, // keyed by agent email
): Promise<void> {
  const me = await getMyAgentRow();
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));

  const toUpsert: {
    client_id?: string;
    portfolio_id: string;
    agent_id: string;
    target_amount: number | null;
    target_accounts: number | null;
  }[] = [];
  const toClear: string[] = [];

  for (const [email, t] of Object.entries(targets)) {
    const agentId = idByEmail.get(email);
    if (!agentId) continue;
    if (t.targetAmount == null && t.targetAccounts == null) {
      toClear.push(agentId);
      continue;
    }
    toUpsert.push({
      client_id: me?.client_id,
      portfolio_id: portfolioId,
      agent_id: agentId,
      target_amount: t.targetAmount ?? null,
      target_accounts: t.targetAccounts ?? null,
    });
  }

  if (toUpsert.length) {
    const { error } = await supabase
      .from("portfolio_agent_targets")
      .upsert(toUpsert, { onConflict: "portfolio_id,agent_id" });
    if (error) throw error;
  }
  if (toClear.length) {
    const { error } = await supabase
      .from("portfolio_agent_targets")
      .delete()
      .eq("portfolio_id", portfolioId)
      .in("agent_id", toClear);
    if (error) throw error;
  }

  await refreshPortfolios();
}

export async function deletePortfolio(id: string): Promise<void> {
  const { error: dErr } = await supabase.from("debtors").delete().eq("portfolio_id", id);
  if (dErr) throw dErr;
  const { error: pErr } = await supabase.from("portfolios").delete().eq("id", id);
  if (pErr) throw pErr;
  await refreshPortfolios();
}

/** Creates a standalone debtor row for a manual dial to a number that isn't in any uploaded
 * portfolio (no portfolio_id) — assigned to the calling agent. Returns the new debtor's UUID
 * so callers can log a real, FK-satisfying disposition against it, the same as any other
 * debtor. Not tracked by getPortfolios()/refreshPortfolios() since it belongs to no portfolio. */
export async function createAdHocDebtor(name: string, phone: string): Promise<string> {
  const me = await getMyAgentRow();
  const id = crypto.randomUUID();
  const { error } = await supabase.from("debtors").insert({
    id,
    client_id: me?.client_id,
    assigned_agent_id: me?.id,
    name,
    phone_primary: phone,
    loan_amount: 0,
    dpd: 0,
    status: "active",
  });
  if (error) throw error;
  return id;
}

/** Assigns (or reassigns) every debtor in a portfolio in one shot: `allocation` maps an
 * agent's email to the debtor IDs they should own; any debtor not covered becomes unassigned.
 * Replaces the old assignment-store.ts — `debtors.assigned_agent_id` is now the single
 * source of truth for who owns a debtor, no separate ledger table. */
export async function assignDebtors(
  portfolioId: string,
  allocation: Record<string, string[]>,
): Promise<void> {
  const { data: agentRows } = await supabase.from("agents").select("id, email");
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));

  const { error: resetErr } = await supabase
    .from("debtors")
    .update({ assigned_agent_id: null })
    .eq("portfolio_id", portfolioId);
  if (resetErr) throw resetErr;

  for (const [agentEmail, debtorIds] of Object.entries(allocation)) {
    if (!debtorIds.length) continue;
    const agentUuid = idByEmail.get(agentEmail);
    if (!agentUuid) continue;
    const { error } = await supabase
      .from("debtors")
      .update({ assigned_agent_id: agentUuid })
      .in("id", debtorIds);
    if (error) throw error;
  }

  await refreshPortfolios();
}

/** Reassigns a single debtor to a different agent (or unassigns when agentId is null) — a
 * lighter-weight alternative to assignDebtors() for a one-off transfer between two agents on
 * the same team, instead of re-splitting the whole portfolio. */
export async function transferDebtor(debtorId: string, agentId: string | null): Promise<void> {
  let agentUuid: string | null = null;
  if (agentId) {
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id, email")
      .eq("email", agentId);
    agentUuid = agentRows?.[0]?.id ?? null;
    if (!agentUuid) throw new Error(`Agent "${agentId}" not found`);
  }
  const { error } = await supabase
    .from("debtors")
    .update({ assigned_agent_id: agentUuid })
    .eq("id", debtorId);
  if (error) throw error;
  await refreshPortfolios();
}

/** Returns all debtor IDs assigned to a specific agent across all portfolios — derived
 * directly from the cached portfolios/debtors, no separate assignment ledger to keep in sync. */
export function getAgentDebtorIds(agentId: string): { portfolioId: string; debtorIds: string[] }[] {
  return getPortfolios()
    .map((p) => {
      const debtorIds = p.rows.filter((r) => r.assignedAgentId === agentId).map((r) => r.id);
      return debtorIds.length ? { portfolioId: p.id, debtorIds } : null;
    })
    .filter((x): x is { portfolioId: string; debtorIds: string[] } => !!x);
}

export function dpd2bucket(dpd: number): DPDBucket {
  if (dpd === 0) return "X";
  if (dpd <= 30) return "1";
  if (dpd <= 90) return "2";
  if (dpd <= 179) return "NPA";
  return "WriteOff";
}
