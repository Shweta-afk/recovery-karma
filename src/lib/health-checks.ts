// Daily health check rules (2026-11-20). The SQL function platform_health_checks only COUNTS
// (migrations/20261120_platform_health_checks.sql); this file decides what is a problem, how
// serious it is, and what to tell the superadmin. Pure — tested in scripts/health-checks.test.ts.
//
// Every check here exists because the bug it catches has already happened once. When you fix a
// new class of bug, add the symptom here so it can never hide for days again.

export type Severity = "ok" | "warn" | "bad";

export interface HealthRow {
  check_id: string;
  client_id: string | null;
  subject: string | null;
  n: number;
  total: number | null;
  amount: number | null;
}

export interface HealthItem {
  severity: Exclude<Severity, "ok">;
  company: string | null;
  text: string;
}

export interface HealthCheckResult {
  id: string;
  area: "Calling" | "Insights" | "Data safety";
  title: string;
  severity: Severity;
  summary: string;
  /** What it means when this check fails. */
  why: string;
  /** What to do about it. */
  todo: string;
  items: HealthItem[];
}

interface Def {
  area: HealthCheckResult["area"];
  title: string;
  why: string;
  todo: string;
}

export const HEALTH_CHECKS: Record<string, Def> = {
  wrong_recording: {
    area: "Calling",
    title: "Recordings attached to the wrong call",
    why: "A call carries the recording of a different number. Someone could play another borrower's call.",
    todo: "Tell the developer at once — this is a call-matching bug (first seen 20 Nov 2026).",
  },
  ended_but_talked: {
    area: "Calling",
    title: "Calls ended on screen while the agent was talking",
    why: "SamvadX marked the call not connected, but the agent saved a real conversation for it — the call screen may have closed mid-call and talk time is lost.",
    todo: "A few a day can be agents choosing the wrong outcome. Many means a calling bug — tell the developer.",
  },
  stuck_open: {
    area: "Calling",
    title: "Calls stuck open",
    why: "Calls still marked as in progress 2+ hours after dialling. They hold calling lines and their end was never recorded.",
    todo: "Check whether SkyCRM's call events are arriving (webhook).",
  },
  no_end_records: {
    area: "Calling",
    title: "Extensions that never get an end-of-call record",
    why: "Every call on this extension stays without SkyCRM's end record, so connected/talk time are never known (like ext 8621).",
    todo: "Send the extension and a few call IDs to SkyCRM — the extension's setup on their side is usually the cause.",
  },
  phone_offline: {
    area: "Calling",
    title: "Agents whose phone keeps going offline",
    why: "SkyCRM reported the agent's phone as not connected, so their calls were refused.",
    todo: "Ask the agent to refresh SamvadX. If it repeats, check their computer/internet, then SkyCRM.",
  },
  calls_failed: {
    area: "Calling",
    title: "High share of failed calls",
    why: "SkyCRM ended an unusually large share of a company's calls as FAILED (normal is about 13–21%).",
    todo: "Send SkyCRM call IDs of failed calls whose numbers connected on another try.",
  },
  no_callid: {
    area: "Calling",
    title: "Calls with no SkyCRM call id",
    why: "SkyCRM's events for these calls never arrived or never matched — status, talk time and recordings will be missing.",
    todo: "Check the webhook (TELEPHONY_WEBHOOK_SECRET, SkyCRM's webhook URL) and tell the developer.",
  },
  talk_not_copied: {
    area: "Calling",
    title: "Talk time missing on connected calls",
    why: "SkyCRM says the call connected and how long it lasted, but the call log has no talk time — reports undercount.",
    todo: "Tell the developer (talk-time copy).",
  },
  recording_missing: {
    area: "Calling",
    title: "Answered calls with no recording",
    why: "SkyCRM says these calls were answered, but SamvadX has not stored their recording — auditors and the bank's Feedback File get no audio (4–20 Nov 2026: ~2,100 calls missed this way).",
    todo: "Tell the developer: the recording importer is not finding SkyCRM's call records (check the '[recordings] cdr_report' lines in Railway's logs).",
  },
  cross_company: {
    area: "Data safety",
    title: "Data crossing between companies",
    why: "A call log or Insights lookup belongs to a different company than the borrower. One company's data may be reaching another.",
    todo: "Treat as urgent — tell the developer immediately.",
  },
  insights_errors: {
    area: "Insights",
    title: "Insights lookups failing at ProfileX",
    why: "ProfileX answered with an error. These are not charged, but companies don't get the data.",
    todo: "Send ProfileX the service name and a few transaction IDs.",
  },
  profilex_wallet_empty: {
    area: "Insights",
    title: "ProfileX wallet ran out",
    why: "ProfileX refused lookups for lack of balance — every company's Insights stopped working.",
    todo: "Recharge the ProfileX wallet.",
  },
  insights_pending: {
    area: "Insights",
    title: "Lookups stuck in progress",
    why: "Lookups still 'pending' 30+ minutes later — the request may have died half-way.",
    todo: "Check with the developer; ProfileX may have charged for them.",
  },
  insights_prices: {
    area: "Insights",
    title: "Lookups charged below cost or not charged",
    why: "A company paid less than ProfileX charges SamvadX for that lookup, or paid nothing for a lookup ProfileX billed.",
    todo: "Raise that company's price for the service (Superadmin → company → Insights), or check why nothing was charged.",
  },
};

