// Platform usage for the superadmin portal — how much each company uses SamvadX's own
// features (calling and Insights), and nothing about the company's own business.
//
// ⚠️ Deliberately NO collections: no payments, no promise amounts, no recovery figures. What a
// company collects from its borrowers is the company's business, not the platform's (product
// decision, 2026-10-09). Call OUTCOMES are only used to tell a contact from a non-contact.
//
// Pure: takes usage already summed per agent / per lookup kind (by the database function
// superadmin_usage_totals, migrations/20261009_superadmin_usage_totals.sql — or, when that is
// missing, by aggregateUsageRows below) and returns the report, so the rules (periods, contact
// rate, health labels, attention list) are testable without a database.

import { istDayKey } from "./monthly-trend";
import type { DateRange } from "./date-filter";
import { previousRange, rangeDays, rangeInstants, shiftDay } from "./superadmin-range";

/** Outcomes where nobody was reached. Every other logged outcome means the agent spoke to
 *  someone — this is the only thing outcomes are used for here. The SQL function
 *  superadmin_usage_totals applies the same rule; change both together. */
const NON_CONTACT_OUTCOMES = new Set(["no_answer", "voicemail"]);

export interface UsageClientRow {
  id: string;
  companyName: string;
  status: string;
  subdomain: string | null;
  plan: string | null;
  createdAt: string | null;
  maxAgents: number | null;
  maxManagers: number | null;
}
export interface UsageAgentRow {
  id: string;
  clientId: string | null;
  role: string;
  isActive: boolean | null;
  /** Latest Supabase Auth sign-in for this person, when known. */
  lastSignInAt: string | null;
}
export interface UsageCallRow {
  agentId: string | null;
  createdAt: string;
  outcome: string | null;
  durationSeconds: number | null;
}
export interface UsageLookupRow {
  clientId: string;
  createdAt: string;
  state: string;
  providerStatus: string | null;
  /** What the company's wallet was charged. */
  charged: number;
  /** What ProfileX actually bills us for it. */
  actualCost: number;
  /** The agents.id who ran it, when known — only used for the per-user breakdown. */
  requestedBy?: string | null;
}

/** Calls summed per (agent, company, period). */
export interface UsageCallAgg {
  agentId: string | null;
  /** The agent's company; null when the agent row is gone or has no company. */
  clientId: string | null;
  /** In the reported period (true) or the equally long one before it (false). */
  current: boolean;
  calls: number;
  contacts: number;
  talkSeconds: number;
  /** Latest call in the group (ISO, "…Z"). */
  lastAt: string;
}

/** Insights lookups summed per (company, requester, period). */
export interface UsageLookupAgg {
  clientId: string;
  requestedBy: string | null;
  current: boolean;
  lookups: number;
  found: number;
  charged: number;
  actualCost: number;
  lastAt: string;
}

/** Everything the report needs from call_logs and the lookup tables, already summed. */
export interface UsageTotals {
  calls: UsageCallAgg[];
  lookups: UsageLookupAgg[];
  /** Current period only, IST days that had any usage (missing days are filled in later). */
  daily: DailyUsage[];
}

export interface UsageInput {
  clients: UsageClientRow[];
  agents: UsageAgentRow[];
  totals: UsageTotals;
  walletByClient: Map<string, number>;
  pendingExportRequests: number;
}

/** One window's worth of feature usage. */
export interface UsageBucket {
  calls: number;
  contacts: number;
  talkSeconds: number;
  /** Distinct agents/managers who placed at least one call. */
  activeCallers: number;
  lookups: number;
  lookupsFound: number;
  insightsCharged: number;
  insightsActualCost: number;
}

export type CompanyHealth = "active" | "slowing" | "dormant" | "new" | "not_live";

export interface CompanyUsage {
  clientId: string;
  companyName: string;
  status: string;
  subdomain: string | null;
  plan: string | null;
  createdAt: string | null;
  health: CompanyHealth;
  current: UsageBucket;
  previous: UsageBucket;
  agentSeats: { used: number; max: number | null };
  managerSeats: { used: number; max: number | null };
  walletBalance: number;
  /** Latest of: a call, a lookup, anybody at the company signing in. */
  lastActivityAt: string | null;
  lastSignInAt: string | null;
}

export interface DailyUsage {
  day: string; // IST YYYY-MM-DD
  calls: number;
  lookups: number;
}

export type AttentionKind =
  "pending_approval" | "went_quiet" | "wallet_running_out" | "seat_cap" | "export_requests";

export interface AttentionItem {
  kind: AttentionKind;
  clientId: string | null;
  companyName: string | null;
  message: string;
}

