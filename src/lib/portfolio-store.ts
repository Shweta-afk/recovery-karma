import type { DPDBucket, Debtor } from "./mock-debtors";
import { supabase, getMyAgentRow } from "./supabase";
import type { Database, Json } from "./database.types";
import { refreshRetentionRequests } from "./retention-store";
import { fetchAllRows } from "./fetch-all-rows";
import { createJsonCache } from "./json-cache";
import { fetchDebtorsShared } from "./debtors-fetch";
import { todayIstKey } from "./date-filter";
import type { PortfolioFootprint } from "./portfolio-continuation";
import {
  STD_FIELDS,
  slotsFromDebtor,
  debtorFieldsFromSlots,
  resolveRemapSource,
  type StdFieldKey,
} from "./csv-fields";

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
// Exported for scoped-debtors.ts, which builds UploadedPortfolio objects the same way
// refreshPortfolios() below does, just from a narrower query — kept as one source rather than
// a second copy of the enum->label mapping.
export const PRODUCT_ENUM_TO_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(PRODUCT_LABEL_TO_ENUM).map(([label, enumValue]) => [enumValue, label]),
);

export interface UploadedDebtor {
  id: string; // client-generated UUID — stable from the upload wizard through to debtors.id
  loanReference: string; // the CSV's own loan/account ID, for human display (debtors.loan_reference)
  name: string;
  phone: string;
  loanAmount: number;
  // Original sanctioned/disbursed amount, distinct from loanAmount ("Outstanding Amount" in the
  // upload UI, copied into debtors.outstanding_balance) — see migrations/20260905_debtors_
  // principal_amount.sql. Optional in the source file; 0 when the bank didn't provide one.
  principalAmount: number;
  // Monthly instalment — see migrations/20260908_debtors_emi_product_code.sql. 0 when unset.
  emiAmount: number;
  // Per-debtor product identifier from the bank's own file, distinct from the portfolio-wide
  // Product Type picker (PRODUCT_LABEL_TO_ENUM) which applies one label to every row. "" when
  // the file has no such column.
  productCode: string;
  dpd: number;
  bucket: DPDBucket;
  email: string;
  assignedAgentId?: string; // agent's email — undefined = unassigned (debtors.assigned_agent_id)
  // debtors.status — 'active' unless a bank paid-file upload (applyBulkPaidFile) or manual
  // change has moved it. Queue-building filters this out the same way it already filters
  // 'removed', so a debtor the bank reports paid stops being called.
  status?: string;
  // any extra columns from the CSV land here
  extra: Record<string, string>;
  // Numbers an agent has added after the upload (see addDebtorPhone) — separate from the CSV's
  // own phone_alternate column, which nothing in the app ever writes to.
  altPhones: string[];
  // Set once this debtor row has been carried forward from a closed portfolio via a 'carried'
  // retention request — see reconcileRetainedDebtors() below. retainedFrom is the old
  // portfolio's name, for the "★ Retained · from {name}" badge.
  retained?: boolean;
  retainedFrom?: string;
}

// Moved here (from dashboard.call-queue.tsx) — call mode is a property of the portfolio,
// not a single global constant.
export type CallMode = "hybrid" | "ai_only" | "agent_only" | "ivr_agent";

export interface PortfolioSettings {
  callMode: CallMode;
  dialerMode: "predictive" | "productive" | "preview" | "power" | "manual";
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
  // Set on a NEW portfolio at upload time when a manager says "this continues that old cycle" —
  // triggers reconcileRetainedDebtors() in createPortfolio(). See migrations/20260813_retention_requests.sql.
  replacesPortfolioId?: string;
  // Stamped on the OLD portfolio once its replacement lands. Closed portfolios' remaining
  // (non-carried) debtors drop out of buildAssignedQueue — they were recalled, not retained.
  closedAt?: string;
  // Manager-set target end date (YYYY-MM-DD, IST) for this cycle — see isPortfolioEnded() and
  // migrations/20260905_portfolio_end_date.sql. Purely a target; nothing stamps closedAt when
  // it passes, so the portfolio and its rows stay intact and editable, it just stops counting
  // as "open" wherever isPortfolioEnded() is checked (the active call queue, team picker).
  endDate?: string;
  // Snapshot of portfolios.total_accounts, independent of `rows` — needed because a closed
  // portfolio's `rows` are deliberately emptied below to protect the localStorage quota, which
  // would otherwise make a closed portfolio look like it has 0 accounts everywhere it's still
  // shown (Portfolio Overview now lists closed portfolios — see visibleToTeam in
  // manager.portfolio.tsx).
  storedTotalAccounts?: number;
  // Populated from the portfolio_debtor_aggregates() SQL rollup (migrations/
  // 20260908_portfolio_debtor_aggregates.sql) — a closed portfolio's `rows` are emptied above,
  // so totalOutstanding/totalPrincipal/buckets/assignedAccounts computed from `rows` in
  // toPortfolio() would all read zero without this. Fetched for every portfolio, not just
  // closed ones, so toPortfolio() has one source to prefer once a portfolio's rows go empty at
  // any point in its life, not just at the moment this was added.
  closedAggregate?: PortfolioClosedAggregate;
}

export interface PortfolioClosedAggregate {
  totalAccounts: number;
  totalOutstanding: number;
  totalPrincipal: number;
  assignedAccounts: number;
  // Agent emails (mapped from agents.id via emailById, same identity every other assigned-agent
  // field in this file uses) — never raw agent uuids, so callers never need a second lookup.
  agentEmails: string[];
  retainedAccounts: number;
  retainedAmount: number;
  buckets: Record<DPDBucket, number>;
}

/** A portfolio counts as "ended" once its manager-set end date has passed, exactly like a
 * manually-closed/replaced one, for every purpose that decides what's still actively worked
 * (the call queue, team picker) — see migrations/20260905_portfolio_end_date.sql. Unlike
 * closedAt, reaching end_date never empties the portfolio's cached rows or stamps closed_at
 * itself, so it stays reviewable/editable until a manager actually closes or replaces it. */
export function isPortfolioEnded(p: { closedAt?: string; endDate?: string }): boolean {
  return !!p.closedAt || (!!p.endDate && p.endDate < todayIstKey());
}

/** Set once `portfolio_agent_targets` answers "no such table", so refreshPortfolios() stops
 * re-querying it for the rest of the session. Per-tab and deliberately not persisted — a
 * reload after the migration is applied picks the table up again. */
let portfolioAgentTargetsMissing = false;

function isMissingTableError(e: { message?: string; code?: string } | null): boolean {
  if (!e) return false;
  // PGRST205 = "Could not find the table in the schema cache"; 42P01 = undefined_table.
  return (
    e.code === "PGRST205" ||
    e.code === "42P01" ||
    /schema cache|does not exist/i.test(e.message ?? "")
  );
}

const KEY = "recoveryai_portfolios_cache";
const CHUNK_SIZE = 500; // stays comfortably under Supabase's request-size limits per insert

/**
 * Chunk size for `.in("id", [...])` FILTERS, which is a much tighter budget than CHUNK_SIZE.
 *
 * An insert sends its rows in the POST body. A filter goes in the URL query string, so 500
 * UUIDs is roughly an 18KB URL — past the 8-16KB most proxies and servers accept. The failure
 * is a 414 or a truncated filter, neither of which surfaces as a useful error.
 *
 * 100 UUIDs is about 3.7KB, which leaves real headroom.
 */
const ID_FILTER_CHUNK = 100;

