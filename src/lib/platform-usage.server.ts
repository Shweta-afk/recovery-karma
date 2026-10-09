// Superadmin platform-usage report — feeds the Overview page and the Companies health table.
// Reads via the service-role client after verifySuperadminCaller, like superadmin-actions.
// server.ts. The rules live in platform-usage.ts (pure); this file only fetches rows.
//
// Only narrow columns over a bounded window (2 × the chosen window, max 180 days) are read, and
// aggregated here. Fine at today's volume; if call_logs grows into the millions, move the sums
// into a SQL function instead of paging rows.

import { z, tokenSchema } from "./schemas";
import { createServerFn } from "@tanstack/react-start";
import { getSupabaseAdmin, verifySuperadminCaller } from "./supabase-admin.server";
import { getService, priceFor } from "./profilex/catalogue";
import { fetchAllRows } from "./fetch-all-rows";
import {
  buildPlatformUsage,
  USAGE_WINDOWS,
  type PlatformUsageReport,
  type UsageAgentRow,
  type UsageCallRow,
  type UsageLookupRow,
  type UsageWindow,
} from "./platform-usage";

const DAY_MS = 86_400_000;

/** Postgres returns "…+00:00" with microseconds; the pure module compares ISO strings, so
 *  every timestamp is normalised to Date#toISOString's "…Z" form first. */
const iso = (v: string) => new Date(v).toISOString();

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

export const getPlatformUsage = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) =>
    z
      .object({
        accessToken: tokenSchema,
        windowDays: z
          .number()
          .int()
          .refine((n): n is UsageWindow => (USAGE_WINDOWS as readonly number[]).includes(n)),
      })
      .parse(d),
  )
  .handler(async ({ data }): Promise<PlatformUsageReport> => {
    const caller = await verifySuperadminCaller(data.accessToken);
    if (!caller) throw new Error("Not authenticated as superadmin");
    const admin = getSupabaseAdmin();
    const windowDays = data.windowDays as UsageWindow;
    const since = new Date(Date.now() - 2 * windowDays * DAY_MS).toISOString();

    interface LookupDbRow {
      client_id: string;
      service_id: string;
      state: string;
      provider_status: string | null;
      billable: boolean;
      cost: number;
      created_at: string;
    }
    const loadLookups = (table: "debtor_traces" | "insights_manual_lookups") =>
      fetchAllRows<LookupDbRow>(async (from, to) => {
        const { data: rows, error } = await admin
          .from(table)
          .select("client_id, service_id, state, provider_status, billable, cost, created_at")
          .gte("created_at", since)
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
    const loadCalls = fetchAllRows<CallDbRow>(async (from, to) => {
      const { data: rows, error } = await admin
        .from("call_logs")
        .select("agent_id, created_at, outcome, duration_seconds")
        .gte("created_at", since)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      return { data: rows as unknown as CallDbRow[] | null, error };
    });

    const [clientsRes, agentsRes, walletsRes, exportsRes, calls, traces, manual, signIns] =
      await Promise.all([
        admin
          .from("clients")
          .select(
            "id, company_name, status, subdomain, plan, created_at, max_agents, max_managers",
          ),
        admin.from("agents").select("id, client_id, role, is_active, auth_user_id"),
        admin.from("profilex_company_wallets").select("client_id, balance"),
        admin
          .from("insights_export_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        loadCalls,
        loadLookups("debtor_traces"),
        loadLookups("insights_manual_lookups"),
        lastSignIns(),
      ]);
    if (clientsRes.error) throw new Error(`Could not load companies (${clientsRes.error.message})`);
    if (agentsRes.error) throw new Error(`Could not load users (${agentsRes.error.message})`);
    if (calls.error) throw new Error(`Could not load calls (${calls.error.message})`);
    if (traces.error) throw new Error(`Could not load Insights lookups (${traces.error.message})`);
    // Same tolerance as getInsightsReport: a missing manual-lookups table must not blank the page.
    if (manual.error) console.error("[platform-usage] manual lookups:", manual.error.message);
    if (walletsRes.error) console.error("[platform-usage] wallets:", walletsRes.error.message);
    if (exportsRes.error)
      console.error("[platform-usage] export requests:", exportsRes.error.message);

    const toLookup = (r: LookupDbRow): UsageLookupRow => {
      const service = getService(r.service_id);
      return {
        clientId: r.client_id,
        createdAt: iso(r.created_at),
        state: r.state,
        providerStatus: r.provider_status,
        charged: Number(r.cost),
        // Same "actual cost" rule as getInsightsReport: published price when billable, else the
        // stored cost (retired service ids have no known price).
        actualCost:
          r.billable && service ? priceFor(service, r.provider_status, null) : Number(r.cost),
      };
    };

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
    const agents = (agentsRes.data ?? []) as {
      id: string;
      client_id: string | null;
      role: string;
      is_active: boolean | null;
      auth_user_id: string | null;
    }[];

    return buildPlatformUsage(
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
        agents: agents.map((a): UsageAgentRow => ({
          id: a.id,
          clientId: a.client_id,
          role: a.role,
          isActive: a.is_active,
          lastSignInAt:
            a.auth_user_id && signIns.has(a.auth_user_id)
              ? iso(signIns.get(a.auth_user_id)!)
              : null,
        })),
        calls: calls.data.map((c): UsageCallRow => ({
          agentId: c.agent_id,
          createdAt: iso(c.created_at),
          outcome: c.outcome,
          durationSeconds: c.duration_seconds,
        })),
        lookups: [...traces.data, ...(manual.error ? [] : manual.data)].map(toLookup),
        walletByClient: new Map(
          ((walletsRes.data ?? []) as { client_id: string; balance: number }[]).map((w) => [
            w.client_id,
            Number(w.balance),
          ]),
        ),
        pendingExportRequests: exportsRes.count ?? 0,
      },
      windowDays,
    );
  });
