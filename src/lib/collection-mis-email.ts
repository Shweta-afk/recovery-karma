// Collection MIS for email (scheduled sends): the same five sheets as the MIS page, as inline-
// styled HTML tables (email clients drop <style> blocks) plus plain rows for an Excel file.
// Pure — no server or browser imports.
import {
  clientMis,
  dailyCollection,
  diffDay,
  differences,
  inr,
  longDay,
  ranking,
  scaleColor,
  shortDay,
  zeroNumbers,
  type MisInput,
} from "./collection-mis";

export const MIS_SHEETS = ["differences", "ranking", "zero", "daily", "client"] as const;
export type MisSheetKey = (typeof MIS_SHEETS)[number];

export const MIS_SHEET_LABEL: Record<MisSheetKey, string> = {
  differences: "Differences (last month vs this month)",
  ranking: "Daily Collection Ranking MIS",
  zero: "Zero Numbers MIS",
  daily: "Daily Collection MIS",
  client: "Daily Collection Client MIS",
};

/** Fired by a sheet's "Schedule" button (detail = MisSheetKey); the schedules card opens a new
 *  schedule for that sheet. */
export const SCHEDULE_SHEET_EVENT = "samvadx:schedule-mis-sheet";

/** Starting values when scheduling one sheet — the times the company's own MIS goes out. */
export const SHEET_SCHEDULE_DEFAULT: Record<
  MisSheetKey,
  { sendTime: string; reportDay: "yesterday" | "today" }
> = {
  daily: { sendTime: "09:00", reportDay: "yesterday" },
  client: { sendTime: "11:30", reportDay: "today" },
  differences: { sendTime: "17:00", reportDay: "today" },
  ranking: { sendTime: "18:00", reportDay: "today" },
  zero: { sendTime: "18:00", reportDay: "today" },
};

