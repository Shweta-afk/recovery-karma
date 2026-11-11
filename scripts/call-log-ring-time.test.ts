// Ringing time copied from the call ledger onto call_logs.ring_seconds (2026-11-11).
import { describe, expect, test } from "bun:test";
import { copyRingTimeToCallLogs, ringTiming } from "../src/lib/telephony/talk-time";

const T0 = "2026-11-11T07:00:00.000Z";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

describe("ringing time rule", () => {
  test("answer time known: dialled → answered, for any outcome", () => {
    expect(
      ringTiming({ status: "completed", started_at: T0, answered_at: at(18), ended_at: at(200) }),
    ).toEqual({ seconds: 18, wholeCall: false });
  });

  test("never connected: the whole call was ringing", () => {
    for (const status of ["no_answer", "busy", "failed", "canceled"]) {
      expect(ringTiming({ status, started_at: T0, ended_at: at(42) })).toEqual({
        seconds: 42,
        wholeCall: true,
      });
    }
  });

  test("connected without an answer time stays unknown (SkyCRM sends no Answered event)", () => {
    expect(ringTiming({ status: "completed", started_at: T0, ended_at: at(220) })).toBeNull();
  });

  test("open, junk or impossible rows give nothing", () => {
    expect(ringTiming({ status: "ringing", started_at: T0 })).toBeNull();
    expect(ringTiming({ status: "superseded", started_at: T0, ended_at: at(30) })).toBeNull();
    expect(ringTiming({ status: "canceled", started_at: T0, ended_at: at(1622) })).toBeNull();
    expect(ringTiming({ status: "canceled", started_at: at(10), ended_at: T0 })).toBeNull();
    expect(ringTiming({ status: "canceled", ended_at: at(10) })).toBeNull();
  });
});

/** Records the query copyRingTimeToCallLogs builds. */
function fakeDb() {
  const calls: Array<[string, ...unknown[]]> = [];
  const q = {
    update: (v: unknown) => (calls.push(["update", v]), q),
    eq: (c: string, v: unknown) => (calls.push(["eq", c, v]), q),
    is: (c: string, v: unknown) => (calls.push(["is", c, v]), q),
    in: (c: string, v: unknown) => (calls.push(["in", c, v]), q),
    then: (r: (x: { error: null }) => void) => r({ error: null }),
  };
  return { calls, from: (t: string) => (calls.push(["from", t]), q) };
}

describe("copy onto call logs", () => {
  test("whole-call ringing only lands on a no-contact call log, and never overwrites", async () => {
    const db = fakeDb();
    await copyRingTimeToCallLogs(db, "pc-1", {
      status: "canceled",
      started_at: T0,
      ended_at: at(40),
    });
    expect(db.calls).toContainEqual(["update", { ring_seconds: 40 }]);
    expect(db.calls).toContainEqual(["eq", "provider_call_id", "pc-1"]);
    expect(db.calls).toContainEqual(["is", "ring_seconds", null]);
    expect(db.calls).toContainEqual(["in", "outcome", ["no_answer", "voicemail"]]);
  });

  test("a measured answer time goes on whatever the outcome", async () => {
    const db = fakeDb();
    await copyRingTimeToCallLogs(db, "pc-2", {
      status: "completed",
      started_at: T0,
      answered_at: at(12),
    });
    expect(db.calls.some((c) => c[0] === "in")).toBe(false);
  });

  test("nothing to write → no query", async () => {
    const db = fakeDb();
    await copyRingTimeToCallLogs(db, "pc-3", {
      status: "completed",
      started_at: T0,
      ended_at: at(90),
    });
    await copyRingTimeToCallLogs(db, null, { status: "canceled", started_at: T0, ended_at: at(9) });
    expect(db.calls).toHaveLength(0);
  });
});
