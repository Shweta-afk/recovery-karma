import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { copyTalkTimeToCallLogs, talkSeconds } from "../src/lib/telephony/talk-time";

/** A fake client that records the writes copyTalkTimeToCallLogs makes. */
function fakeDb(result: { error: { message: string } | null } = { error: null }) {
  const writes: { table: string; seconds: number; callId: string }[] = [];
  return {
    writes,
    from: (table: "call_logs") => ({
      update: ({ duration_seconds: seconds }: { duration_seconds: number }) => ({
        eq: async (_column: "provider_call_id", callId: string) => {
          writes.push({ table, seconds, callId });
          return result;
        },
      }),
    }),
  };
}

describe("talk time rule", () => {
  test("a completed call's ledger figure is talk time", () => {
    expect(talkSeconds("completed", 78)).toBe(78);
    expect(talkSeconds("completed", 78.4)).toBe(78);
  });

  test("any other status is ringing time, so it is not talk time", () => {
    for (const status of ["no_answer", "busy", "failed", "canceled", "ringing", "superseded"]) {
      expect(talkSeconds(status, 45)).toBeNull();
    }
    expect(talkSeconds(null, 45)).toBeNull();
  });

  test("a completed call with no measured figure stays unknown", () => {
    expect(talkSeconds("completed", null)).toBeNull();
    expect(talkSeconds("completed", undefined)).toBeNull();
    expect(talkSeconds("completed", 0)).toBeNull();
    expect(talkSeconds("completed", Number.NaN)).toBeNull();
  });
});

describe("copying talk time onto the call log", () => {
  test("writes a completed call by its provider call id", async () => {
    const db = fakeDb();
    await copyTalkTimeToCallLogs(db, "call-1", "completed", 120);
    expect(db.writes).toEqual([{ table: "call_logs", seconds: 120, callId: "call-1" }]);
  });

  test("writes nothing for an unanswered call or a missing id", async () => {
    const db = fakeDb();
    await copyTalkTimeToCallLogs(db, "call-1", "no_answer", 30);
    await copyTalkTimeToCallLogs(db, null, "completed", 30);
    expect(db.writes).toEqual([]);
  });

  test("a database error does not reach the caller", async () => {
    await expect(
      copyTalkTimeToCallLogs(fakeDb({ error: { message: "boom" } }), "call-1", "completed", 5),
    ).resolves.toBeUndefined();
  });
});

// The two halves only work as a pair: whichever of "ledger updated" and "log inserted" happens
// second must do the copy. These pin the order at each call site.
describe("both arrival orders are covered", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

  test("the webhook copies after updating the ledger", () => {
    const code = source("../src/lib/telephony/webhook-reconcile.server.ts");
    const update = code.indexOf("await updateLedger(ledger.id, patch)");
    expect(update).toBeGreaterThan(-1);
    expect(code.indexOf("copyTalkTimeToCallLogs(", update)).toBeGreaterThan(update);
  });

  test("a disposition copies after inserting the call log", () => {
    const code = source("../src/lib/disposition-store.ts");
    const body = code.slice(code.indexOf("export async function saveDisposition"));
    const insert = body.indexOf('.from("call_logs").insert(full');
    expect(insert).toBeGreaterThan(-1);
    expect(body.indexOf("await copyTalkTime(d.providerCallId)", insert)).toBeGreaterThan(insert);
  });

  test("hanging up cannot overwrite a call that has already finished", () => {
    const code = source("../src/lib/telephony/server.ts");
    const body = code.slice(code.indexOf("async function providerHangup"));
    expect(body.slice(0, body.indexOf("\n}\n"))).toContain("updateLedgerIfOpen(");
  });
});
