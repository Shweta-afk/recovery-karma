// A team's money for one IST day (Admin → Reports → By Team, user 2026-11-27):
//   generated  = PTPs (and Partially Paid balances with a date) the team logged that day;
//   collected  = completed payments received that day;
//   due today  = the projection: the team's still-open promises whose due date is that day —
//                same "still open" rule as escalations (computeCaseFollowups).
import { computeCaseFollowups, isOpenPromise, type DispositionRecord } from "./disposition-store";
import type { PaymentRecord } from "./payments-store";
import { istDayKey } from "./monthly-trend";

export interface TeamToday {
  generatedCount: number;
  generatedAmount: number;
  collectedCount: number;
  collectedAmount: number;
  dueCount: number;
  dueAmount: number;
}

export function teamToday(
  teamDisps: DispositionRecord[],
  allDisps: DispositionRecord[],
  teamPayments: PaymentRecord[],
  day: string,
): TeamToday {
  const generated = teamDisps.filter((d) => isOpenPromise(d) && istDayKey(d.time) === day);
  const collected = teamPayments.filter(
    (p) => p.status === "completed" && istDayKey(p.receivedAt ?? p.createdAt) === day,
  );
  const due = computeCaseFollowups(teamDisps, allDisps).filter(
    (f) => f.kind === "ptp" && f.dueDateIso.slice(0, 10) === day,
  );
  return {
    generatedCount: generated.length,
    generatedAmount: generated.reduce((s, d) => s + (d.ptpAmount ?? 0), 0),
    collectedCount: collected.length,
    collectedAmount: collected.reduce((s, p) => s + p.amount, 0),
    dueCount: due.length,
    dueAmount: due.reduce((s, f) => s + (f.amount ?? 0), 0),
  };
}
