/**
 * Which commitments the escalation chain considers MISSED.
 *
 * This decides who gets paged, so the cases that matter are the ones where being wrong is
 * expensive in both directions: a superseded promise must NOT escalate (nagging a manager
 * about a debtor who already paid), and a genuinely overdue callback MUST (the whole point of
 * generalising the chain beyond PTPs).
 */
import { expect, test } from "bun:test";
import { computeCaseFollowups, type DispositionRecord } from "../src/lib/disposition-store";

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const dateOnly = (offsetDays: number) => iso(offsetDays).slice(0, 10);

function disp(p: Partial<DispositionRecord>): DispositionRecord {
  return {
    id: Math.random().toString(36).slice(2),
    debtorId: "11111111-1111-1111-1111-111111111111",
    debtorName: "Test Debtor",
    phone: "+919000000000",
    agentId: "a@x.com",
    agentName: "A",
    outcome: "promised",
    notes: "",
    time: iso(0),
    ...p,
  } as DispositionRecord;
}

test("an overdue PTP is a missed commitment", () => {
  const rows = computeCaseFollowups([
    disp({ outcome: "promised", ptpDate: dateOnly(-3), ptpAmount: 5000 }),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("ptp");
  expect(rows[0].amount).toBe(5000);
  expect(rows[0].daysLeft).toBeLessThan(0);
});

test("an overdue callback is a missed commitment too, with no amount", () => {
  const rows = computeCaseFollowups([
    disp({ outcome: "callback", callbackDate: dateOnly(-2), callbackTime: "15:00" }),
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0].kind).toBe("callback");
  expect(rows[0].amount).toBeUndefined();
  expect(rows[0].dueTime).toBe("15:00");
  expect(rows[0].daysLeft).toBeLessThan(0);
});

test("a future commitment is open, not missed", () => {
  const rows = computeCaseFollowups([disp({ outcome: "callback", callbackDate: dateOnly(3) })]);
  expect(rows[0].daysLeft).toBeGreaterThan(0);
});

test("only the LATEST disposition counts — a superseded promise does not escalate", () => {
  const rows = computeCaseFollowups([
    disp({ outcome: "promised", ptpDate: dateOnly(-5), ptpAmount: 5000, time: iso(-5) }),
    disp({ outcome: "paid", paidAmount: 5000, time: iso(-1) }),
  ]);
  expect(rows).toHaveLength(0);
});

test("a callback superseded by a real conversation does not escalate", () => {
  const rows = computeCaseFollowups([
    disp({ outcome: "callback", callbackDate: dateOnly(-4), time: iso(-4) }),
    disp({ outcome: "refused", time: iso(-1) }),
  ]);
  expect(rows).toHaveLength(0);
});

test("a callback logged before the migration has no date and never escalates", () => {
  // callbackDate undefined — rather than escalating on a guessed or missing date.
  const rows = computeCaseFollowups([disp({ outcome: "callback" })]);
  expect(rows).toHaveLength(0);
});

test("a promise with no amount is not treated as a PTP", () => {
  const rows = computeCaseFollowups([disp({ outcome: "promised", ptpDate: dateOnly(-1) })]);
  expect(rows).toHaveLength(0);
});

test("each debtor yields at most one live commitment", () => {
  const other = "22222222-2222-2222-2222-222222222222";
  const rows = computeCaseFollowups([
    disp({ outcome: "promised", ptpDate: dateOnly(-2), ptpAmount: 1000, time: iso(-2) }),
    disp({ outcome: "callback", callbackDate: dateOnly(-1), time: iso(-1) }),
    disp({ debtorId: other, outcome: "callback", callbackDate: dateOnly(-1) }),
  ]);
  expect(rows).toHaveLength(2);
  // The newer callback supersedes that debtor's older promise.
  expect(rows.every((r) => r.kind === "callback")).toBe(true);
});