type Cell = { v: string | number; bg?: string; bold?: boolean; right?: boolean; center?: boolean };
interface Sheet {
  key: MisSheetKey;
  title: string;
  headers: string[];
  rows: Cell[][];
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const GREY = "#D9D9D9";
const PEACH = "#FCE4D6";
const n = (v: number): Cell => ({ v: Math.round(v), right: true });
const m = (v: number, dash = true): Cell => ({ v: inr(v, dash), right: true });

export function buildMisSheets(data: MisInput, stamp: string, keys: MisSheetKey[]): Sheet[] {
  const { asOf } = data;
  const today = `Sum of ${shortDay(asOf)}`;
  const time = stamp.split(", ")[1] ?? "";
  const out: Sheet[] = [];

  for (const key of MIS_SHEETS.filter((k) => keys.includes(k))) {
    if (key === "differences") {
      const df = differences(data);
      const worst = Math.min(...df.clients.map((x) => x.diff), -1);
      out.push({
        key,
        title: `Differences Between (${diffDay(data.prevAsOf)} & ${diffDay(asOf)} , ${time})`,
        headers: ["Client Name", diffDay(data.prevAsOf), diffDay(asOf), "Differences"],
        rows: [
          ...df.clients.map((c) => {
            const shade = c.diff < 0 ? Math.min(1, c.diff / worst) : 0;
            return [
              { v: c.client },
              m(c.prev, false),
              m(c.cur, false),
              {
                ...m(c.diff, false),
                bg: shade ? `rgba(248,105,107,${(0.25 + shade * 0.75).toFixed(2)})` : undefined,
              },
            ];
          }),
          [
            { v: "Grand Total", bold: true, bg: GREY },
            { ...m(df.grand.prev, false), bold: true, bg: GREY },
            { ...m(df.grand.cur, false), bold: true, bg: GREY },
            { ...m(df.grand.diff, false), bold: true, bg: GREY },
          ],
        ],
      });
    }
    if (key === "ranking") {
      const rk = ranking(data);
      out.push({
        key,
        title: `DAILY COLLECTION RANKING MIS (${stamp})`,
        headers: ["CHAMPS", "Sum of pos", "Count of LOAN ID", today, "Sum of Total Paid", "RANK"],
        rows: rk.map((r, i) => [
          { v: r.name.toUpperCase() },
          n(r.pos),
          n(r.loans),
          m(r.today),
          m(r.total),
          { v: r.rank, center: true, bg: scaleColor(i, rk.length) },
        ]),
      });
    }
    if (key === "zero") {
      const zn = zeroNumbers(data);
      out.push({
        key,
        title: `ZERO NUMBERS MIS (${stamp})`,
        headers: [
          "Row Labels",
          ...zn.days.map((d) => `Sum of ${shortDay(d)}`),
          "Zero Number",
          "Average",
        ],
        rows: zn.agents.map((a, i) => [
          { v: a.name.toUpperCase() },
          ...a.perDay.map((v) => n(v)),
          { v: a.zeroDays, center: true, bg: scaleColor(i, zn.agents.length, true) },
          n(a.average),
        ]),
      });
    }
    if (key === "daily") {
      const dc = dailyCollection(data);
      const rows: Cell[][] = [];
      for (const g of dc.groups) {
        g.agents.forEach((a, i) =>
          rows.push([
            { v: i === 0 ? g.client : "", bold: true },
            { v: a.name.toUpperCase() },
            n(a.pos),
            n(a.loans),
            m(a.today),
            m(a.total),
          ]),
        );
        rows.push([
          { v: `${g.client} Total`, bold: true, bg: PEACH },
          { v: "", bg: PEACH },
          { ...n(g.pos), bold: true, bg: PEACH },
          { ...n(g.loans), bold: true, bg: PEACH },
          { ...m(g.today), bold: true, bg: PEACH },
          { ...m(g.total), bold: true, bg: PEACH },
        ]);
      }
      rows.push([
        { v: "Grand Total", bold: true, bg: GREY },
        { v: "", bg: GREY },
        { ...n(dc.grand.pos), bold: true, bg: GREY },
        { ...n(dc.grand.loans), bold: true, bg: GREY },
        { ...m(dc.grand.today), bold: true, bg: GREY },
        { ...m(dc.grand.total), bold: true, bg: GREY },
      ]);
      out.push({
        key,
        title: `DAILY COLLECTION MIS (${stamp})`,
        headers: [
          "Client Name",
          "CHAMPS",
          "Sum of pos",
          "Count of LOAN ID",
          today,
          "Sum of Total Paid",
        ],
        rows,
      });
    }
    if (key === "client") {
      const cm = clientMis(data);
      out.push({
        key,
        title: `DAILY COLLECTION CLIENT MIS (${stamp})`,
        headers: [
          "Client Name",
          "Sum of pos",
          "Count of LOAN ID",
          "Projection",
          today,
          "Sum of Total Paid",
        ],
        rows: [
          ...cm.clients.map((c) => [
            { v: c.client },
            n(c.pos),
            n(c.loans),
            n(c.projection),
            m(c.today),
            m(c.total),
          ]),
          [
            { v: "Grand Total", bold: true, bg: GREY },
            { ...n(cm.grand.pos), bold: true, bg: GREY },
            { ...n(cm.grand.loans), bold: true, bg: GREY },
            { ...n(cm.grand.projection), bold: true, bg: GREY },
            { ...m(cm.grand.today), bold: true, bg: GREY },
            { ...m(cm.grand.total), bold: true, bg: GREY },
          ],
        ],
      });
    }
  }
  return out;
}

const TD = "border:1px solid #000;padding:3px 8px;white-space:nowrap;";

export function misSheetsHtml(sheets: Sheet[]): string {
  return sheets
    .map((sh) => {
      const span = sh.headers.length;
      const head = `<tr><th colspan="${span}" style="${TD}background:${GREY};font-weight:700;text-align:center;font-size:14px;">${esc(sh.title)}</th></tr><tr>${sh.headers
        .map(
          (h) =>
            `<th style="${TD}background:${GREY};font-weight:700;text-align:center;">${esc(h)}</th>`,
        )
        .join("")}</tr>`;
      const body = sh.rows
        .map(
          (r) =>
            `<tr>${r
              .map(
                (c) =>
                  `<td style="${TD}${c.bg ? `background:${c.bg};` : ""}${c.bold ? "font-weight:700;" : ""}text-align:${c.right ? "right" : c.center ? "center" : "left"};">${esc(String(c.v))}</td>`,
              )
              .join("")}</tr>`,
        )
        .join("");
      return `<table cellspacing="0" style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:13px;color:#000;background:#fff;margin:0 0 24px;">${head}${body}</table>`;
    })
    .join("");
}

/** Plain rows for Excel: rupee text back to numbers so the sheet can be summed. */
export function misSheetsForXlsx(sheets: Sheet[]) {
  const val = (c: Cell): string | number => {
    if (typeof c.v === "number") return c.v;
    if (c.v === "-") return 0;
    const neg = /^\(.*\)$/.test(c.v);
    const num = Number(c.v.replace(/[(),]/g, ""));
    return c.right && Number.isFinite(num) && c.v !== "" ? (neg ? -num : num) : c.v;
  };
  return sheets.map((sh) => ({
    name: MIS_SHEET_LABEL[sh.key].slice(0, 31),
    title: sh.title,
    headers: sh.headers,
    rows: sh.rows.map((r) => r.map(val)),
  }));
}

export { longDay };
