import { describe, expect, test } from "bun:test";
import { describeHoldings, planDeactivation } from "../src/lib/user-deactivation";

const base = {
  targetRole: "agent",
  targetIsSelf: false,
  openPortfolios: 0,
  teams: 0,
  transferTo: null,
  targetId: "t",
};
const mgr = (patch = {}) => ({
  id: "m2",
  role: "manager",
  isActive: true,
  sameCompany: true,
  ...patch,
});

describe("deactivating a user (user, 2026-11-21)", () => {
  test("an agent with nothing to hand over goes straight through", () => {
    expect(planDeactivation(base)).toEqual({ ok: true, transfer: false });
  });

  test("never yourself, never an admin", () => {
    expect(planDeactivation({ ...base, targetIsSelf: true })).toMatchObject({ reason: "self" });
    expect(planDeactivation({ ...base, targetRole: "admin" })).toMatchObject({ reason: "admin" });
  });

  test("a manager with portfolios or teams must hand them over first", () => {
    const r = planDeactivation({ ...base, targetRole: "manager", openPortfolios: 4, teams: 1 });
    expect(r).toMatchObject({ ok: false, reason: "needs_transfer", openPortfolios: 4, teams: 1 });
    expect(
      planDeactivation({ ...base, targetRole: "manager", openPortfolios: 4, transferTo: mgr() }),
    ).toEqual({ ok: true, transfer: true });
  });

  test("only to another active manager of the same company", () => {
    const owns = { ...base, targetRole: "manager", openPortfolios: 1 };
    for (const bad of [
      mgr({ id: "t" }),
      mgr({ role: "agent" }),
      mgr({ isActive: false }),
      mgr({ sameCompany: false }),
    ])
      expect(planDeactivation({ ...owns, transferTo: bad })).toMatchObject({
        reason: "bad_transfer",
      });
  });

  test("describes what is being handed over", () => {
    expect(describeHoldings(4, 1)).toBe("4 open portfolios and 1 team");
    expect(describeHoldings(1, 0)).toBe("1 open portfolio");
  });
});