export const CHECK_ORDER = Object.keys(HEALTH_CHECKS);

const pct = (n: number, t: number) => (t > 0 ? Math.round((100 * n) / t) : 0);
const worst = (items: HealthItem[]): Severity =>
  items.some((i) => i.severity === "bad") ? "bad" : items.length ? "warn" : "ok";

/**
 * Turn the SQL counts into results. `costFor(service, status)` is ProfileX's list price for one
 * lookup (catalogue providerCost), `label(service)` its display name, `company(id)` a name.
 */
export function evaluateHealth(
  rows: HealthRow[],
  deps: {
    company: (clientId: string | null) => string | null;
    costFor: (service: string, status: string | null) => number | null;
    label: (service: string) => string;
  },
): HealthCheckResult[] {
  const by = new Map<string, HealthRow[]>();
  for (const r of rows) by.set(r.check_id, [...(by.get(r.check_id) ?? []), r]);
  const rowsOf = (id: string) => by.get(id) ?? [];
  const co = (r: HealthRow) => deps.company(r.client_id);
  const items: Record<string, HealthItem[]> = {};
  const summary: Record<string, string> = {};

  // Any at all is serious.
  for (const id of ["wrong_recording", "cross_company"]) {
    const list = rowsOf(id).filter((r) => r.n > 0);
    items[id] = list.map((r) => ({
      severity: "bad",
      company: co(r),
      text:
        id === "cross_company"
          ? `${r.n} ${r.subject === "insights" ? "Insights lookups" : "call logs"} on another company's borrower`
          : `${r.n} call(s)`,
    }));
    summary[id] = list.length ? `${list.reduce((s, r) => s + r.n, 0)} found` : "None";
  }

  {
    const list = rowsOf("ended_but_talked").filter((r) => r.n >= 5);
    items.ended_but_talked = list.map((r) => ({
      severity: r.n >= 20 ? "bad" : "warn",
      company: co(r),
      text: `${r.n} calls`,
    }));
    const all = rowsOf("ended_but_talked").reduce((s, r) => s + r.n, 0);
    summary.ended_but_talked = all ? `${all} in total` : "None";
  }

  {
    const list = rowsOf("stuck_open").filter((r) => r.n > 0);
    items.stuck_open = list.map((r) => ({
      severity: r.n >= 10 ? "bad" : "warn",
      company: co(r),
      text: `${r.n} calls still open`,
    }));
    summary.stuck_open = list.length ? `${list.reduce((s, r) => s + r.n, 0)} open` : "None";
  }

  {
    const list = rowsOf("no_end_records").filter((r) => (r.total ?? 0) >= 20 && r.n === 0);
    items.no_end_records = list.map((r) => ({
      severity: "bad",
      company: co(r),
      text: `Extension ${r.subject}: ${r.total} calls, no end record`,
    }));
    summary.no_end_records = list.length ? `${list.length} extension(s)` : "All extensions OK";
  }

  {
    const list = rowsOf("phone_offline").filter((r) => r.n >= 5);
    items.phone_offline = list.map((r) => ({
      severity: r.n >= 15 ? "bad" : "warn",
      company: co(r),
      text: `Extension ${r.subject}: refused ${r.n} times`,
    }));
    const all = rowsOf("phone_offline").reduce((s, r) => s + r.n, 0);
    summary.phone_offline = all ? `${all} refusals` : "None";
  }

  for (const [id, minTotal, warnPct, badPct] of [
    ["calls_failed", 100, 30, 45],
    ["no_callid", 50, 20, 50],
  ] as const) {
    const list = rowsOf(id).filter(
      (r) => (r.total ?? 0) >= minTotal && pct(r.n, r.total ?? 0) > warnPct,
    );
    items[id] = list.map((r) => ({
      severity: pct(r.n, r.total ?? 0) > badPct ? "bad" : "warn",
      company: co(r),
      text: `${r.n} of ${r.total} calls (${pct(r.n, r.total ?? 0)}%)`,
    }));
    const n = rowsOf(id).reduce((s, r) => s + r.n, 0);
    const t = rowsOf(id).reduce((s, r) => s + (r.total ?? 0), 0);
    summary[id] = t ? `${pct(n, t)}% of ${t} calls` : "No calls";
  }

  {
    // A few can be calls SkyCRM recorded nothing for; a large share means the importer is broken.
    const list = rowsOf("recording_missing").filter((r) => r.n >= 5 && pct(r.n, r.total ?? 0) > 5);
    items.recording_missing = list.map((r) => ({
      severity: pct(r.n, r.total ?? 0) > 20 ? "bad" : "warn",
      company: co(r),
      text: `${r.n} of ${r.total} answered calls (${pct(r.n, r.total ?? 0)}%)`,
    }));
    const n = rowsOf("recording_missing").reduce((s, r) => s + r.n, 0);
    const t = rowsOf("recording_missing").reduce((s, r) => s + (r.total ?? 0), 0);
    summary.recording_missing = t ? `${n} of ${t} answered calls` : "No answered calls";
  }

  {
    const list = rowsOf("talk_not_copied").filter((r) => r.n >= 5);
    items.talk_not_copied = list.map((r) => ({
      severity: "warn",
      company: co(r),
      text: `${r.n} calls`,
    }));
    const all = rowsOf("talk_not_copied").reduce((s, r) => s + r.n, 0);
    summary.talk_not_copied = all ? `${all} calls` : "None";
  }

  {
    const list = rowsOf("insights_errors").filter(
      (r) => (r.total ?? 0) >= 10 && pct(r.n, r.total ?? 0) > 30,
    );
    items.insights_errors = list.map((r) => ({
      severity: pct(r.n, r.total ?? 0) > 70 ? "bad" : "warn",
      company: null,
      text: `${deps.label(r.subject ?? "")}: ${r.n} of ${r.total} failed (${pct(r.n, r.total ?? 0)}%)`,
    }));
    const n = rowsOf("insights_errors").reduce((s, r) => s + r.n, 0);
    const t = rowsOf("insights_errors").reduce((s, r) => s + (r.total ?? 0), 0);
    summary.insights_errors = t ? `${n} of ${t} lookups failed` : "No lookups";
  }

  {
    const n = rowsOf("profilex_wallet_empty").reduce((s, r) => s + r.n, 0);
    items.profilex_wallet_empty = n
      ? [{ severity: "bad", company: null, text: `${n} lookups refused for lack of balance` }]
      : [];
    summary.profilex_wallet_empty = n ? `${n} refused` : "Balance OK";
  }

  {
    const list = rowsOf("insights_pending").filter((r) => r.n > 0);
    items.insights_pending = list.map((r) => ({
      severity: "warn",
      company: co(r),
      text: `${r.n} lookups`,
    }));
    summary.insights_pending = list.length ? `${list.reduce((s, r) => s + r.n, 0)} stuck` : "None";
  }

  {
    // One item per company + service: charged below ProfileX's price, or billed lookups charged ₹0.
    const agg = new Map<
      string,
      {
        client: string | null;
        service: string;
        n: number;
        zero: number;
        charged: number;
        cost: number;
      }
    >();
    for (const r of rowsOf("insights_prices")) {
      const [service, status] = (r.subject ?? "").split("|");
      const unit = deps.costFor(service, status || null);
      if (unit === null) continue;
      const key = `${r.client_id}|${service}`;
      const a = agg.get(key) ?? {
        client: r.client_id,
        service,
        n: 0,
        zero: 0,
        charged: 0,
        cost: 0,
      };
      a.n += r.n;
      a.charged += Number(r.amount ?? 0);
      a.cost += unit * r.n;
      // ₹0 lookups only count when ProfileX actually billed something for them.
      if (unit > 0) a.zero += r.total ?? 0;
      agg.set(key, a);
    }
    const list: HealthItem[] = [];
    for (const a of agg.values()) {
      const company = deps.company(a.client);
      if (a.zero > 0) {
        list.push({
          severity: "bad",
          company,
          text: `${deps.label(a.service)}: ${a.zero} billed lookups charged ₹0`,
        });
      } else if (a.charged + 0.005 < a.cost) {
        list.push({
          severity: "warn",
          company,
          text: `${deps.label(a.service)}: charged ₹${a.charged.toFixed(2)} for ${a.n} lookups that cost ₹${a.cost.toFixed(2)}`,
        });
      }
    }
    items.insights_prices = list;
    summary.insights_prices = list.length
      ? `${list.length} company/service pair(s)`
      : "All priced above cost";
  }

  return CHECK_ORDER.map((id) => {
    const def = HEALTH_CHECKS[id];
    const its = items[id] ?? [];
    return {
      id,
      ...def,
      severity: worst(its),
      summary: summary[id] ?? "",
      items: its.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "bad" ? -1 : 1)),
    };
  });
}

/** Overall status of a set of results, for the banner. */
export function overallHealth(results: HealthCheckResult[]): {
  severity: Severity;
  bad: number;
  warn: number;
} {
  const bad = results.filter((r) => r.severity === "bad").length;
  const warn = results.filter((r) => r.severity === "warn").length;
  return { severity: bad ? "bad" : warn ? "warn" : "ok", bad, warn };
}