/** Runs an id-filtered write in URL-safe batches. */
async function inChunks(ids: string[], run: (chunk: string[]) => Promise<void>): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_FILTER_CHUNK) {
    await run(ids.slice(i, i + ID_FILTER_CHUNK));
  }
}

const cache = createJsonCache<UploadedPortfolio>(KEY);

export function getPortfolios(): UploadedPortfolio[] {
  return cache.read();
}

/** Pulls portfolios + their debtor rows from Supabase and refreshes the local cache. Fetches
 * every debtor row the client is allowed to see (client-scoped via RLS) — paginated via
 * fetchAllRows() past PostgREST's 1000-row-per-request cap, since a single client's total
 * debtor count crosses that well before "tens of thousands". */
export async function refreshPortfolios(): Promise<void> {
  const [
    { data: portfolioRows, error: pErr },
    { data: debtorRows, error: dErr, withOptional },
    { data: agentRows },
  ] = await Promise.all([
    supabase
      .from("portfolios")
      .select("id, name, lender_name, product_type, uploaded_at, settings, team_id, manager_id")
      // Deleted-but-kept portfolios (deletePortfolio) are hidden from every portfolio list.
      .is("deleted_at", null),
    fetchDebtorsShared(),
    supabase.from("agents").select("id, email"),
  ]);
  if (pErr || dErr || !portfolioRows || !debtorRows || !agentRows) return;

  const emailById = new Map(agentRows.map((a) => [a.id, a.email]));

  // Best-effort: queried separately, and swallowed on failure (e.g. the
  // 20260806_portfolio_agent_targets.sql migration not applied yet) so a missing/broken
  // targets table never blocks the rest of the portfolio sync.
  const targetsByPortfolio = new Map<string, Record<string, AgentTarget>>();
  try {
    const { data: targetRows, error: tErr } = portfolioAgentTargetsMissing
      ? { data: null, error: null }
      : await supabase
          .from("portfolio_agent_targets")
          .select("portfolio_id, agent_id, target_amount, target_accounts");
    // PostgREST answers 404/PGRST205 for a table that isn't in the schema cache at all —
    // i.e. the migration has never been applied here. That will not fix itself mid-session,
    // so stop asking: this fired on every refresh from every open page and was the bulk of
    // the console noise in production on 2026-08-22.
    if (tErr && isMissingTableError(tErr)) portfolioAgentTargetsMissing = true;
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

  // The three blocks below read newer debtor columns. Normally they arrived on the main read
  // (fetchDebtorsShared's OPTIONAL_COLUMNS, `withOptional`); each block's own whole-table pass
  // now runs only on a database missing one of them. Those passes cost 90 extra requests per
  // refresh for a 29,813-debtor company (2026-10-18).
  const fromMainRead = { data: debtorRows, error: null };

  // Best-effort, same reasoning as targetsByPortfolio above: alt_phones is a newer column
  // (migrations/20260807_debtors_alt_phones.sql) that may not exist in the live DB yet —
  // queried separately and defaulted to [] on failure so it never blocks portfolio sync.
  const altPhonesById = new Map<string, string[]>();
  try {
    const { data: altRows, error: aErr } = withOptional
      ? fromMainRead
      : await fetchAllRows((from, to) =>
          supabase.from("debtors").select("id, alt_phones").range(from, to),
        );
    if (!aErr && altRows) {
      for (const r of altRows) {
        altPhonesById.set(r.id as string, (r.alt_phones as string[] | null) ?? []);
      }
    }
  } catch {
    // ignore — alt phones are supplementary until the migration is applied
  }

  // Best-effort, same reasoning: principal_amount/emi_amount/product_code are newer columns
  // (migrations/20260905_debtors_principal_amount.sql, 20260908_debtors_emi_product_code.sql)
  // that may not exist in the live DB yet — queried together, separately from the main select,
  // and defaulted to 0/"" on failure so a missing migration never blocks portfolio sync.
  const principalAmountById = new Map<string, number>();
  const emiAmountById = new Map<string, number>();
  const productCodeById = new Map<string, string>();
  try {
    const { data: principalRows, error: prErr } = withOptional
      ? fromMainRead
      : await fetchAllRows((from, to) =>
          supabase
            .from("debtors")
            .select("id, principal_amount, emi_amount, product_code")
            .range(from, to),
        );
    if (!prErr && principalRows) {
      for (const r of principalRows) {
        principalAmountById.set(r.id as string, Number(r.principal_amount ?? 0));
        emiAmountById.set(r.id as string, Number(r.emi_amount ?? 0));
        productCodeById.set(r.id as string, (r.product_code as string | null) ?? "");
      }
    }
  } catch {
    // ignore — these fields are supplementary until the migration is applied
  }

  // Best-effort, same reasoning: replaces_portfolio_id/closed_at/retained_from_portfolio_id
  // are new columns (migrations/20260813_retention_requests.sql) that may not exist yet. end_date
  // (migrations/20260905_portfolio_end_date.sql) and total_accounts ride along on the same query
  // for the same reason, and because total_accounts is what lets a closed portfolio still show
  // its real account count once its `rows` are emptied below.
  const closeInfoByPortfolio = new Map<
    string,
    { replacesPortfolioId?: string; closedAt?: string; endDate?: string; totalAccounts?: number }
  >();
  const retainedFromById = new Map<string, string>(); // debtor id -> old portfolio id
  try {
    const [{ data: cycleRows, error: cErr }, { data: retRows, error: rErr }] = await Promise.all([
      supabase
        .from("portfolios")
        .select("id, replaces_portfolio_id, closed_at, end_date, total_accounts"),
      withOptional
        ? fromMainRead
        : fetchAllRows((from, to) =>
            supabase.from("debtors").select("id, retained_from_portfolio_id").range(from, to),
          ),
    ]);
    if (!cErr && cycleRows) {
      for (const p of cycleRows) {
        closeInfoByPortfolio.set(p.id as string, {
          replacesPortfolioId: (p.replaces_portfolio_id as string | null) ?? undefined,
          closedAt: (p.closed_at as string | null) ?? undefined,
          endDate: (p.end_date as string | null) ?? undefined,
          totalAccounts: (p.total_accounts as number | null) ?? undefined,
        });
      }
    }
    if (!rErr && retRows) {
      for (const r of retRows) {
        if (r.retained_from_portfolio_id) {
          retainedFromById.set(r.id as string, r.retained_from_portfolio_id as string);
        }
      }
    }
  } catch {
    // ignore — retention carry-forward is supplementary until the migration is applied
  }
  const portfolioNameById = new Map(portfolioRows.map((p) => [p.id as string, p.name as string]));

  // Best-effort, same reasoning: portfolio_debtor_aggregates() is a newer RPC
  // (migrations/20260908_portfolio_debtor_aggregates.sql) that may not exist in the live DB yet.
  // A single grouped query over every debtor's numeric columns (no `extra`, no name/phone) —
  // cheap even at full debtor-table scale, unlike materialising every closed portfolio's rows
  // (see the comment on `rows` below).
  const aggregateByPortfolio = new Map<string, PortfolioClosedAggregate>();
  try {
    const { data: aggRows, error: aggErr } = await supabase.rpc("portfolio_debtor_aggregates");
    if (!aggErr && aggRows) {
      for (const r of aggRows as Record<string, unknown>[]) {
        const portfolioId = r.portfolio_id as string | null;
        if (!portfolioId) continue;
        const agentIds = (r.agent_ids as string[] | null) ?? [];
        aggregateByPortfolio.set(portfolioId, {
          totalAccounts: Number(r.total_accounts ?? 0),
          totalOutstanding: Number(r.total_outstanding ?? 0),
          totalPrincipal: Number(r.total_principal ?? 0),
          assignedAccounts: Number(r.assigned_accounts ?? 0),
          agentEmails: agentIds.map((id) => emailById.get(id)).filter((e): e is string => !!e),
          retainedAccounts: Number(r.retained_accounts ?? 0),
          retainedAmount: Number(r.retained_amount ?? 0),
          buckets: {
            X: Number(r.bucket_x ?? 0),
            "1": Number(r.bucket_1 ?? 0),
            "2": Number(r.bucket_2 ?? 0),
            NPA: Number(r.bucket_npa ?? 0),
            WriteOff: Number(r.bucket_writeoff ?? 0),
          },
        });
      }
    }
  } catch {
    // ignore — the aggregate rollup is supplementary until the migration is applied
  }

  const portfolios: UploadedPortfolio[] = portfolioRows.map((p) => ({
    id: p.id,
    name: p.name,
    lender: p.lender_name ?? "",
    product: p.product_type ? (PRODUCT_ENUM_TO_LABEL[p.product_type] ?? p.product_type) : "",
    uploadedAt: p.uploaded_at ?? "",
    managerId: p.manager_id ? emailById.get(p.manager_id) : undefined,
    teamId: p.team_id ?? undefined,
    settings: (p.settings as unknown as PortfolioSettings) ?? DEFAULT_PORTFOLIO_SETTINGS,
    agentTargets: targetsByPortfolio.get(p.id) ?? {},
    replacesPortfolioId: closeInfoByPortfolio.get(p.id)?.replacesPortfolioId,
    closedAt: closeInfoByPortfolio.get(p.id)?.closedAt,
    endDate: closeInfoByPortfolio.get(p.id)?.endDate,
    storedTotalAccounts: closeInfoByPortfolio.get(p.id)?.totalAccounts,
    closedAggregate: aggregateByPortfolio.get(p.id),
    // A closed cycle's debtor rows are carried as [] rather than materialised. Every consumer
    // of this cache already skips closed portfolios — buildAssignedQueue `continue`s on
    // closedAt, and the team picker, Portfolio Overview and the upload page all filter
    // `!p.closedAt` — so nothing renders them, yet they dominated the cache: five of the six
    // 1,064-row portfolios live on 2026-08-22 were closed cycles of the same file, and with
    // ~150 unmapped `extra` columns per debtor they pushed recoveryai_portfolios_cache to
    // 7.5MB and over the localStorage quota on every refresh.
    //
    // The portfolio itself (id, name, closedAt, settings) is kept, so reopenPortfolio() and
    // the retention/"continues that cycle" pickers still list it — reopening clears closed_at
    // and the next refresh materialises its rows again.
    rows: closeInfoByPortfolio.get(p.id)?.closedAt
      ? []
      : debtorRows
          // Soft-removed debtors (see removeDebtor()) are excluded from every normal view — call
          // queue, portfolio counts, assignment/transfer — without touching their call_logs/
          // payments/etc. history. Recoverable via getRemovedDebtors()/restoreDebtor().
          .filter((d) => d.portfolio_id === p.id && d.status !== "removed")
          .map((d) => {
            const retainedFromPortfolioId = retainedFromById.get(d.id);
            return {
              id: d.id,
              loanReference: d.loan_reference ?? d.id,
              name: d.name,
              phone: d.phone_primary,
              loanAmount: Number(d.loan_amount ?? 0),
              principalAmount: principalAmountById.get(d.id) ?? 0,
              emiAmount: emiAmountById.get(d.id) ?? 0,
              productCode: productCodeById.get(d.id) ?? "",
              dpd: d.dpd ?? 0,
              bucket: dpd2bucket(d.dpd ?? 0),
              email: d.email ?? "",
              assignedAgentId: d.assigned_agent_id ? emailById.get(d.assigned_agent_id) : undefined,
              status: d.status ?? undefined,
              extra: (d.extra as Record<string, string>) ?? {},
              altPhones: altPhonesById.get(d.id) ?? [],
              retained: !!retainedFromPortfolioId,
              retainedFrom: retainedFromPortfolioId
                ? portfolioNameById.get(retainedFromPortfolioId)
                : undefined,
            };
          }),
  }));

  if (!cache.write(portfolios)) {
    // The full debtor dataset across every portfolio a client has can exceed localStorage's
    // ~5-10MB quota. Not a crash: this tab keeps working correctly off the cache's in-memory
    // fallback; cross-tab live sync just pauses until the dataset shrinks.
    console.warn(
      "[portfolio-store] localStorage quota exceeded — serving portfolios from memory only for this tab",
    );
  }
  window.dispatchEvent(new CustomEvent("portfolios-updated"));
}

/** When a new upload replaces an old cycle (p.replacesPortfolioId), matches every 'sent_to_bank'
 * retention request on the old portfolio against the new CSV by loan_reference. A match updates
 * the EXISTING debtor row in place (new portfolio_id, refreshed fields, retained_from_portfolio_id
 * set) instead of inserting a new one — that's what keeps call_logs/messages/payments/disputes
 * attached, since they're all keyed off debtor_id and this way it never changes. Marks each
 * matched request 'carried' and every unmatched sent_to_bank request 'not_honored' — the bank
 * didn't include it, so the account is recalled like any other, not silently left dangling in
 * 'sent_to_bank' forever. Does NOT close the old portfolio itself — createPortfolio() does that
 * unconditionally right after calling this, since the common case (no retention requests were
 * ever filed) used to return early here and skip it, silently leaving both portfolios active
 * with a full duplicate set of accounts each. Best-effort: if retention_requests or the new
 * columns don't exist yet (migration not applied), this is a no-op and every row inserts
 * fresh, same as before this feature existed. */
async function reconcileRetainedDebtors(
  oldPortfolioId: string,
  newPortfolioId: string,
  rows: UploadedDebtor[],
  assignedIdFor: Map<string, string>,
): Promise<{ handledRowIds: Set<string>; carried: number }> {
  const handledRowIds = new Set<string>();
  try {
    const { data: sentRequests, error: reqErr } = await supabase
      .from("retention_requests")
      .select("id, debtor_id")
      .eq("portfolio_id", oldPortfolioId)
      .eq("status", "sent_to_bank");
    if (reqErr || !sentRequests?.length) return { handledRowIds, carried: 0 };

    const debtorIds = sentRequests.map((r) => r.debtor_id as string);
    const { data: oldDebtors, error: oldErr } = await fetchAllRows((from, to) =>
      supabase.from("debtors").select("id, loan_reference").in("id", debtorIds).range(from, to),
    );
    if (oldErr || !oldDebtors) return { handledRowIds, carried: 0 };

    const requestIdByDebtorId = new Map(
      sentRequests.map((r) => [r.debtor_id as string, r.id as string]),
    );
    // loan_reference (normalized) -> {oldDebtorId, requestId}
    const byLoanRef = new Map<string, { oldDebtorId: string; requestId: string }>();
    for (const d of oldDebtors) {
      const ref = (d.loan_reference as string | null)?.trim().toLowerCase();
      const requestId = requestIdByDebtorId.get(d.id as string);
      if (ref && requestId) byLoanRef.set(ref, { oldDebtorId: d.id as string, requestId });
    }

    const matchedRequestIds = new Set<string>();
    for (const row of rows) {
      const ref = row.loanReference.trim().toLowerCase();
      const match = ref ? byLoanRef.get(ref) : undefined;
      if (!match) continue;

      const { error: updErr } = await supabase
        .from("debtors")
        .update({
          portfolio_id: newPortfolioId,
          retained_from_portfolio_id: oldPortfolioId,
          assigned_agent_id: assignedIdFor.get(row.id) ?? null,
          name: row.name,
          phone_primary: row.phone,
          email: row.email || null,
          loan_amount: row.loanAmount,
          outstanding_balance: row.loanAmount,
          principal_amount: row.principalAmount,
          emi_amount: row.emiAmount,
          product_code: row.productCode || null,
          dpd: row.dpd,
          status: "active",
          extra: row.extra,
        })
        .eq("id", match.oldDebtorId);
      if (updErr) continue; // one bad row shouldn't sink the whole reconciliation

      await supabase
        .from("retention_requests")
        .update({ status: "carried", carried_at: new Date().toISOString() })
        .eq("id", match.requestId);
      handledRowIds.add(row.id);
      matchedRequestIds.add(match.requestId);
    }

    const unmatchedIds = sentRequests
      .map((r) => r.id as string)
      .filter((id) => !matchedRequestIds.has(id));
    if (unmatchedIds.length) {
      await supabase
        .from("retention_requests")
        .update({ status: "not_honored" })
        .in("id", unmatchedIds);
    }

    return { handledRowIds, carried: handledRowIds.size };
  } catch {
    return { handledRowIds, carried: 0 };
  }
}

/** Creates a brand-new portfolio and inserts all of its debtor rows in one go — used once,
 * at upload time. `allocation` (agent email -> debtor IDs) is optional and, when given, sets
 * each debtor's assigned_agent_id at insert time instead of a separate follow-up write.
 * When p.replacesPortfolioId is set, rows matching a 'sent_to_bank' retention request on that
 * old portfolio are carried forward (see reconcileRetainedDebtors) instead of inserted fresh. */
export async function createPortfolio(
  p: UploadedPortfolio,
  allocation: Record<string, string[]> = {},
): Promise<{ uploaded: number; skipped: number; carried: number }> {
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

  // debtors.name/phone_primary are the only NOT NULL columns among the uploaded fields — a
  // row missing either would fail the insert outright. Skip just those rows (reported back
  // to the caller) rather than failing the whole batch over a handful of bad rows; everything
  // else the manager can fix later (Remap Fields) without needing a clean file from the start.
  const uploadable = p.rows.filter((r) => r.name.trim() && r.phone.trim());
  const skipped = p.rows.length - uploadable.length;

  const { error: pErr } = await supabase.from("portfolios").insert({
    id: p.id,
    client_id: me?.client_id,
    name: p.name,
    lender_name: p.lender,
    product_type: p.product ? (PRODUCT_LABEL_TO_ENUM[p.product] ?? null) : null,
    uploaded_by: me?.id,
    total_accounts: uploadable.length,
    manager_id: managerAgentId,
    team_id: p.teamId,
    // jsonb column: the generated Json type has no index signature, PortfolioSettings does
    // not satisfy it structurally, and neither is wrong — this is the seam between them.
    settings: p.settings as unknown as Json,
    replaces_portfolio_id: p.replacesPortfolioId ?? null,
    end_date: p.endDate ?? null,
  });
  if (pErr) throw pErr;

  let carried = 0;
  let toInsert = uploadable;
  if (p.replacesPortfolioId) {
    const result = await reconcileRetainedDebtors(
      p.replacesPortfolioId,
      p.id,
      uploadable,
      assignedIdFor,
    );
    carried = result.carried;
    if (result.handledRowIds.size) {
      toInsert = uploadable.filter((r) => !result.handledRowIds.has(r.id));
    }
    // Unconditional, regardless of whether there was anything to carry forward — this used to
    // live inside reconcileRetainedDebtors() and only run when sentRequests was non-empty, so
    // the common case (a manager just picking "continues portfolio" without ever filing a
    // retention request) silently left the old portfolio open with a full duplicate set of
    // accounts alongside the new one.
    const { error: closeErr } = await supabase
      .from("portfolios")
      .update({ closed_at: new Date().toISOString() })
      .eq("id", p.replacesPortfolioId);
    if (closeErr) throw closeErr;
  }

  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE).map((r) => ({
      id: r.id,
      client_id: me?.client_id ?? null,
      portfolio_id: p.id,
      assigned_agent_id: assignedIdFor.get(r.id) ?? null,
      name: r.name,
      phone_primary: r.phone,
      email: r.email || null,
      loan_amount: r.loanAmount,
      outstanding_balance: r.loanAmount,
      principal_amount: r.principalAmount,
      emi_amount: r.emiAmount,
      product_code: r.productCode || null,
      dpd: r.dpd,
      loan_reference: r.loanReference,
      extra: r.extra,
    }));
    const { error: dErr } = await supabase.from("debtors").insert(chunk);
    if (dErr) throw dErr;
  }

  await refreshPortfolios();
  if (carried > 0) await refreshRetentionRequests();
  return { uploaded: toInsert.length, skipped, carried };
}