export interface PlatformUsageReport {
  /** The IST days reported on (bounded), and the equally long period before it. */
  range: DateRange;
  previousRange: DateRange;
  rangeDays: number;
  generatedAt: string;
  totals: {
    current: UsageBucket;
    previous: UsageBucket;
    activeCompanies: number;
    activeCompaniesPrev: number;
    liveCompanies: number;
  };
  daily: DailyUsage[];
  companies: CompanyUsage[];
  attention: AttentionItem[];
  /** Calls whose agent row is gone or has no company — counted nowhere else. */
  unattributedCalls: number;
}

const DAY_MS = 86_400_000;
/** A company younger than this with no usage yet is "new", not "dormant". */
const NEW_COMPANY_DAYS = 14;
/** Usage below this share of the previous window counts as slowing… */
const SLOWING_RATIO = 0.6;
/** …but only once the previous window had enough activity for the drop to mean something. */
const SLOWING_MIN_PREVIOUS = 10;
/** Flag a wallet that will run dry within this many days at the current pace. */
const WALLET_RUNWAY_DAYS = 7;
/** Flag seat usage at or above this share of the cap. */
const SEAT_CAP_RATIO = 0.9;

export const emptyUsageBucket = (): UsageBucket => ({
  calls: 0,
  contacts: 0,
  talkSeconds: 0,
  activeCallers: 0,
  lookups: 0,
  lookupsFound: 0,
  insightsCharged: 0,
  insightsActualCost: 0,
});

/** Calls + lookups — the single "is this company using us" number health is judged on. */
export const usageEvents = (b: UsageBucket) => b.calls + b.lookups;

export const contactRate = (b: UsageBucket) => (b.calls > 0 ? b.contacts / b.calls : null);

/** % change from previous to current; null when there's no previous base to compare to. */
export function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}

const maxIso = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

function healthOf(
  status: string,
  createdAt: string | null,
  cur: UsageBucket,
  prev: UsageBucket,
  now: number,
): CompanyHealth {
  if (status !== "approved") return "not_live";
  const curEvents = usageEvents(cur);
  const prevEvents = usageEvents(prev);
  if (curEvents === 0) {
    const ageDays = createdAt ? (now - new Date(createdAt).getTime()) / DAY_MS : Infinity;
    return ageDays < NEW_COMPANY_DAYS && prevEvents === 0 ? "new" : "dormant";
  }
  if (prevEvents >= SLOWING_MIN_PREVIOUS && curEvents < prevEvents * SLOWING_RATIO) {
    return "slowing";
  }
  return "active";
}

/**
 * @param range bounded IST days (see superadmin-range.ts boundedRange)
 * @param today today's IST day — wallet runway is only judged when the range reaches today,
 *              since "runs out in N days" means nothing about a past month.
 */
