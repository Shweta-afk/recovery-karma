// Superadmin platform-usage report — feeds the Overview, the Companies health table, the
// Revenue page's Insights margin and seat lists, and a company's detail page (clientId set).
// Reads via the service-role client after verifySuperadminCaller, like superadmin-actions.
// server.ts. The rules live in platform-usage.ts (pure); this file only fetches rows.
//
// The sums come from the database function superadmin_usage_totals
// (migrations/20261009_superadmin_usage_totals.sql): a few rows per agent and per lookup kind,
// whatever the call volume. If that function isn't there yet (code deployed ahead of the
// migration), this falls back to paging the raw rows of the window (the range + the equally
// long period before it, at most 2 × 366 days) and summing them with aggregateUsageRows —
// same result, just slower as volume grows.
//
// Feature usage only — never payments, promise amounts or anything a company collected.

import { z, tokenSchema, idSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { getService, priceFor } from "./profilex/catalogue";
import { fetchAllRows } from "./fetch-all-rows";
import { todayIstKey } from "./date-filter";
import {
  aggregateUsageRows,
  buildPlatformUsage,
  buildUserActivity,
  type PlatformUsageReport,
  type UsageAgentRow,
  type UsageCallRow,
  type UsageLookupRow,
  type UsageTotals,
  type UserActivity,
} from "./platform-usage";
import type { DateRange } from "./date-filter";
import {
  boundedRange,
  isDayKey,
  previousRange,
  rangeDays,
  rangeInstants,
} from "./superadmin-range";

/** Postgres returns "…+00:00" with microseconds; the pure module compares ISO strings, so
 *  every timestamp is normalised to Date#toISOString's "…Z" form first. */
const iso = (v: string) => new Date(v).toISOString();

const MAX_RANGE_DAYS = 366;

/** auth.users.last_sign_in_at by auth user id. Best-effort: a failure here only blanks the
 *  "last sign-in" column, it must not fail the whole report. */
async function lastSignIns(): Promise<Map<string, string>> {
  const admin = getSupabaseAdmin();
  const out = new Map<string, string>();
  try {
    for (let page = 1; page <= 50; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
      if (error) throw error;
      for (const u of data.users) if (u.last_sign_in_at) out.set(u.id, u.last_sign_in_at);
      if (data.users.length < 1000) break;
    }
  } catch (e) {
    console.error("[platform-usage] could not read sign-ins:", e);
  }
  return out;
}

export interface CompanyPortfolioRow {
  id: string;
  name: string;
  lenderName: string | null;
  accounts: number;
  uploadedAt: string | null;
  endDate: string | null;
  closedAt: string | null;
  open: boolean;
}

export interface PlatformUsageResponse extends PlatformUsageReport {
  /** Only when a clientId was requested: per-person activity and the company's portfolios. */
  users?: UserActivity[];
  portfolios?: CompanyPortfolioRow[];
  /** Where the sums came from — "rows" means the SQL function is missing (slower path). */
  source: "database" | "rows";
}

type Admin = ReturnType<typeof getSupabaseAdmin>;

/** "What ProfileX actually bills" for `n` lookups of one service + status: the published price
 *  when billable, else what was stored (retired service ids have no known price). Same rule as
 *  getInsightsReport. */
function actualCostOf(
  serviceId: string,
  providerStatus: string | null,
  billable: boolean,
  n: number,
  charged: number,
): number {
  const service = getService(serviceId);
  return billable && service ? n * priceFor(service, providerStatus, null) : charged;
}

interface SqlTotals {
  calls: {
    agent_id: string | null;
    client_id: string | null;
    is_current: boolean;
    calls: number;
    contacts: number;
    talk_seconds: number | string;
    last_at: string;
  }[];
  lookups: {
    client_id: string;
    requested_by: string | null;
    is_current: boolean;
    service_id: string;
    provider_status: string | null;
    failed: boolean;
    billable: boolean;
    n: number;
    charged: number | string;
    last_at: string;
  }[];
  daily: { day: string; calls: number; lookups: number }[];
}

/** Sums from superadmin_usage_totals, or null when the function doesn't exist yet. */
async function totalsFromDatabase(
  admin: Admin,
  args: { prevSince: string; since: string; until: string; clientId?: string },
): Promise<UsageTotals | null> {
  // Not in the generated Database types until they are regenerated after the migration.
  const rpc = admin.rpc as unknown as (
    fn: string,
    params: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  const { data, error } = await rpc.call(admin, "superadmin_usage_totals", {
    p_prev_since: args.prevSince,
    p_since: args.since,
    p_until: args.until,
    p_client_id: args.clientId ?? null,
  });
  if (error) {
    // PGRST202 = function not in the schema cache; 42883 = undefined_function.
    if (error.code === "PGRST202" || error.code === "42883") {
      console.warn("[platform-usage] superadmin_usage_totals missing — summing rows instead");
      return null;
    }
    throw new Error(`Could not load usage totals (${error.message})`);
  }
  const t = data as SqlTotals;
  return {
    calls: t.calls.map((g) => ({
      agentId: g.agent_id,
      clientId: g.client_id,
      current: g.is_current,
      calls: Number(g.calls),
      contacts: Number(g.contacts),
      talkSeconds: Number(g.talk_seconds),
      lastAt: iso(g.last_at),
    })),
    lookups: t.lookups.map((g) => {
      const n = Number(g.n);
      const charged = Number(g.charged);
      return {
        clientId: g.client_id,
        requestedBy: g.requested_by,
        current: g.is_current,
        lookups: n,
        found: !g.failed && g.provider_status === "1" ? n : 0,
        charged,
        actualCost: actualCostOf(g.service_id, g.provider_status, g.billable, n, charged),
        lastAt: iso(g.last_at),
      };
    }),
    daily: t.daily.map((d) => ({ day: d.day, calls: Number(d.calls), lookups: Number(d.lookups) })),
  };
}

/** The slow path: page the raw rows of the window and sum them in JavaScript. */
async function totalsFromRows(
  admin: Admin,
  args: {
    prevSince: string;
    until: string;
    clientId?: string;
    agents: UsageAgentRow[];
    range: DateRange;
  },
): Promise<UsageTotals> {
  const { prevSince, until, clientId, agents, range } = args;
  const agentIds = agents.map((a) => a.id);

  interface LookupDbRow {
    client_id: string;
    service_id: string;
    state: string;
    provider_status: string | null;
    billable: boolean;
    cost: number;
    created_at: string;
    requested_by: string | null;
  }
  const loadLookups = (table: "debtor_traces" | "insights_manual_lookups") =>
    fetchAllRows<LookupDbRow>(async (from, to) => {
      let q = admin
        .from(table)
        .select(
          "client_id, service_id, state, provider_status, billable, cost, created_at, requested_by",
        )
        .gte("created_at", prevSince)
        .lt("created_at", until);
      if (clientId) q = q.eq("client_id", clientId);
      const { data: rows, error } = await q
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      return { data: rows as unknown as LookupDbRow[] | null, error };
    });

  interface CallDbRow {
    agent_id: string | null;
    created_at: string;
    outcome: string | null;
    duration_seconds: number | null;
  }
  // Deliberately no promise_amount / payments: the superadmin sees feature usage only.
  // call_logs has no client_id, so one company's calls are found through its agents.
  const loadCalls =
    clientId && agentIds.length === 0
      ? Promise.resolve({ data: [] as CallDbRow[], error: null })
      : fetchAllRows<CallDbRow>(async (from, to) => {
          let q = admin
            .from("call_logs")
            .select("agent_id, created_at, outcome, duration_seconds")
            .gte("created_at", prevSince)
            .lt("created_at", until);
          if (clientId) q = q.in("agent_id", agentIds);
          const { data: rows, error } = await q
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: rows as unknown as CallDbRow[] | null, error };
        });

  const [calls, traces, manual] = await Promise.all([
    loadCalls,
    loadLookups("debtor_traces"),
    loadLookups("insights_manual_lookups"),
  ]);
  if (calls.error) throw new Error(`Could not load calls (${calls.error.message})`);
  if (traces.error) throw new Error(`Could not load Insights lookups (${traces.error.message})`);
  // Same tolerance as getInsightsReport: a missing manual-lookups table must not blank the page.
  if (manual.error) console.error("[platform-usage] manual lookups:", manual.error.message);

  const usageCalls = calls.data.map((c): UsageCallRow => ({
    agentId: c.agent_id,
    createdAt: iso(c.created_at),
    outcome: c.outcome,
    durationSeconds: c.duration_seconds,
  }));
  const usageLookups = [...traces.data, ...(manual.error ? [] : manual.data)].map(
    (r): UsageLookupRow => ({
      clientId: r.client_id,
      createdAt: iso(r.created_at),
      state: r.state,
      providerStatus: r.provider_status,
      charged: Number(r.cost),
      actualCost: actualCostOf(r.service_id, r.provider_status, r.billable, 1, Number(r.cost)),
      requestedBy: r.requested_by,
    }),
  );
  return aggregateUsageRows(usageCalls, usageLookups, agents, range);
}

const daySchema = z.string().refine(isDayKey, "Expected YYYY-MM-DD");

export const getPlatformUsage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        from: daySchema.optional(),
        to: daySchema.optional(),
        clientId: idSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<PlatformUsageResponse> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = getSupabaseAdmin();

    const today = todayIstKey();
    const range = boundedRange({ from: data.from ?? "", to: data.to ?? "" }, today);
    if (range.to > today) range.to = today;
    if (range.from > range.to) range.from = range.to;
    if (rangeDays(range) > MAX_RANGE_DAYS) {
      throw new Error(`Pick a range of at most ${MAX_RANGE_DAYS} days`);
    }
    const { since: prevSince } = rangeInstants(previousRange(range));
    const { since, until } = rangeInstants(range);
    const clientId = data.clientId;

    const [clientsRes, agentsRes] = await Promise.all([
      (() => {
        const q = admin
          .from("clients")
          .select(
            "id, company_name, status, subdomain, plan, created_at, max_agents, max_managers",
          );
        return clientId ? q.eq("id", clientId) : q;
      })(),
      (() => {
        const q = admin.from("agents").select("id, client_id, role, is_active, auth_user_id");
        return clientId ? q.eq("client_id", clientId) : q;
      })(),
    ]);
    if (clientsRes.error) throw new Error(`Could not load companies (${clientsRes.error.message})`);
    if (agentsRes.error) throw new Error(`Could not load users (${agentsRes.error.message})`);
    const agents = (agentsRes.data ?? []) as {
      id: string;
      client_id: string | null;
      role: string;
      is_active: boolean | null;
      auth_user_id: string | null;
    }[];

    const walletsQuery = admin.from("profilex_company_wallets").select("client_id, balance");
    const portfoliosQuery = clientId
      ? admin
          .from("portfolios")
          .select("id, name, lender_name, total_accounts, uploaded_at, end_date, closed_at")
          .eq("client_id", clientId)
          .is("deleted_at", null)
          .order("uploaded_at", { ascending: false })
      : null;

    const [walletsRes, exportsRes, sqlTotals, signIns, portfoliosRes] = await Promise.all([
      clientId ? walletsQuery.eq("client_id", clientId) : walletsQuery,
      (() => {
        const q = admin
          .from("insights_export_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending");
        return clientId ? q.eq("client_id", clientId) : q;
      })(),
      totalsFromDatabase(admin, { prevSince, since, until, clientId }),
      lastSignIns(),
      portfoliosQuery,
    ]);
    if (walletsRes.error) console.error("[platform-usage] wallets:", walletsRes.error.message);
    if (exportsRes.error)
      console.error("[platform-usage] export requests:", exportsRes.error.message);
    if (portfoliosRes?.error)
      console.error("[platform-usage] portfolios:", portfoliosRes.error.message);

    const clients = (clientsRes.data ?? []) as {
      id: string;
      company_name: string;
      status: string;
      subdomain: string | null;
      plan: string | null;
      created_at: string | null;
      max_agents: number | null;
      max_managers: number | null;
    }[];

    const usageAgents = agents.map((a): UsageAgentRow => ({
      id: a.id,
      clientId: a.client_id,
      role: a.role,
      isActive: a.is_active,
      lastSignInAt:
        a.auth_user_id && signIns.has(a.auth_user_id) ? iso(signIns.get(a.auth_user_id)!) : null,
    }));
    const totals =
      sqlTotals ??
      (await totalsFromRows(admin, { prevSince, until, clientId, agents: usageAgents, range }));

    const report: PlatformUsageResponse = {
      ...buildPlatformUsage(
        {
          clients: clients.map((c) => ({
            id: c.id,
            companyName: c.company_name,
            status: c.status,
            subdomain: c.subdomain,
            plan: c.plan,
            createdAt: c.created_at,
            maxAgents: c.max_agents,
            maxManagers: c.max_managers,
          })),
          agents: usageAgents,
          totals,
          walletByClient: new Map(
            ((walletsRes.data ?? []) as { client_id: string; balance: number }[]).map((w) => [
              w.client_id,
              Number(w.balance),
            ]),
          ),
          pendingExportRequests: exportsRes.count ?? 0,
        },
        range,
        new Date(),
        today,
      ),
      source: sqlTotals ? "database" : "rows",
    };

    if (clientId) {
      report.users = buildUserActivity(usageAgents, totals);
      report.portfolios = (
        (portfoliosRes?.data ?? []) as {
          id: string;
          name: string;
          lender_name: string | null;
          total_accounts: number | null;
          uploaded_at: string | null;
          end_date: string | null;
          closed_at: string | null;
        }[]
      ).map((p) => ({
        id: p.id,
        name: p.name,
        lenderName: p.lender_name,
        accounts: p.total_accounts ?? 0,
        uploadedAt: p.uploaded_at,
        endDate: p.end_date,
        closedAt: p.closed_at,
        // Same rule as isPortfolioEnded() in portfolio-store.ts.
        open: !p.closed_at && !(p.end_date && p.end_date < today),
      }));
    }
    return report;
  });
