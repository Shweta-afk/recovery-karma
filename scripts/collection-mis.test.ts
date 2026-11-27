import { describe, expect, test } from "bun:test";
import {
  clientMis,
  dailyCollection,
  differences,
  inr,
  ranking,
  sameDayLastMonth,
  zeroNumbers,
  type MisInput,
  type MisRow,
} from "../src/lib/collection-mis";

const row = (p: Partial<MisRow>): MisRow => ({
  teamId: "t",
  teamName: "RBL",
  agentId: "a",
  agentName: "Asha",
  pos: 0,
  loans: 0,
  paidByDay: {},
  projection: 0,
  ...p,
});

const input: MisInput = {
  asOf: "2026-11-03",
  rows: [
    row({
      agentId: "a",
      agentName: "Asha",
      pos: 100,
      loans: 2,
      paidByDay: { "2026-11-01": 50, "2026-11-03": 10 },
      projection: 5,
    }),
    row({ agentId: "b", agentName: "Ben", pos: 200, loans: 3, paidByDay: { "2026-11-02": 500 } }),
    // Asha also works for TVS: one ranking row, two client groups
    row({
      teamId: "u",
      teamName: "TVS",
      agentId: "a",
      agentName: "Asha",
      pos: 10,
      loans: 1,
      paidByDay: { "2026-11-02": 1 },
    }),
  ],
  prevAsOf: "2026-10-03",
  prevRows: [row({ paidByDay: { "2026-10-01": 1000, "2026-10-05": 9999 } })],
};

describe("collection MIS", () => {
  test("same day last month clamps to month length", () => {
    expect(sameDayLastMonth("2026-03-31")).toBe("2026-02-28");
    expect(sameDayLastMonth("2026-01-15")).toBe("2025-12-15");
  });

  test("ranking merges an agent across teams and ranks by month to date", () => {
    expect(ranking(input).map((r) => [r.name, r.total, r.today, r.loans, r.rank])).toEqual([
      ["Ben", 500, 0, 3, 1],
      ["Asha", 61, 10, 3, 2],
    ]);
  });

  test("daily collection groups by client with totals", () => {
    const d = dailyCollection(input);
    expect(d.groups.map((g) => [g.client, g.total, g.today])).toEqual([
      ["RBL", 560, 10],
      ["TVS", 1, 0],
    ]);
    expect(d.grand.total).toBe(561);
  });

  test("zero numbers counts days with nothing collected", () => {
    const z = zeroNumbers(input);
    expect(z.days).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
    expect(z.agents.find((a) => a.name === "Ben")).toMatchObject({
      zeroDays: 2,
      perDay: [0, 500, 0],
    });
    expect(z.agents.find((a) => a.name === "Asha")).toMatchObject({ zeroDays: 0, average: 20 });
  });

  test("client MIS carries projection", () => {
    expect(clientMis(input).clients[0]).toMatchObject({ client: "RBL", projection: 5, loans: 5 });
  });

  test("differences only counts last month up to the same day", () => {
    const d = differences(input);
    expect(d.clients.find((c) => c.client === "RBL")).toEqual({
      client: "RBL",
      prev: 1000,
      cur: 560,
      diff: -440,
    });
  });

  test("inr formats like the company's sheets", () => {
    expect(inr(0)).toBe("-");
    expect(inr(-10797, false)).toBe("(10,797)");
    expect(inr(1849780)).toBe("18,49,780");
  });
});
