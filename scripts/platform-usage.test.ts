import { describe, expect, test } from "bun:test";
import { buildPlatformUsage, type UsageInput } from "../src/lib/platform-usage";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const client = (id: string, over: Partial<UsageInput["clients"][number]> = {}) => ({
  id,
  companyName: id.toUpperCase(),
  status: "approved",
  subdomain: null,
  plan: null,
  createdAt: daysAgo(200),
  maxAgents: null,
  maxManagers: null,
  ...over,
});

const base = (over: Partial<UsageInput> = {}): UsageInput => ({
  clients: [],
  agents: [],
  calls: [],
  lookups: [],
  walletByClient: new Map(),
  pendingExportRequests: 0,
  ...over,
});

const call = (agentId: string | null, d: number, outcome = "promised", secs = 60) => ({
  agentId,
  createdAt: daysAgo(d),
  outcome,
  durationSeconds: secs,
});

const lookup = (clientId: string, d: number, found = true, charged = 10, actual = 6) => ({
  clientId,
  createdAt: daysAgo(d),
  state: "done",
  providerStatus: found ? "1" : "2",
  charged,
  actualCost: actual,
});

describe("buildPlatformUsage", () => {
  test("splits calls into current/previous windows and counts contacts", () => {
    const r = buildPlatformUsage(
      base({
        clients: [client("a")],
        agents: [{ id: "ag1", clientId: "a", role: "agent", isActive: true, lastSignInAt: null }],
        calls: [
          call("ag1", 1, "promised", 120),
          call("ag1", 2, "no_answer", 0),
          call("ag1", 3, "voicemail", 5),
          call("ag1", 10), // previous window (7-day)
          call("ag1", 20), // older than 2× window — ignored
        ],
      }),
      7,
      NOW,
    );
    const a = r.companies[0];
    expect(a.current.calls).toBe(3);
    expect(a.current.contacts).toBe(1);
    expect(a.current.talkSeconds).toBe(125);
    expect(a.current.activeCallers).toBe(1);
    expect(a.previous.calls).toBe(1);
    expect(r.totals.current.calls).toBe(3);
  });

  test("never exposes any collection amounts", () => {
    const r = buildPlatformUsage(base({ clients: [client("a")] }), 30, NOW);
    const keys = JSON.stringify(r).toLowerCase();
    for (const banned of ["promise_amount", "collected", "payment", "recovered"]) {
      expect(keys).not.toContain(banned);
    }
  });

  test("Insights lookups, found count, billed vs actual cost", () => {
    const r = buildPlatformUsage(
      base({
        clients: [client("a")],
        lookups: [lookup("a", 1), lookup("a", 2, false, 5, 1), lookup("a", 40)],
      }),
      30,
      NOW,
    );
    const a = r.companies[0];
    expect(a.current.lookups).toBe(2);
    expect(a.current.lookupsFound).toBe(1);
    expect(a.current.insightsCharged).toBe(15);
    expect(a.current.insightsActualCost).toBe(7);
    expect(a.previous.lookups).toBe(1);
  });

  test("health labels", () => {
    const agents = ["act", "slow", "dorm"].map((c) => ({
      id: `ag-${c}`,
      clientId: c,
      role: "agent",
      isActive: true,
      lastSignInAt: null,
    }));
    const calls = [
      call("ag-act", 1),
      // slowing: 2 now vs 12 before
      ...Array.from({ length: 2 }, () => call("ag-slow", 1)),
      ...Array.from({ length: 12 }, () => call("ag-slow", 10)),
      call("ag-dorm", 10),
    ];
    const r = buildPlatformUsage(
      base({
        clients: [
          client("act"),
          client("slow"),
          client("dorm"),
          client("fresh", { createdAt: daysAgo(3) }),
          client("pend", { status: "pending" }),
        ],
        agents,
        calls,
      }),
      7,
      NOW,
    );
    const health = Object.fromEntries(r.companies.map((c) => [c.clientId, c.health]));
    expect(health).toEqual({
      act: "active",
      slow: "slowing",
      dorm: "dormant",
      fresh: "new",
      pend: "not_live",
    });
    expect(r.totals.activeCompanies).toBe(2);
    expect(r.totals.liveCompanies).toBe(4);
  });

  test("attention list: pending, went quiet, wallet runway, seat cap, export requests", () => {
    const r = buildPlatformUsage(
      base({
        clients: [
          client("pend", { status: "pending" }),
          client("quiet"),
          client("wallet"),
          client("seats", { maxAgents: 10 }),
        ],
        agents: [
          { id: "q1", clientId: "quiet", role: "agent", isActive: true, lastSignInAt: null },
          ...Array.from({ length: 9 }, (_, i) => ({
            id: `s${i}`,
            clientId: "seats",
            role: "agent",
            isActive: true,
            lastSignInAt: null,
          })),
        ],
        calls: [call("q1", 40)],
        // ₹70 billed over 7 days = ₹10/day; ₹30 left = 3 days of runway
        lookups: Array.from({ length: 7 }, (_, i) => lookup("wallet", i + 0.5, true, 10, 6)),
        walletByClient: new Map([["wallet", 30]]),
        pendingExportRequests: 2,
      }),
      30,
      NOW,
    );
    const kinds = r.attention.map((a) => `${a.kind}:${a.clientId}`);
    expect(kinds).toContain("pending_approval:pend");
    expect(kinds).toContain("went_quiet:quiet");
    expect(kinds).toContain("seat_cap:seats");
    expect(kinds).toContain("export_requests:null");
    // 30-day window: ₹70/30 ≈ ₹2.33/day, ₹30 lasts ~12 days — not flagged
    expect(kinds).not.toContain("wallet_running_out:wallet");

    const r7 = buildPlatformUsage(
      base({
        clients: [client("wallet")],
        lookups: Array.from({ length: 7 }, (_, i) => lookup("wallet", i + 0.5, true, 10, 6)),
        walletByClient: new Map([["wallet", 30]]),
      }),
      7,
      NOW,
    );
    expect(r7.attention.map((a) => a.kind)).toEqual(["wallet_running_out"]);
  });

  test("calls from users with no company are counted as unattributed, not dropped silently", () => {
    const r = buildPlatformUsage(
      base({ clients: [client("a")], calls: [call(null, 1), call("ghost", 1)] }),
      7,
      NOW,
    );
    expect(r.unattributedCalls).toBe(2);
    expect(r.totals.current.calls).toBe(0);
  });

  test("daily series covers the whole window, keyed by IST day", () => {
    const r = buildPlatformUsage(
      base({
        clients: [client("a")],
        agents: [{ id: "ag", clientId: "a", role: "agent", isActive: true, lastSignInAt: null }],
        // 20:00 UTC on Oct 8 = 01:30 IST Oct 9
        calls: [
          {
            agentId: "ag",
            createdAt: "2026-10-08T20:00:00.000Z",
            outcome: "paid",
            durationSeconds: 1,
          },
        ],
      }),
      7,
      NOW,
    );
    expect(r.daily.length).toBeGreaterThanOrEqual(7);
    expect(r.daily.find((d) => d.day === "2026-10-09")?.calls).toBe(1);
    expect(r.daily.find((d) => d.day === "2026-10-08")?.calls).toBe(0);
  });
});