/** Merges a re-uploaded/appended CSV into an existing portfolio: a row whose Loan/Account ID
 * matches an existing debtor updates that debtor's data (name/phone/amount/dpd/email/extra);
 * an unmatched row is inserted as a new, unassigned debtor. Never touches assigned_agent_id on
 * a matched one — reassignment stays a separate, deliberate step (Reassign / per-account
 * transfer), not a side effect of fixing a typo in the source file.
 *
 * By default nothing is ever removed — a re-upload is additive/corrective only. Passing
 * `removeMissing: true` switches to sync semantics: the new file becomes the authoritative
 * account list, and any existing *active* debtor whose Loan/Account ID doesn't appear anywhere
 * in `rows` gets soft-removed (status 'removed', same reversible mechanism as removeDebtor() —
 * recoverable from the Removed Accounts panel). That includes debtors with no Loan/Account ID
 * at all (e.g. added by hand via "Add One"), since there's no way for those to ever match a
 * file row — callers must warn about that explicitly before opting in. */
export async function mergePortfolioRows(
  portfolioId: string,
  rows: UploadedDebtor[],
  options: { removeMissing?: boolean } = {},
): Promise<{ updated: number; added: number; skipped: number; removed: number }> {
  const me = await getMyAgentRow();
  const { data: existing, error: exErr } = await fetchAllRows((from, to) =>
    supabase
      .from("debtors")
      .select("id, loan_reference, status")
      .eq("portfolio_id", portfolioId)
      .range(from, to),
  );
  if (exErr) throw exErr;

  const idByLoanRef = new Map(
    (existing ?? [])
      .filter((d) => d.loan_reference)
      .map((d) => [(d.loan_reference as string).trim().toLowerCase(), d.id as string]),
  );

  const toUpdate: { id: string; row: UploadedDebtor }[] = [];
  const toInsert: UploadedDebtor[] = [];
  let skipped = 0;
  for (const r of rows) {
    const existingId = idByLoanRef.get(r.loanReference.trim().toLowerCase());
    if (existingId) {
      toUpdate.push({ id: existingId, row: r });
    } else if (r.name.trim() && r.phone.trim()) {
      toInsert.push(r);
    } else {
      // No existing account to update and not enough to create a new one — skip rather than
      // insert a blank-name/blank-phone row.
      skipped++;
    }
  }

  // Updates touch different rows with the same shape, so they can run concurrently — chunked
  // to avoid opening hundreds of simultaneous requests on a large re-upload.
  for (let i = 0; i < toUpdate.length; i += CHUNK_SIZE) {
    const chunk = toUpdate.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map(({ id, row }) => {
        // A blank cell in the re-uploaded row shouldn't blow away a perfectly good existing
        // name/phone — only overwrite when the new value actually has something in it.
        const update: Record<string, unknown> = {
          email: row.email || null,
          loan_amount: row.loanAmount,
          outstanding_balance: row.loanAmount,
          principal_amount: row.principalAmount,
          emi_amount: row.emiAmount,
          product_code: row.productCode || null,
          dpd: row.dpd,
          extra: row.extra,
        };
        if (row.name.trim()) update.name = row.name;
        if (row.phone.trim()) update.phone_primary = row.phone;
        return supabase
          .from("debtors")
          .update(update as Database["public"]["Tables"]["debtors"]["Update"])
          .eq("id", id);
      }),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw failed.error;
  }

  for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
    const chunk = toInsert.slice(i, i + CHUNK_SIZE).map((r) => ({
      id: r.id,
      client_id: me?.client_id ?? null,
      portfolio_id: portfolioId,
      assigned_agent_id: null,
      name: r.name,
      phone_primary: r.phone,
      email: r.email || null,
      loan_amount: r.loanAmount,
      outstanding_balance: r.loanAmount,
      principal_amount: r.principalAmount,
      emi_amount: r.emiAmount,
      product_code: r.productCode || null,
      dpd: r.dpd,
      loan_reference: r.loanReference,
      extra: r.extra,
    }));
    const { error } = await supabase.from("debtors").insert(chunk);
    if (error) throw error;
  }

  let removed = 0;
  if (options.removeMissing) {
    const newRefs = new Set(rows.map((r) => r.loanReference.trim().toLowerCase()).filter(Boolean));
    const toRemove = (existing ?? [])
      .filter((d) => d.status !== "removed")
      .filter((d) => {
        const ref = (d.loan_reference as string | null)?.trim().toLowerCase();
        return !ref || !newRefs.has(ref);
      })
      .map((d) => d.id as string);
    // ID_FILTER_CHUNK, not CHUNK_SIZE: this is a URL filter, not a request body.
    await inChunks(toRemove, async (chunk) => {
      const { error } = await supabase
        .from("debtors")
        .update({ status: "removed" })
        .in("id", chunk);
      if (error) throw error;
    });
    removed = toRemove.length;
  }

  await refreshPortfolios();
  return { updated: toUpdate.length, added: toInsert.length, skipped, removed };
}

