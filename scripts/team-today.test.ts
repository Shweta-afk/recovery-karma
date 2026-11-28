import { describe, expect, test } from "bun:test";
import { teamToday } from "../src/lib/team-today";
import type { DispositionRecord } from "../src/lib/disposition-store";
import type { PaymentRecord } from "../src/lib/payments-store";

const DAY = "2026-11-27";
const d = (p: Partial<DispositionRecord>) =>
  ({
    id: Math.random().toString(),
    debtorId: "x",
    agentId: "a",
    notes: "",
    ...p,
  }) as DispositionRecord;
const pay = (p: Partial<PaymentRecord>) =>
  ({ status: "completed", amount: 0, createdAt: `${DAY}T12:00:00+05:30`, ...p }) as PaymentRecord;

describe("team today", () => {
  test("generated, collected and due today", () => {
    const disps = [
      // PTP logged today, due on the 30th → generated, not due today
      d({
        debtorId: "a",
        outcome: "promised",
        ptpAmount: 5000,
        ptpDate: "2026-11-30",
        time: `${DAY}T11:00:00+05:30`,
      }),
      // PTP logged earlier, due today and still open → due today
      d({
        debtorId: "b",
        outcome: "promised",
        ptpAmount: 3000,
        ptpDate: DAY,
        time: "2026-11-20T11:00:00+05:30",
      }),
      // PTP due today but already paid afterwards → not due
      d({
        debtorId: "c",
        outcome: "promised",
        ptpAmount: 9000,
        ptpDate: DAY,
        time: "2026-11-20T11:00:00+05:30",
      }),
      d({ debtorId: "c", outcome: "paid", time: `${DAY}T10:00:00+05:30` }),
      // logged yesterday after 18:30 UTC boundary still yesterday in IST
      d({
        debtorId: "e",
        outcome: "promised",
        ptpAmount: 100,
        ptpDate: "2026-12-01",
        time: "2026-11-26T23:00:00+05:30",
      }),
    ];
    const payments = [
      pay({ amount: 2000, receivedAt: `${DAY}T09:00:00+05:30` }),
      pay({ amount: 7000, receivedAt: "2026-11-26T20:00:00+05:30" }),
      pay({
        amount: 500,
        status: "pending" as PaymentRecord["status"],
        receivedAt: `${DAY}T09:00:00+05:30`,
      }),
    ];
    expect(teamToday(disps, disps, payments, DAY)).toEqual({
      generatedCount: 1,
      generatedAmount: 5000,
      collectedCount: 1,
      collectedAmount: 2000,
      dueCount: 1,
      dueAmount: 3000,
    });
  });
});