export function buildPlatformUsage(
  input: UsageInput,
  range: DateRange,
  now: Date = new Date(),
  today: string = istDayKey(now.toISOString()),
): PlatformUsageReport {
  const windowDays = rangeDays(range);
  const prevRange = previousRange(range);
  const { until } = rangeInstants(range);
  const untilMs = Math.min(new Date(until).getTime(), now.getTime());

  interface Acc {
    cur: UsageBucket;
    prev: UsageBucket;
    lastActivityAt: string | null;
    lastSignInAt: string | null;
  }
  const acc = new Map<string, Acc>();
  const get = (clientId: string) => {
    let a = acc.get(clientId);
    if (!a) {
      a = {
        cur: emptyUsageBucket(),
        prev: emptyUsageBucket(),
        lastActivityAt: null,
        lastSignInAt: null,
      };
      acc.set(clientId, a);
    }
    return a;
  };

  // Daily series over the current window, every IST day present even when empty.
  const daily = new Map<string, DailyUsage>();
  for (let day = range.from; day <= range.to; day = shiftDay(day, 1)) {
    daily.set(day, { day, calls: 0, lookups: 0 });
  }
  for (const d of input.totals.daily) {
    const slot = daily.get(d.day);
    if (slot) {
      slot.calls += d.calls;
      slot.lookups += d.lookups;
    }
  }

  const totalsCur = emptyUsageBucket();
  const totalsPrev = emptyUsageBucket();
  let unattributedCalls = 0;

  for (const g of input.totals.calls) {
    if (!g.clientId) {
      if (g.current) unattributedCalls += g.calls;
      continue;
    }
    const a = get(g.clientId);
    a.lastActivityAt = maxIso(a.lastActivityAt, g.lastAt);
    for (const bucket of g.current ? [a.cur, totalsCur] : [a.prev, totalsPrev]) {
      bucket.calls += g.calls;
      bucket.contacts += g.contacts;
      bucket.talkSeconds += g.talkSeconds;
      // One group per agent per period, and an agent belongs to one company — so counting
      // groups counts distinct callers, for the company and for the platform alike.
      if (g.agentId && g.calls > 0) bucket.activeCallers += 1;
    }
  }

  for (const g of input.totals.lookups) {
    const a = get(g.clientId);
    a.lastActivityAt = maxIso(a.lastActivityAt, g.lastAt);
    for (const bucket of g.current ? [a.cur, totalsCur] : [a.prev, totalsPrev]) {
      bucket.lookups += g.lookups;
      bucket.lookupsFound += g.found;
      bucket.insightsCharged += g.charged;
      bucket.insightsActualCost += g.actualCost;
    }
  }

  for (const ag of input.agents) {
    if (!ag.clientId || !ag.lastSignInAt) continue;
    const a = get(ag.clientId);
    a.lastSignInAt = maxIso(a.lastSignInAt, ag.lastSignInAt);
  }

  const companies: CompanyUsage[] = input.clients.map((c) => {
    const a = get(c.id);
    const people = input.agents.filter((ag) => ag.clientId === c.id && ag.isActive !== false);
    return {
      clientId: c.id,
      companyName: c.companyName,
      status: c.status,
      subdomain: c.subdomain,
      plan: c.plan,
      createdAt: c.createdAt,
      health: healthOf(c.status, c.createdAt, a.cur, a.prev, untilMs),
      current: a.cur,
      previous: a.prev,
      // Seats count the same way setCompanyLimits enforces them: agents vs managers.
      agentSeats: { used: people.filter((p) => p.role === "agent").length, max: c.maxAgents },
      managerSeats: {
        used: people.filter((p) => p.role === "manager").length,
        max: c.maxManagers,
      },
      walletBalance: input.walletByClient.get(c.id) ?? 0,
      lastActivityAt: maxIso(a.lastActivityAt, a.lastSignInAt),
      lastSignInAt: a.lastSignInAt,
    };
  });

  const attention: AttentionItem[] = [];
  for (const c of companies) {
    if (c.status === "pending") {
      attention.push({
        kind: "pending_approval",
        clientId: c.clientId,
        companyName: c.companyName,
        message: "Waiting for approval — nobody there can sign in yet",
      });
      continue;
    }
    if (c.status !== "approved") continue;
    if (usageEvents(c.current) === 0 && usageEvents(c.previous) > 0) {
      attention.push({
        kind: "went_quiet",
        clientId: c.clientId,
        companyName: c.companyName,
        message: `No calls or lookups in this period (${usageEvents(c.previous)} in the ${windowDays} days before)`,
      });
    }
    const dailySpend = c.current.insightsCharged / windowDays;
    if (range.to >= today && dailySpend > 0) {
      const runway = c.walletBalance / dailySpend;
      if (runway < WALLET_RUNWAY_DAYS) {
        attention.push({
          kind: "wallet_running_out",
          clientId: c.clientId,
          companyName: c.companyName,
          message:
            c.walletBalance <= 0
              ? `Insights wallet is empty (₹${c.walletBalance.toFixed(2)}) and they were using it`
              : `Insights wallet ₹${c.walletBalance.toFixed(2)} lasts ~${Math.max(1, Math.floor(runway))} day(s) at current pace`,
        });
      }
    }
    for (const [label, seats] of [
      ["agent", c.agentSeats],
      ["manager", c.managerSeats],
    ] as const) {
      if (seats.max && seats.max > 0 && seats.used >= seats.max * SEAT_CAP_RATIO) {
        attention.push({
          kind: "seat_cap",
          clientId: c.clientId,
          companyName: c.companyName,
          message: `Using ${seats.used} of ${seats.max} ${label} seats`,
        });
      }
    }
  }
  if (input.pendingExportRequests > 0) {
    attention.push({
      kind: "export_requests",
      clientId: null,
      companyName: null,
      message: `${input.pendingExportRequests} Insights Excel request(s) waiting for your decision`,
    });
  }

  const live = companies.filter((c) => c.status === "approved");
  return {
    range,
    previousRange: prevRange,
    rangeDays: windowDays,
    generatedAt: now.toISOString(),
    totals: {
      current: totalsCur,
      previous: totalsPrev,
      liveCompanies: live.length,
      activeCompanies: live.filter((c) => usageEvents(c.current) > 0).length,
      activeCompaniesPrev: live.filter((c) => usageEvents(c.previous) > 0).length,
    },
    daily: [...daily.values()],
    companies,
    attention,
    unattributedCalls,
  };
}