export interface BulkPaidRow {
  loanReference: string;
  /** Optional. The bank's file is often just a list of the loan IDs that paid, with no
   * figures at all — in that case the account is still marked paid, but no payments row is
   * written, because there is no amount to record. */
  amount?: number;
}

export interface BulkPaidResult {
  matched: number;
  /** Of `matched`, how many carried an amount and so produced a payments row. */
  withAmount: number;
  /** Of `matched`, how many were marked paid with no financial record attached. */
  withoutAmount: number;
  alreadyPaid: number;
  notFound: number;
  /** Reconciliation of the file's own amount column, so a portal total that disagrees with
   * the spreadsheet explains itself instead of being discovered days later.
   *
   *     fileTotal = recorded + skippedAlreadyPaid + skippedNotFound
   *
   * Reported live 2026-08-22: an RBL file totalling ₹120,984 showed ₹116,484 in the portal.
   * All three skips were silent — only row COUNTS were returned, never amounts. */
  fileTotal: number;
  /** Amount actually written as payments rows. */
  recorded: number;
  /** Amount on rows whose debtor was already 'paid'. Skipping the row protects against
   * double-counting a re-uploaded file, but it also drops a genuinely NEW payment the bank
   * reports against an account that was already settled. */
  skippedAlreadyPaid: number;
  /** Amount on rows whose loan id isn't in this portfolio at all. */
  skippedNotFound: number;
  /** Loan ids appearing more than once in the file. Each occurrence is recorded separately,
   * so these INFLATE the portal total — the opposite failure, and worth seeing. */
  duplicateRefs: number;
}

