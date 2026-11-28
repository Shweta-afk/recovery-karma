import { describe, expect, test } from "bun:test";
import { isDue, istParts, reportDayFor, type ReportSchedule } from "../src/lib/report-schedule";
import { buildMisSheets, misSheetsForXlsx, misSheetsHtml } from "../src/lib/collection-mis-email";
import type { MisInput } from "../src/lib/collection-mis";

const base: ReportSchedule = {
  id: "s",
  clientId: "c",
  listId: "l",
  name: "Morning",
  sheets: ["daily"],
  sendTime: "09:00",
  weekdays: [1, 2, 3, 4, 5, 6],
  reportDay: "yesterday",
  enabled: true,
  lastSentOn: null,
  lastResult: null,
};
// Sat 28 Nov 2026
const at = (hhmm: string) => new Date(`2026-11-28T${hhmm}:00+05:30`);

describe("schedule timing (IST)", () => {
  test("parts are IST", () => {
    expect(istParts(new Date("2026-11-27T19:00:00Z"))).toEqual({
      day: "2026-11-28",
      time: "00:30",
      weekday: 6,
    });
  });
  test("due at or after the time, once a day, on chosen weekdays", () => {
    expect(isDue(base, at("08:59"))).toBe(false);
    expect(isDue(base, at("09:00"))).toBe(true);
    expect(isDue(base, at("15:00"))).toBe(true); // missed while down → still goes that day
    expect(isDue({ ...base, lastSentOn: "2026-11-28" }, at("10:00"))).toBe(false);
    expect(isDue({ ...base, lastSentOn: "2026-11-27" }, at("10:00"))).toBe(true);
    expect(isDue({ ...base, weekdays: [1] }, at("10:00"))).toBe(false);
    expect(isDue({ ...base, enabled: false }, at("10:00"))).toBe(false);
  });
  test("report day", () => {
    expect(reportDayFor(base, at("09:00"))).toBe("2026-11-27");
    expect(reportDayFor({ reportDay: "today" }, at("18:00"))).toBe("2026-11-28");
    expect(reportDayFor(base, new Date("2026-12-01T09:00:00+05:30"))).toBe("2026-11-30");
  });
});

describe("MIS email", () => {
  const data: MisInput = {
    asOf: "2026-11-27",
    rows: [
      {
        teamId: "t",
        teamName: "RBL <Bank>",
        agentId: "a",
        agentName: "Asha",
        pos: 1000,
        loans: 2,
        paidByDay: { "2026-11-27": 1500, "2026-11-02": 500 },
        projection: 0,
      },
    ],
    prevAsOf: "2026-10-27",
    prevRows: [],
  };
  const sheets = buildMisSheets(data, "27-NOV-2026, 08:00 PM", ["daily", "differences"]);
  test("keeps the page's sheet order and escapes text", () => {
    expect(sheets.map((s) => s.key)).toEqual(["differences", "daily"]);
    const html = misSheetsHtml(sheets);
    expect(html).toContain("RBL &lt;Bank&gt;");
    expect(html).not.toContain("<Bank>");
  });
  test("Excel gets numbers, not rupee text", () => {
    const daily = misSheetsForXlsx(sheets).find((s) => s.title.startsWith("DAILY"))!;
    expect(daily.rows[0]).toEqual(["RBL <Bank>", "ASHA", 1000, 2, 1500, 2000]);
    const diff = misSheetsForXlsx(sheets)[0];
    expect(diff.rows[0]).toEqual(["RBL <Bank>", 0, 2000, 2000]);
  });
});