/** One person's use of calling and Insights within a range — the company detail Users tab. */
export interface UserActivity {
  agentId: string;
  calls: number;
  contacts: number;
  talkSeconds: number;
  lookups: number;
  /** Latest call or lookup by this person in this period or the equally long one before it. */
  lastActivityAt: string | null;
  lastSignInAt: string | null;
}

export function buildUserActivity(agents: UsageAgentRow[], totals: UsageTotals): UserActivity[] {
  const byId = new Map<string, UserActivity>(
    agents.map((a) => [
      a.id,
      {
        agentId: a.id,
        calls: 0,
        contacts: 0,
        talkSeconds: 0,
        lookups: 0,
        lastActivityAt: null,
        lastSignInAt: a.lastSignInAt,
      },
    ]),
  );
  for (const g of totals.calls) {
    const u = g.agentId ? byId.get(g.agentId) : undefined;
    if (!u) continue;
    u.lastActivityAt = maxIso(u.lastActivityAt, g.lastAt);
    if (!g.current) continue;
    u.calls += g.calls;
    u.contacts += g.contacts;
    u.talkSeconds += g.talkSeconds;
  }
  for (const g of totals.lookups) {
    const u = g.requestedBy ? byId.get(g.requestedBy) : undefined;
    if (!u) continue;
    u.lastActivityAt = maxIso(u.lastActivityAt, g.lastAt);
    if (g.current) u.lookups += g.lookups;
  }
  return [...byId.values()];
}

/**
 * The JavaScript twin of the SQL function superadmin_usage_totals: sums raw rows into
 * UsageTotals. Used when the function isn't in the database yet (code deployed ahead of the
 * migration), and by the tests as the reference for what the SQL must return.
 * Rows outside [previous period start, range end) are ignored.
 */
export function aggregateUsageRows(
  calls: UsageCallRow[],
  lookups: UsageLookupRow[],
  agents: UsageAgentRow[],
  range: DateRange,
): UsageTotals {
  const { since, until } = rangeInstants(range);
  const { since: prevSince } = rangeInstants(previousRange(range));
  const clientOfAgent = new Map<string, string>();
  for (const a of agents) if (a.clientId) clientOfAgent.set(a.id, a.clientId);

  const callGroups = new Map<string, UsageCallAgg>();
  const lookupGroups = new Map<string, UsageLookupAgg>();
  const daily = new Map<string, DailyUsage>();
  const day = (iso: string) => {
    const k = istDayKey(iso);
    return daily.get(k) ?? daily.set(k, { day: k, calls: 0, lookups: 0 }).get(k)!;
  };

  for (const c of calls) {
    if (c.createdAt < prevSince || c.createdAt >= until) continue;
    const current = c.createdAt >= since;
    const clientId = (c.agentId && clientOfAgent.get(c.agentId)) || null;
    const key = `${c.agentId}|${clientId}|${current}`;
    let g = callGroups.get(key);
    if (!g) {
      g = {
        agentId: c.agentId,
        clientId,
        current,
        calls: 0,
        contacts: 0,
        talkSeconds: 0,
        lastAt: c.createdAt,
      };
      callGroups.set(key, g);
    }
    g.calls += 1;
    if (c.outcome && !NON_CONTACT_OUTCOMES.has(c.outcome)) g.contacts += 1;
    g.talkSeconds += Math.max(0, Number(c.durationSeconds) || 0);
    g.lastAt = maxIso(g.lastAt, c.createdAt)!;
    if (current && clientId) day(c.createdAt).calls += 1;
  }

  for (const l of lookups) {
    if (l.createdAt < prevSince || l.createdAt >= until) continue;
    const current = l.createdAt >= since;
    const requestedBy = l.requestedBy ?? null;
    const key = `${l.clientId}|${requestedBy}|${current}`;
    let g = lookupGroups.get(key);
    if (!g) {
      g = {
        clientId: l.clientId,
        requestedBy,
        current,
        lookups: 0,
        found: 0,
        charged: 0,
        actualCost: 0,
        lastAt: l.createdAt,
      };
      lookupGroups.set(key, g);
    }
    g.lookups += 1;
    if (l.state !== "failed" && l.providerStatus === "1") g.found += 1;
    g.charged += l.charged;
    g.actualCost += l.actualCost;
    g.lastAt = maxIso(g.lastAt, l.createdAt)!;
    if (current) day(l.createdAt).lookups += 1;
  }

  return {
    calls: [...callGroups.values()],
    lookups: [...lookupGroups.values()],
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