/** The bank's daily paid-status file — just Loan/Account ID + amount, matched against this
 * portfolio's debtors by loan_reference (same match key mergePortfolioRows uses). A matched
 * debtor's status moves to 'paid' (drops them out of the active call queue — see
 * buildAssignedQueue's status filter). A row carrying an amount ALSO gets a `payments` row
 * with source: 'bank_reported' and agent_id: null; a row with no amount (or zero) does not,
 * because payments.amount is NOT NULL and a ₹0 record is a lie rather than a blank. The
 * amount column is optional precisely so the bank's file can be nothing but a list of the
 * loan IDs that paid — deliberately no agent credited, since the debtor didn't pay because of
 * anything an agent did on this file's upload. Already-'paid' debtors are skipped so
 * re-uploading the same daily file (or overlapping days) never double-counts a payment.
 * Requires migrations/20260811_payments_source.sql. */
export async function applyBulkPaidFile(
  portfolioId: string,
  rows: BulkPaidRow[],
): Promise<BulkPaidResult> {
  const { data: existing, error: exErr } = await fetchAllRows((from, to) =>
    supabase
      .from("debtors")
      .select("id, loan_reference, status")
      .eq("portfolio_id", portfolioId)
      .range(from, to),
  );
  if (exErr) throw exErr;

  const byLoanRef = new Map(
    (existing ?? [])
      .filter((d) => d.loan_reference)
      .map((d) => [(d.loan_reference as string).trim().toLowerCase(), d]),
  );

  const toMark: { id: string; amount?: number }[] = [];
  let alreadyPaid = 0;
  let notFound = 0;
  let skippedAlreadyPaid = 0;
  let skippedNotFound = 0;
  let duplicateRefs = 0;
  const fileTotal = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const seenRefs = new Set<string>();

  for (const r of rows) {
    const ref = r.loanReference.trim().toLowerCase();
    if (seenRefs.has(ref)) duplicateRefs++;
    seenRefs.add(ref);

    const debtor = byLoanRef.get(ref);
    if (!debtor) {
      notFound++;
      skippedNotFound += r.amount ?? 0;
      continue;
    }
    if (debtor.status === "paid") {
      alreadyPaid++;
      skippedAlreadyPaid += r.amount ?? 0;
      continue;
    }
    toMark.push({ id: debtor.id as string, amount: r.amount });
  }

  const reconciliation = { fileTotal, skippedAlreadyPaid, skippedNotFound, duplicateRefs };
  if (!toMark.length)
    return {
      matched: 0,
      withAmount: 0,
      withoutAmount: 0,
      alreadyPaid,
      notFound,
      recorded: 0,
      ...reconciliation,
    };

  const now = new Date().toISOString();
  for (let i = 0; i < toMark.length; i += CHUNK_SIZE) {
    const chunk = toMark.slice(i, i + CHUNK_SIZE);

    const { error: updateErr } = await supabase
      .from("debtors")
      .update({ status: "paid" })
      .in(
        "id",
        chunk.map((c) => c.id),
      );
    if (updateErr) throw updateErr;

    // Only rows that actually carry a figure become payments. Previously every matched row
    // did, so a file listing the whole book — the only way to use this before the amount
    // column became optional — filled the payments table with ₹0 rows.
    const priced = chunk.flatMap((c) =>
      c.amount != null && c.amount > 0 ? [{ id: c.id, amount: c.amount }] : [],
    );
    if (priced.length) {
      const { error: payErr } = await supabase.from("payments").insert(
        priced.map((c) => ({
          debtor_id: c.id,
          agent_id: null,
          amount: c.amount,
          status: "completed" as const,
          payment_type: "full" as const,
          source: "bank_reported" as const,
          notes: "Reported paid via bank file upload",
          received_at: now,
        })),
      );
      if (payErr) throw payErr;
    }
  }

  await refreshPortfolios();
  const { refreshPayments } = await import("./payments-store");
  await refreshPayments();

  const priced = toMark.filter((c) => (c.amount ?? 0) > 0);
  return {
    matched: toMark.length,
    withAmount: priced.length,
    withoutAmount: toMark.length - priced.length,
    alreadyPaid,
    notFound,
    recorded: priced.reduce((sum, c) => sum + (c.amount ?? 0), 0),
    ...reconciliation,
  };
}

