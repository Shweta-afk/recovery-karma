import { describe, expect, test } from "bun:test";
import {
  CHECK_ORDER,
  HEALTH_CHECKS,
  evaluateHealth,
  overallHealth,
  type HealthRow,
} from "../src/lib/health-checks";

const deps = {
  company: (id: string | null) => (id ? `Co ${id}` : null),
  costFor: (svc: string, status: string | null) =>
    svc === "skip-tracing" ? 46 : svc === "mobile-to-uan" ? (status === "2" ? 0 : 3) : null,
  label: (svc: string) => svc,
};
const row = (p: Partial<HealthRow> & { check_id: string }): HealthRow => ({
  client_id: "a",
  subject: null,
  n: 0,
  total: null,
  amount: null,
  ...p,
});
const get = (rows: HealthRow[], id: string) => evaluateHealth(rows, deps).find((r) => r.id === id)!;

describe("health checks", () => {
  test("every check is described and listed once", () => {
    expect(new Set(CHECK_ORDER).size).toBe(CHECK_ORDER.length);
    for (const id of CHECK_ORDER) {
      expect(HEALTH_CHECKS[id].why.length).toBeGreaterThan(10);
      expect(HEALTH_CHECKS[id].todo.length).toBeGreaterThan(5);
    }
  });

  test("no rows → everything OK", () => {
    const res = evaluateHealth([], deps);
    expect(res.length).toBe(CHECK_ORDER.length);
    expect(overallHealth(res).severity).toBe("ok");
  });

  test("a single wrong recording or cross-company row is serious", () => {
    expect(get([row({ check_id: "wrong_recording", n: 1 })], "wrong_recording").severity).toBe(
      "bad",
    );
    expect(
      get([row({ check_id: "cross_company", subject: "insights", n: 1 })], "cross_company")
        .severity,
    ).toBe("bad");
  });

  test("an extension with 20+ calls and no end record is flagged; fewer calls are not", () => {
    expect(
      get(
        [row({ check_id: "no_end_records", subject: "8621", n: 0, total: 115 })],
        "no_end_records",
      ).severity,
    ).toBe("bad");
    expect(
      get([row({ check_id: "no_end_records", subject: "8621", n: 0, total: 5 })], "no_end_records")
        .severity,
    ).toBe("ok");
    expect(
      get(
        [row({ check_id: "no_end_records", subject: "8620", n: 40, total: 247 })],
        "no_end_records",
      ).severity,
    ).toBe("ok");
  });

  test("failed-call share: normal day passes, high share warns", () => {
    expect(
      get([row({ check_id: "calls_failed", n: 450, total: 2700 })], "calls_failed").severity,
    ).toBe("ok");
    expect(
      get([row({ check_id: "calls_failed", n: 1000, total: 2700 })], "calls_failed").severity,
    ).toBe("warn");
    expect(
      get([row({ check_id: "calls_failed", n: 60, total: 90 })], "calls_failed").severity,
    ).toBe("ok");
  });

  test("Insights priced below ProfileX's cost warns; billed lookups charged ₹0 are serious", () => {
    const below = get(
      [row({ check_id: "insights_prices", subject: "skip-tracing|1", n: 2, total: 0, amount: 80 })],
      "insights_prices",
    );
    expect(below.severity).toBe("warn");
    const above = get(
      [row({ check_id: "insights_prices", subject: "skip-tracing|1", n: 2, total: 0, amount: 96 })],
      "insights_prices",
    );
    expect(above.severity).toBe("ok");
    const unpaid = get(
      [row({ check_id: "insights_prices", subject: "skip-tracing|1", n: 2, total: 1, amount: 48 })],
      "insights_prices",
    );
    expect(unpaid.severity).toBe("bad");
    // A free not-found (UAN costs ₹0 when nothing is found) is not "uncharged".
    const freeMiss = get(
      [row({ check_id: "insights_prices", subject: "mobile-to-uan|2", n: 3, total: 3, amount: 0 })],
      "insights_prices",
    );
    expect(freeMiss.severity).toBe("ok");
  });

  test("ProfileX wallet running out is serious", () => {
    expect(
      get(
        [row({ check_id: "profilex_wallet_empty", client_id: null, n: 4 })],
        "profilex_wallet_empty",
      ).severity,
    ).toBe("bad");
    expect(
      get(
        [row({ check_id: "profilex_wallet_empty", client_id: null, n: 0 })],
        "profilex_wallet_empty",
      ).severity,
    ).toBe("ok");
  });
});
