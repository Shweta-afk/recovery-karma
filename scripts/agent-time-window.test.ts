import { describe, expect, test } from "bun:test";
import { getAgentTimeStats, workWindow } from "../src/lib/agent-time-stats";
import type { StatusInterval } from "../src/lib/agent-presence-store";
import type { DispositionRecord } from "../src/lib/disposition-store";

const DAY = "2026-11-20"; // a past day, so open/closed maths don't depend on "now"
const at = (hhmm: string) => `${DAY}T${hhmm}:00+05:30`;
const iv = (status: StatusInterval["status"], from: string, to: string): StatusInterval => ({
  agentId: "a@x.com",
  status,
  startedAt: at(from),
  endedAt: at(to),
  lastSeenAt: at(to),
});
const call = (time: string, durationSeconds: number) =>
  ({
    time: at(time),
    durationSeconds,
    ringSeconds: 10,
    wrapSeconds: 20,
  }) as unknown as DispositionRecord;

describe("time is measured 8 am – 8 pm IST", () => {
  test("the window", () => {
    const w = workWindow(DAY);
    expect(w.end - w.start).toBe(12 * 3600_000);
    expect(new Date(w.start).toISOString()).toBe("2026-11-20T02:30:00.000Z");
  });
  test("logged-in time before 8 and after 8 pm is not counted", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [iv("available", "07:00", "21:00")]);
    expect(s.loggedInSeconds).toBe(12 * 3600);
    expect(s.loginTime?.getTime()).toBe(workWindow(DAY).start);
  });
  test("a break that straddles 8 am only counts from 8", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [
      iv("break", "07:30", "08:30"),
      iv("available", "08:30", "12:00"),
    ]);
    expect(s.breakSeconds).toBe(30 * 60);
    expect(s.loggedInSeconds).toBe(4 * 3600 - 0);
  });
  test("calls outside the window do not count", () => {
    const s = getAgentTimeStats(
      "a@x.com",
      [call("07:59", 600), call("09:00", 300), call("20:00", 900), call("19:59", 100)],
      DAY,
      [iv("available", "08:00", "20:00")],
    );
    expect(s.callingSeconds).toBe(400);
    expect(s.ringingSeconds).toBe(20);
    expect(s.dispositionSeconds).toBe(40);
  });
  test("someone only signed in overnight has no tracked time, not a negative", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [iv("available", "21:00", "23:00")]);
    expect(s.loggedInSeconds).toBe(0);
    expect(s.idleSeconds).toBe(0);
    expect(s.loginTime).toBeNull();
  });
});

describe("presence rows that overlap or were closed late", () => {
  test("two tabs open at once count the time once", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [
      iv("available", "09:00", "13:00"),
      iv("available", "10:00", "14:00"),
    ]);
    expect(s.loggedInSeconds).toBe(5 * 3600);
  });
  test("a row closed long after its last heartbeat ends at the heartbeat", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [
      {
        agentId: "a@x.com",
        status: "available",
        startedAt: at("09:00"),
        endedAt: "2026-11-25T10:00:00+05:30",
        lastSeenAt: at("11:00"),
      },
    ]);
    expect(s.loggedInSeconds).toBe(2 * 3600 + 3 * 60);
    expect(s.logoutTime).not.toBeNull();
  });
  test("break never exceeds logged-in time", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [
      iv("break", "09:00", "10:00"),
      iv("lunch", "09:30", "10:00"),
    ]);
    expect(s.breakSeconds).toBe(3600);
    expect(s.idleSeconds).toBe(0);
  });
});

describe("an app left open overnight is not a login", () => {
  const overnight: StatusInterval = {
    agentId: "a@x.com",
    status: "available",
    startedAt: "2026-11-19T15:00:00+05:30",
    endedAt: at("19:00"),
    lastSeenAt: at("19:00"),
  };
  test("counts only from the first call of the day", () => {
    const s = getAgentTimeStats("a@x.com", [call("10:01", 30)], DAY, [overnight]);
    // first call began at 10:01 minus 30 s talk, 10 s ring, 20 s wrap = 10:00
    expect(s.loggedInSeconds).toBe(9 * 3600);
    expect(s.loginTime?.getTime()).toBe(new Date(at("10:00")).getTime());
  });
  test("counts nothing on a day with no calls", () => {
    const s = getAgentTimeStats("a@x.com", [], DAY, [overnight]);
    expect(s.loggedInSeconds).toBe(0);
  });
});