/** Fixes a wrong original column mapping on data that's already been uploaded — no CSV
 * needed. `fieldMap[target] = source`: for each of the 12 canonical fields, which source
 * should actually be treated as `target` (a field mapping to itself is a no-op). `source` is
 * either another StdFieldKey (swap between our own fields) or an extraRemapSource() — a raw
 * column from the original file that was never mapped to any STD_FIELD and is still sitting
 * untouched in `extra` under its literal header name (see leftoverExtraKeys). Reads every
 * debtor's current values before writing any of them, so a straight swap (A←B, B←A) applies
 * correctly instead of the second write clobbering the first's source. Never touches
 * assigned_agent_id or status. Returns the number of debtors rewritten (0 if fieldMap is the
 * identity — nothing to do). */
export async function remapPortfolioFields(
  portfolioId: string,
  fieldMap: Record<StdFieldKey, string>,
): Promise<number> {
  if (STD_FIELDS.every((f) => fieldMap[f.key] === f.key)) return 0;

  const { data: rows, error: fetchErr } = await fetchAllRows((from, to) =>
    supabase
      .from("debtors")
      .select(
        "id, name, phone_primary, email, loan_amount, principal_amount, emi_amount, product_code, dpd, loan_reference, extra",
      )
      .eq("portfolio_id", portfolioId)
      .range(from, to),
  );
  if (fetchErr) throw fetchErr;
  if (!rows || !rows.length) return 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const results = await Promise.all(
      chunk.map((row) => {
        const prevExtra = (row.extra as Record<string, string>) ?? {};
        const oldSlots = slotsFromDebtor({
          loanReference: (row.loan_reference as string | null) ?? "",
          name: (row.name as string | null) ?? "",
          phone: (row.phone_primary as string | null) ?? "",
          loanAmount: Number(row.loan_amount ?? 0),
          principalAmount: Number(row.principal_amount ?? 0),
          emiAmount: Number(row.emi_amount ?? 0),
          productCode: (row.product_code as string | null) ?? "",
          dpd: (row.dpd as number | null) ?? 0,
          email: (row.email as string | null) ?? "",
          extra: prevExtra,
        });
        const newSlots = {} as Record<StdFieldKey, string>;
        for (const f of STD_FIELDS)
          newSlots[f.key] = resolveRemapSource(fieldMap[f.key], oldSlots, prevExtra);
        const fields = debtorFieldsFromSlots(newSlots);

        return supabase
          .from("debtors")
          .update({
            loan_reference: fields.loanReference,
            name: fields.name,
            phone_primary: fields.phone,
            email: fields.email || null,
            loan_amount: fields.loanAmount,
            outstanding_balance: fields.loanAmount,
            principal_amount: fields.principalAmount,
            emi_amount: fields.emiAmount,
            product_code: fields.productCode || null,
            dpd: fields.dpd,
            // Spread prevExtra first so any column that was never a STD_FIELD (still sitting
            // in extra from the original upload) survives the remap untouched.
            extra: { ...prevExtra, ...fields.extra },
          })
          .eq("id", row.id as string);
      }),
    );
    const failed = results.find((r) => r.error);
    if (failed?.error) throw failed.error;
  }

  await refreshPortfolios();
  return rows.length;
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
    /** null explicitly clears the end date; undefined leaves it untouched. */
    endDate?: string | null;
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
  if (patch.endDate !== undefined) update.end_date = patch.endDate;

  const { error } = await supabase
    .from("portfolios")
    .update(update as Database["public"]["Tables"]["portfolios"]["Update"])
    .eq("id", id);
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
    client_id?: string | null;
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
      client_id: me?.client_id ?? null,
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

/** "Deleting" a portfolio archives it rather than destroying it — a true hard delete isn't
 * actually safe here: call_logs/messages/payments/disputes/settlement_requests all reference
 * debtor_id with no ON DELETE cascade (same reasoning as removeDebtor()'s soft-delete above),
 * so deleting the debtors under a portfolio with any real activity would just throw a foreign
 * key violation — and for a collections platform, destroying payment/call history on purpose
 * is the wrong default regardless. Sets closed_at, the same field the retention/"continues
 * portfolio" cycle already uses, which already drops a closed portfolio's remaining debtors
 * out of the active call queue (see buildAssignedQueue) — the caller (manager.portfolio.tsx)
 * also excludes closed portfolios from the default Portfolio Overview list. Fully reversible
 * by clearing closed_at directly; nothing about the portfolio's data is touched. */
