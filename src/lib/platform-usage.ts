// Platform usage for the superadmin portal — how much each company uses SamvadX's own
// features (calling and Insights), and nothing about the company's own business.
//
// ⚠️ Deliberately NO collections: no payments, no promise amounts, no recovery figures. What a
// company collects from its borrowers is the company's business, not the platform's (product
// decision, 2026-10-09). Call OUTCOMES are only used to tell a contact from a non-contact.
//
// Pure: takes rows already fetched by platform-usage.server.ts and returns the report, so the
// rules (windows, contact rate, health labels, attention list) are testable without a database.

import { istDayKey } from "./monthly-trend";
import type { DateRange } from "./date-filter";
import { previousRange, rangeDays, rangeInstants, shiftDay } from "./superadmin-range";

/** Outcomes where nobody was reached. Every other logged outcome means the agent spoke to
 *  someone — this is the only thing outcomes are used for here. */
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

export interface UsageInput {
  clients: UsageClientRow[];
  agents: UsageAgentRow[];
  calls: UsageCallRow[];
  lookups: UsageLookupRow[];
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
  const { since: currentFrom, until } = rangeInstants(range);
  const { since: previousFrom } = rangeInstants(prevRange);
  const untilMs = Math.min(new Date(until).getTime(), now.getTime());

  const clientOfAgent = new Map<string, string>();
  for (const a of input.agents) if (a.clientId) clientOfAgent.set(a.id, a.clientId);

  interface Acc {
    cur: UsageBucket;
    prev: UsageBucket;
    curCallers: Set<string>;
    prevCallers: Set<string>;
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
        curCallers: new Set(),
        prevCallers: new Set(),
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

  const totalsCur = emptyUsageBucket();
  const totalsPrev = emptyUsageBucket();
  const totalCurCallers = new Set<string>();
  const totalPrevCallers = new Set<string>();
  let unattributedCalls = 0;

  for (const c of input.calls) {
    if (c.createdAt < previousFrom || c.createdAt >= until) continue;
    const clientId = c.agentId ? clientOfAgent.get(c.agentId) : undefined;
    const isCurrent = c.createdAt >= currentFrom;
    if (!clientId) {
      if (isCurrent) unattributedCalls += 1;
      continue;
    }
    const a = get(clientId);
    a.lastActivityAt = maxIso(a.lastActivityAt, c.createdAt);
    const contact = !!c.outcome && !NON_CONTACT_OUTCOMES.has(c.outcome);
    const seconds = Math.max(0, Number(c.durationSeconds) || 0);
    for (const [b, callers, total, totalCallers] of isCurrent
      ? ([[a.cur, a.curCallers, totalsCur, totalCurCallers]] as const)
      : ([[a.prev, a.prevCallers, totalsPrev, totalPrevCallers]] as const)) {
      for (const bucket of [b, total]) {
        bucket.calls += 1;
        if (contact) bucket.contacts += 1;
        bucket.talkSeconds += seconds;
      }
      callers.add(c.agentId!);
      totalCallers.add(c.agentId!);
    }
    if (isCurrent) {
      const d = daily.get(istDayKey(c.createdAt));
      if (d) d.calls += 1;
    }
  }

  for (const l of input.lookups) {
    if (l.createdAt < previousFrom || l.createdAt >= until) continue;
    const a = get(l.clientId);
    a.lastActivityAt = maxIso(a.lastActivityAt, l.createdAt);
    const isCurrent = l.createdAt >= currentFrom;
    for (const bucket of isCurrent ? [a.cur, totalsCur] : [a.prev, totalsPrev]) {
      bucket.lookups += 1;
      if (l.state !== "failed" && l.providerStatus === "1") bucket.lookupsFound += 1;
      bucket.insightsCharged += l.charged;
      bucket.insightsActualCost += l.actualCost;
    }
    if (isCurrent) {
      const d = daily.get(istDayKey(l.createdAt));
      if (d) d.lookups += 1;
    }
  }

  for (const ag of input.agents) {
    if (!ag.clientId || !ag.lastSignInAt) continue;
    const a = get(ag.clientId);
    a.lastSignInAt = maxIso(a.lastSignInAt, ag.lastSignInAt);
  }

  totalsCur.activeCallers = totalCurCallers.size;
  totalsPrev.activeCallers = totalPrevCallers.size;

  const companies: CompanyUsage[] = input.clients.map((c) => {
    const a = get(c.id);
    a.cur.activeCallers = a.curCallers.size;
    a.prev.activeCallers = a.prevCallers.size;
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

export function buildUserActivity(
  agents: UsageAgentRow[],
  calls: UsageCallRow[],
  lookups: UsageLookupRow[],
  range: DateRange,
): UserActivity[] {
  const { since, until } = rangeInstants(range);
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
  for (const c of calls) {
    const u = c.agentId ? byId.get(c.agentId) : undefined;
    if (!u || c.createdAt >= until) continue;
    u.lastActivityAt = maxIso(u.lastActivityAt, c.createdAt);
    if (c.createdAt < since) continue;
    u.calls += 1;
    if (c.outcome && !NON_CONTACT_OUTCOMES.has(c.outcome)) u.contacts += 1;
    u.talkSeconds += Math.max(0, Number(c.durationSeconds) || 0);
  }
  for (const l of lookups) {
    const u = l.requestedBy ? byId.get(l.requestedBy) : undefined;
    if (!u || l.createdAt >= until) continue;
    u.lastActivityAt = maxIso(u.lastActivityAt, l.createdAt);
    if (l.createdAt >= since) u.lookups += 1;
  }
  return [...byId.values()];
}
