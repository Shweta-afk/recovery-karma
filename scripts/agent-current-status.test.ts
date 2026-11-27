import { describe, expect, test } from "bun:test";
import { currentStatusOf, isOnBreak, statusLabel } from "../src/lib/agent-current-status";
import type { StatusInterval } from "../src/lib/agent-presence-store";

const NOW = Date.parse("2026-11-27T10:00:00Z");
const iv = (p: Partial<StatusInterval>): StatusInterval => ({
  agentId: "a@x.com",
  status: "available",
  startedAt: "2026-11-27T09:00:00Z",
  endedAt: null,
  lastSeenAt: "2026-11-27T09:59:30Z",
  ...p,
});

describe("current status from today's intervals", () => {
  test("open, recently seen interval is the status", () => {
    const s = currentStatusOf([iv({ status: "lunch" })], "a@x.com", NOW);
    expect(s?.status).toBe("lunch");
    expect(isOnBreak(s)).toBe(true);
    expect(statusLabel(s)).toBe("On lunch");
  });
  test("available is not a break", () => {
    expect(isOnBreak(currentStatusOf([iv({})], "a@x.com", NOW))).toBe(false);
  });
  test("closed intervals and other agents are ignored", () => {
    expect(
      currentStatusOf(
        [iv({ endedAt: "2026-11-27T09:30:00Z" }), iv({ agentId: "b@x.com" })],
        "a@x.com",
        NOW,
      ),
    ).toBeNull();
  });
  test("an open interval nobody heartbeated for 3+ minutes is a closed laptop, not a break", () => {
    const s = currentStatusOf(
      [iv({ status: "break", lastSeenAt: "2026-11-27T09:50:00Z" })],
      "a@x.com",
      NOW,
    );
    expect(s).toBeNull();
    expect(statusLabel(s)).toBe("Not signed in");
    expect(isOnBreak(s)).toBe(false);
  });
  test("the newest open interval wins", () => {
    const s = currentStatusOf(
      [iv({ status: "available" }), iv({ status: "break", startedAt: "2026-11-27T09:40:00Z" })],
      "a@x.com",
      NOW,
    );
    expect(s?.status).toBe("break");
  });
});