export async function closePortfolio(id: string): Promise<void> {
  const { error } = await supabase
    .from("portfolios")
    .update({ closed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
  await refreshPortfolios();
}

/** Undoes closePortfolio() / a "continues portfolio" upload: clears closed_at, so the portfolio's
 * accounts are back in the call queue and every working list. Nothing else was changed by the
 * close, so nothing else needs restoring. Added 2026-10-22, when the only way back was a
 * database edit. The button is admin-only (ReopenPortfolioButton); RLS (portfolios_update)
 * also lets a manager reopen their own portfolio, as it already lets them close one. */
export async function reopenPortfolio(id: string): Promise<void> {
  const { error } = await supabase.from("portfolios").update({ closed_at: null }).eq("id", id);
  if (error) throw error;
  await refreshPortfolios();
}

/** How much a portfolio holds — for the "this will close …" warnings. Counts only, read under
 * the caller's own RLS; a count that can't be read comes back 0 rather than failing the screen. */
export async function getPortfolioFootprint(id: string): Promise<PortfolioFootprint> {
  const count = async (q: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count: n, error } = await q;
    return error ? 0 : (n ?? 0);
  };
  const [accounts, lookups, calls] = await Promise.all([
    count(
      supabase
        .from("debtors")
        .select("id", { count: "exact", head: true })
        .eq("portfolio_id", id)
        .neq("status", "removed"),
    ),
    count(
      supabase
        .from("debtor_traces")
        .select("id, debtors!inner(portfolio_id)", { count: "exact", head: true })
        .eq("debtors.portfolio_id", id)
        .eq("state", "done"),
    ),
    count(
      supabase
        .from("call_logs")
        .select("id, debtors!inner(portfolio_id)", { count: "exact", head: true })
        .eq("debtors.portfolio_id", id),
    ),
  ]);
  return { accounts, lookups, calls };
}

/** Deletes a portfolio from Portfolio Overview. The `delete_portfolio` RPC
 * (migrations/20260928_delete_portfolio.sql) decides: a portfolio nobody has worked yet is
 * removed for real ("deleted"); one with any call/payment/Insights history is closed and hidden
 * instead ("hidden"), keeping that history for Reports. */
export async function deletePortfolio(id: string): Promise<"deleted" | "hidden"> {
  const { data, error } = await supabase.rpc("delete_portfolio", { p_portfolio_id: id });
  if (error) throw error;
  await refreshPortfolios();
  return data === "deleted" ? "deleted" : "hidden";
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
  const { data: agentRows, error: agentErr } = await supabase.from("agents").select("id, email");
  // Swallowing this left idByEmail empty, which used to mean "resolve nobody" — see below.
  if (agentErr) throw agentErr;
  const idByEmail = new Map((agentRows ?? []).map((a) => [a.email, a.id]));

  // Every agent in the allocation is resolved to a UUID BEFORE the reset below, and an
  // unresolvable one aborts the whole call.
  //
  // This loop used to sit after the reset and read `if (!agentUuid) continue;` — silently. The
  // reset is unconditional and portfolio-wide, so a roster lookup that came back short (RLS
  // scoping, a stale `agents` read, an email that no longer matches) wiped every assignment in
  // the portfolio and then declined to write the new ones. The manager's UI reported success;
  // the agent's Call Queue went to zero. Nothing logged it.
  //
  // Failing here costs a rejected click. Failing after the reset costs the assignment.
  const unresolved = Object.entries(allocation)
    .filter(([, debtorIds]) => debtorIds.length > 0)
    .map(([agentEmail]) => agentEmail)
    .filter((agentEmail) => !idByEmail.has(agentEmail));
  if (unresolved.length) {
    throw new Error(
      `Cannot assign: no agent account found for ${unresolved.join(", ")}. ` +
        `Nothing was changed — check the agent still exists under Admin → Users.`,
    );
  }

  const { error: resetErr } = await supabase
    .from("debtors")
    .update({ assigned_agent_id: null })
    .eq("portfolio_id", portfolioId);
  if (resetErr) throw resetErr;

  // Chunked. An agent holding a few thousand accounts put every one of their UUIDs into a
  // single URL filter, which is long enough to be rejected or truncated. That failure lands
  // AFTER the unconditional reset above — so the portfolio ends up with every debtor
  // unassigned, which is the exact outcome the guard above this was written to prevent.
  for (const [agentEmail, debtorIds] of Object.entries(allocation)) {
    if (!debtorIds.length) continue;
    const agentUuid = idByEmail.get(agentEmail)!;
    await inChunks(debtorIds, async (chunk) => {
      const { error } = await supabase
        .from("debtors")
        .update({ assigned_agent_id: agentUuid })
        .in("id", chunk);
      if (error) throw error;
    });
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

/** Reassigns several specific debtors to one agent (or unassigns them, when agentId is null)
 * in a single write — the multi-select complement to transferDebtor()'s one-at-a-time move and
 * assignDebtors()'s whole-portfolio re-split. Lets a manager pick, say, 5 debtors out of 200
 * and move just those, without re-splitting everyone else. */
export async function transferDebtors(debtorIds: string[], agentId: string | null): Promise<void> {
  if (!debtorIds.length) return;
  let agentUuid: string | null = null;
  if (agentId) {
    const { data: agentRows } = await supabase
      .from("agents")
      .select("id, email")
      .eq("email", agentId);
    agentUuid = agentRows?.[0]?.id ?? null;
    if (!agentUuid) throw new Error(`Agent "${agentId}" not found`);
  }
  await inChunks(debtorIds, async (chunk) => {
    const { error } = await supabase
      .from("debtors")
      .update({ assigned_agent_id: agentUuid })
      .in("id", chunk);
    if (error) throw error;
  });
  await refreshPortfolios();
}

/** Soft-removes a debtor: sets status to 'removed' rather than deleting the row, since
 * call_logs/messages/payments/disputes/settlement_requests all reference debtor_id with no
 * ON DELETE cascade — a hard delete would fail (or destroy history, if forced) for any debtor
 * who's already been contacted. refreshPortfolios() excludes 'removed' rows from its cache, so
 * this debtor disappears from the call queue, portfolio counts, and assignment/transfer UI
 * everywhere. Reversible via restoreDebtor(). Requires the 'removed' value to exist in
 * debtors.status's CHECK constraint — see migrations/20260807_debtors_removed_status.sql. */
export async function removeDebtor(debtorId: string): Promise<void> {
  const { error } = await supabase.from("debtors").update({ status: "removed" }).eq("id", debtorId);
  if (error) throw error;
  await refreshPortfolios();
}

/** Undoes removeDebtor() — brings a soft-removed debtor back into every normal view. */
export async function restoreDebtor(debtorId: string): Promise<void> {
  const { error } = await supabase.from("debtors").update({ status: "active" }).eq("id", debtorId);
  if (error) throw error;
  await refreshPortfolios();
}

export interface RemovedDebtor {
  id: string;
  name: string;
  phone: string;
  loanReference: string;
}

/** Lists soft-removed debtors for one portfolio. Queried directly (not from the cache) since
 * refreshPortfolios() deliberately excludes 'removed' rows from what it caches. */
export async function getRemovedDebtors(portfolioId: string): Promise<RemovedDebtor[]> {
  const { data, error } = await fetchAllRows((from, to) =>
    supabase
      .from("debtors")
      .select("id, name, phone_primary, loan_reference")
      .eq("portfolio_id", portfolioId)
      .eq("status", "removed")
      .range(from, to),
  );
  if (error) throw error;
  return (data ?? []).map((d) => ({
    id: d.id as string,
    name: (d.name as string | null) ?? "",
    phone: (d.phone_primary as string | null) ?? "",
    loanReference: (d.loan_reference as string | null) ?? "",
  }));
}

/** On-demand, single-portfolio row fetch for the Accounts table on a CLOSED portfolio's detail
 * view — `rows` for a closed portfolio are deliberately [] in the shared cache (localStorage
 * quota, see the `rows:` comment above in refreshPortfolios), but the debtor rows themselves are
 * still sitting in the DB under their original portfolio_id (only accounts an active retention
 * request actually carried forward move away — reconcileRetainedDebtors). Scoped to one
 * portfolio and kept in local component state, never written to the cache/localStorage, so this
 * carries none of the quota risk that made closed portfolios' rows get emptied in the first
 * place — see PortfolioDetail in portfolio-dashboard.tsx. */
export async function fetchPortfolioRows(portfolioId: string): Promise<UploadedDebtor[]> {
  const [{ data: rows, error }, { data: agentRows }] = await Promise.all([
    fetchAllRows((from, to) =>
      supabase
        .from("debtors")
        .select(
          "id, loan_reference, name, phone_primary, email, loan_amount, principal_amount, dpd, assigned_agent_id, status, retained_from_portfolio_id",
        )
        .eq("portfolio_id", portfolioId)
        .neq("status", "removed")
        .range(from, to),
    ),
    supabase.from("agents").select("id, email"),
  ]);
  if (error) throw error;

  const emailById = new Map((agentRows ?? []).map((a) => [a.id, a.email]));
  const oldPortfolioIds = new Set(
    (rows ?? [])
      .map((d) => d.retained_from_portfolio_id as string | null)
      .filter((id): id is string => !!id),
  );
  const oldPortfolioNameById = new Map<string, string>();
  if (oldPortfolioIds.size) {
    const { data: oldPortfolios } = await supabase
      .from("portfolios")
      .select("id, name")
      .in("id", Array.from(oldPortfolioIds));
    for (const p of oldPortfolios ?? []) oldPortfolioNameById.set(p.id as string, p.name as string);
  }

  return (rows ?? []).map((d) => {
    const dpd = (d.dpd as number | null) ?? 0;
    const retainedFromId = d.retained_from_portfolio_id as string | null;
    return {
      id: d.id as string,
      loanReference: (d.loan_reference as string | null) ?? (d.id as string),
      name: (d.name as string | null) ?? "",
      phone: (d.phone_primary as string | null) ?? "",
      loanAmount: Number(d.loan_amount ?? 0),
      principalAmount: Number(d.principal_amount ?? 0),
      emiAmount: 0,
      productCode: "",
      dpd,
      bucket: dpd2bucket(dpd),
      email: (d.email as string | null) ?? "",
      assignedAgentId: d.assigned_agent_id
        ? emailById.get(d.assigned_agent_id as string)
        : undefined,
      status: (d.status as string | null) ?? undefined,
      extra: {},
      altPhones: [],
      retained: !!retainedFromId,
      retainedFrom: retainedFromId ? oldPortfolioNameById.get(retainedFromId) : undefined,
    };
  });
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

/** Adds a number an agent has learned (e.g. from the debtor or a family member during a call)
 * to a debtor's alt_phones list. Read-modify-write on the current array rather than a raw SQL
 * append, consistent with how every other single-record edit in this file works. Throws if the
 * number is already on file (as the primary or an existing alt) so the UI can surface that
 * instead of silently no-opping. Requires migrations/20260807_debtors_alt_phones.sql. */
export async function addDebtorPhone(debtorId: string, phone: string): Promise<void> {
  const trimmed = phone.trim();
  if (!trimmed) return;
  const { data, error: fetchErr } = await supabase
    .from("debtors")
    .select("phone_primary, alt_phones")
    .eq("id", debtorId)
    .single();
  if (fetchErr) throw fetchErr;
  const existing: string[] = (data?.alt_phones as string[] | null) ?? [];
  if (data?.phone_primary === trimmed || existing.includes(trimmed)) {
    throw new Error("That number is already on file for this debtor");
  }
  const { error } = await supabase
    .from("debtors")
    .update({ alt_phones: [...existing, trimmed] })
    .eq("id", debtorId);
  if (error) throw error;
  await refreshPortfolios();
}

/** Converts one uploaded debtor row + its owning portfolio into the `Debtor` shape the
 * dashboard/call-queue UI reads — the single source of truth for that conversion so the debtor
 * profile page and the call-queue/active-call view never drift apart on which fields get
 * populated (they used to: the queue's own copy of this logic dropped everything except a
 * handful of columns, which is why debtor info looked "half" mid-call). Named fields are filled
 * in from the same `extra` sub-keys CsvImportStep always reserves (address/city/state/dob/
 * employer/income/language — language falls back to "English" when the file has no mapped
 * language column); the raw bag is also kept as `_uploadedExtra` for the generic "every CSV
 * column" fallback view the debtor page already renders. */
/**
 * Resolve a Loan/Account ID typed by an agent to the debtor it belongs to.
 *
 * This is what lets Manual Dial attach an off-queue call (an alternate number, a relative's
 * phone) to the right account instead of logging it against nothing. Without it a manual call
 * writes `debtor_id: null` and never appears on the debtor's own history.
 *
 * Matched case-insensitively and trimmed, the same normalisation `mergePortfolioRows` and
 * `reconcileRetentionRequests` use for loan_reference — so a match here means the same thing a
 * match there does.
 *
 * Scoped to the portfolios already in the cache plus any match loan-ref-lookup.ts read from the
 * database — both through RLS, so only what this user may see. An agent cannot use this to reach
 * an account they have no access to: an unknown ID simply returns null and the call proceeds
 * unmapped.
 */
export function findDebtorByLoanReference(
  ref: string,
): { row: UploadedDebtor; portfolio: UploadedPortfolio; debtor: Debtor } | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  for (const portfolio of getPortfolios()) {
    for (const row of portfolio.rows) {
      if ((row.loanReference ?? "").trim().toLowerCase() === needle) {
        return { row, portfolio, debtor: debtorFromRow(row, portfolio) };
      }
    }
  }
  // Pages no longer full-sync this cache just to have it ready (growth plan #3), so a match
  // may instead have come from a database lookup — see loan-ref-lookup.ts, which records it here.
  const looked = lookedUpLoanRefs.get(needle);
  if (looked) return { ...looked, debtor: debtorFromRow(looked.row, looked.portfolio) };
  return null;
}

const lookedUpLoanRefs = new Map<string, { row: UploadedDebtor; portfolio: UploadedPortfolio }>();

/** Called by loan-ref-lookup.ts with a match it read from the database, so the synchronous
 * findDebtorByLoanReference() above — e.g. at disposition save time — resolves it too. */
export function rememberLoanReferenceMatch(row: UploadedDebtor, portfolio: UploadedPortfolio) {
  const key = (row.loanReference ?? "").trim().toLowerCase();
  if (key) lookedUpLoanRefs.set(key, { row, portfolio });
}

/**
 * debtorId -> principal, for the POS metrics on the reports.
 *
 * Built from the portfolio cache, so it covers exactly the accounts the viewer can see — an
 * agent's map has their accounts, a manager's has their team's. An account missing from the
 * map contributes 0 rather than breaking the sum, which is the right behaviour for a debtor
 * that has since been removed from a portfolio but still has call history.
 */
export function posByDebtorMap(): Map<string, number> {
  const map = new Map<string, number>();
  for (const p of getPortfolios()) {
    for (const row of p.rows) map.set(row.id, row.loanAmount || 0);
  }
  return map;
}

export function debtorFromRow(row: UploadedDebtor, portfolio: UploadedPortfolio): Debtor {
  const extra = row.extra ?? {};
  const income = parseFloat((extra.income ?? "").replace(/[,₹\s]/g, ""));
  return {
    id: row.id,
    name: row.name || "(unknown)",
    phone: row.phone || "—",
    altPhones: row.altPhones ?? [],
    retained: row.retained ?? false,
    retainedFrom: row.retainedFrom,
    email: row.email || undefined,
    loanAmount: row.loanAmount,
    // Real data now, not the dead MOCK_DEBTORS-only field it used to be — see
    // migrations/20260905_debtors_principal_amount.sql. 0 (unset in the source file) is passed
    // through as-is rather than falling back to loanAmount here; active-call.tsx's display
    // already does that fallback for a genuinely unset amount.
    principalOutstanding: row.principalAmount || undefined,
    // Same treatment — real data via migrations/20260908_debtors_emi_product_code.sql.
    emiAmount: row.emiAmount || undefined,
    productCode: row.productCode || undefined,
    dpd: row.dpd,
    aiScore: Math.max(1, Math.min(10, Math.round(10 - row.dpd / 20))),
    scoreReason: `Uploaded via ${portfolio.lender}${portfolio.product ? ` · ${portfolio.product}` : ""}`,
    lastContacted: "—",
    portfolio: portfolio.name,
    portfolioId: portfolio.id,
    language: extra.language || "English",
    assignedAgentId: row.assignedAgentId,
    dob: extra.dob || undefined,
    city: extra.city || undefined,
    state: extra.state || undefined,
    address: extra.address || undefined,
    lender: portfolio.lender,
    loanType: portfolio.product || undefined,
    loanId: row.loanReference || undefined,
    employer: extra.employer || undefined,
    monthlyIncome: Number.isFinite(income) && income > 0 ? income : undefined,
    _uploadedExtra: extra,
    _lender: portfolio.lender,
    _product: portfolio.product,
    _loanReference: row.loanReference,
  } as Debtor & {
    _uploadedExtra?: Record<string, string>;
    _lender?: string;
    _product?: string;
    _loanReference?: string;
  };
}
