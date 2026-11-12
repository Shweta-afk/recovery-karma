import { describe, expect, test } from "bun:test";
import {
  PROGRESSIVE_GAP_SECONDS,
  PROGRESSIVE_IDLE,
  dueToDial,
  planProgressive,
  progressiveReducer as r,
} from "../src/lib/dialer/progressive";

describe("planProgressive", () => {
  test("keeps queue order, drops do-not-call numbers and today's contacts, de-duplicates", () => {
    const plan = planProgressive(
      [
        { id: "a", phone: "9800000001" },
        { id: "b", phone: "+91 98000 00002" },
        { id: "c", phone: "9800000003", lastContacted: "2026-11-12" },
        { id: "d", phone: "9800000004", lastContacted: "2026-11-11" },
        { id: "a", phone: "9800000001" },
      ],
      { todayKey: "2026-11-12", doNotCall: new Set(["9800000002"]) },
    );
    expect(plan).toEqual({ ids: ["a", "d"], skippedDoNotCall: 1, skippedCalledToday: 1 });
  });
});

describe("progressive session", () => {
  const started = r(PROGRESSIVE_IDLE, { type: "start", ids: ["a", "b"] });

  test("the first call is due at once; the next after the disposition and a short gap", () => {
    expect(dueToDial(started, 1)).toBe("a");
    let s = r(started, { type: "dialed", id: "a" });
    expect(s.status).toBe("calling");
    expect(dueToDial(s, 999)).toBeNull();
    s = r(s, { type: "dispositioned", id: "a", now: 1000 });
    expect(s.status).toBe("countdown");
    expect(dueToDial(s, 1000)).toBeNull();
    expect(dueToDial(s, 1000 + PROGRESSIVE_GAP_SECONDS * 1000)).toBe("b");
    s = r(r(s, { type: "dialed", id: "b" }), { type: "dispositioned", id: "b", now: 2000 });
    expect(s.status).toBe("done");
    expect(s.called).toBe(2);
  });

  test("a call that closes without a disposition pauses instead of racing on", () => {
    let s = r(r(started, { type: "dialed", id: "a" }), {
      type: "callCleared",
      id: "a",
      reason: "Call not placed",
    });
    expect(s.status).toBe("paused");
    expect(s.pauseReason).toBe("Call not placed");
    s = r(s, { type: "resume" });
    expect(dueToDial(s, 0)).toBe("a"); // resuming retries the same borrower
    s = r(r(started, { type: "dialed", id: "a" }), { type: "callCleared", id: "a", reason: "x" });
    s = r(s, { type: "skip", now: 0 });
    expect(s.skipped).toBe(1);
    expect(dueToDial(s, PROGRESSIVE_GAP_SECONDS * 1000)).toBe("b");
  });

  test("another call during the countdown pauses the session", () => {
    const s = r(started, { type: "otherCall" });
    expect(s.status).toBe("paused");
    expect(dueToDial(s, 1e12)).toBeNull();
  });

  test("events for another borrower are ignored; stop clears everything", () => {
    const s = r(started, { type: "dialed", id: "a" });
    expect(r(s, { type: "dispositioned", id: "zzz", now: 0 })).toBe(s);
    expect(r(s, { type: "stop" })).toEqual(PROGRESSIVE_IDLE);
    expect(r(PROGRESSIVE_IDLE, { type: "start", ids: [] }).status).toBe("done");
  });

  test("Pause during a call stops after that call's disposition", () => {
    let s = r(r(started, { type: "dialed", id: "a" }), { type: "pause" });
    expect(s.status).toBe("calling");
    s = r(s, { type: "dispositioned", id: "a", now: 0 });
    expect(s.status).toBe("paused");
    expect(dueToDial(s, 1e12)).toBeNull();
    s = r(s, { type: "resume" });
    expect(dueToDial(s, 0)).toBe("b");
  });
});
