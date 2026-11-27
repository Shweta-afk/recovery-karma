// Collection MIS sheets, built from collection_mis() rows (one per team × agent). Pure: no
// imports from server or browser code. Layouts follow the company's own MIS screenshots
// (user, 2026-11-27). "Client" = the portfolio's team.

export interface MisRow {
  teamId: string;
  teamName: string;
  agentId: string;
  agentName: string;
  pos: number;
  loans: number;
  /** "YYYY-MM-DD" (IST) → amount collected that day */
  paidByDay: Record<string, number>;
  projection: number;
}

export interface MisInput {
  /** IST day the report is for, "YYYY-MM-DD" */
  asOf: string;
  rows: MisRow[];
  /** Same company, previous month, 1st → same day (for Differences) */
  prevAsOf: string;
  prevRows: MisRow[];
}

const monthOf = (d: string) => d.slice(0, 8); // "2026-11-"
const dayNum = (d: string) => Number(d.slice(8, 10));

export function mtd(r: MisRow, asOf: string): number {
  let s = 0;
  for (const [d, v] of Object.entries(r.paidByDay))
    if (d.startsWith(monthOf(asOf)) && d <= asOf) s += Number(v) || 0;
  return s;
}

export const onDay = (r: MisRow, day: string) => Number(r.paidByDay[day]) || 0;

/** Same day number last month, clamped to that month's length ("2026-03-31" → "2026-02-28"). */
export function sameDayLastMonth(asOf: string): string {
  const [y, m, d] = asOf.split("-").map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(py, pm, 0)).getUTCDate();
  return `${py}-${String(pm).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-26" → "26-Nov" */
export const shortDay = (d: string) => `${dayNum(d)}-${MON[Number(d.slice(5, 7)) - 1]}`;
/** "2026-11-26" → "26-NOV-2026" */
export const longDay = (d: string) =>
  `${d.slice(8, 10)}-${MON[Number(d.slice(5, 7)) - 1].toUpperCase()}-${d.slice(0, 4)}`;
/** "2026-10-27" → "27-Oct-26" */
export const diffDay = (d: string) =>
  `${d.slice(8, 10)}-${MON[Number(d.slice(5, 7)) - 1]}-${d.slice(2, 4)}`;

/** One row per agent across every team they work in. */
function byAgent(rows: MisRow[]) {
  const m = new Map<string, MisRow>();
  for (const r of rows) {
    const cur = m.get(r.agentId);
    if (!cur) {
      m.set(r.agentId, { ...r, paidByDay: { ...r.paidByDay } });
      continue;
    }
    cur.pos += r.pos;
    cur.loans += r.loans;
    cur.projection += r.projection;
    for (const [d, v] of Object.entries(r.paidByDay))
      cur.paidByDay[d] = (cur.paidByDay[d] ?? 0) + Number(v);
  }
  return [...m.values()];
}

function byTeam(rows: MisRow[]) {
  const m = new Map<string, MisRow[]>();
  for (const r of rows) m.set(r.teamName, [...(m.get(r.teamName) ?? []), r]);
  return m;
}

const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + f(x), 0);

export interface DailyCollectionGroup {
  client: string;
  agents: { name: string; pos: number; loans: number; today: number; total: number }[];
  pos: number;
  loans: number;
  today: number;
  total: number;
}

/** DAILY COLLECTION MIS: client → agents, client totals, grand total. */
export function dailyCollection({ asOf, rows }: MisInput) {
  const groups: DailyCollectionGroup[] = [...byTeam(rows)]
    .map(([client, rs]) => {
      const agents = rs
        .map((r) => ({
          name: r.agentName,
          pos: r.pos,
          loans: r.loans,
          today: onDay(r, asOf),
          total: mtd(r, asOf),
        }))
        .sort((a, b) => b.total - a.total);
      return {
        client,
        agents,
        pos: sum(agents, (a) => a.pos),
        loans: sum(agents, (a) => a.loans),
        today: sum(agents, (a) => a.today),
        total: sum(agents, (a) => a.total),
      };
    })
    .sort((a, b) => a.client.localeCompare(b.client));
  return {
    groups,
    grand: {
      pos: sum(groups, (g) => g.pos),
      loans: sum(groups, (g) => g.loans),
      today: sum(groups, (g) => g.today),
      total: sum(groups, (g) => g.total),
    },
  };
}

/** DAILY COLLECTION RANKING MIS: agents ranked by month-to-date collection. */
export function ranking({ asOf, rows }: MisInput) {
  return byAgent(rows)
    .map((r) => ({
      name: r.agentName,
      pos: r.pos,
      loans: r.loans,
      today: onDay(r, asOf),
      total: mtd(r, asOf),
    }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

export function monthDays(asOf: string): string[] {
  return Array.from(
    { length: dayNum(asOf) },
    (_, i) => `${monthOf(asOf)}${String(i + 1).padStart(2, "0")}`,
  );
}

/** ZERO NUMBERS MIS: collection per agent per day, days with nothing, daily average. */
export function zeroNumbers({ asOf, rows }: MisInput) {
  const days = monthDays(asOf);
  const agents = byAgent(rows)
    .map((r) => {
      const perDay = days.map((d) => onDay(r, d));
      const total = sum(perDay, (v) => v);
      return {
        name: r.agentName,
        perDay,
        zeroDays: perDay.filter((v) => v === 0).length,
        average: Math.round(total / days.length),
      };
    })
    .sort((a, b) => b.zeroDays - a.zeroDays || a.average - b.average);
  return { days, agents };
}

/** DAILY COLLECTION CLIENT MIS: per client, with projection (open PTPs still due this month). */
export function clientMis({ asOf, rows }: MisInput) {
  const clients = [...byTeam(rows)]
    .map(([client, rs]) => ({
      client,
      pos: sum(rs, (r) => r.pos),
      loans: sum(rs, (r) => r.loans),
      projection: sum(rs, (r) => r.projection),
      today: sum(rs, (r) => onDay(r, asOf)),
      total: sum(rs, (r) => mtd(r, asOf)),
    }))
    .sort((a, b) => a.client.localeCompare(b.client));
  return {
    clients,
    grand: {
      pos: sum(clients, (c) => c.pos),
      loans: sum(clients, (c) => c.loans),
      projection: sum(clients, (c) => c.projection),
      today: sum(clients, (c) => c.today),
      total: sum(clients, (c) => c.total),
    },
  };
}

/** Differences: each client's collection 1st → same day, last month vs this month. */
export function differences({ asOf, rows, prevAsOf, prevRows }: MisInput) {
  const now = new Map([...byTeam(rows)].map(([c, rs]) => [c, sum(rs, (r) => mtd(r, asOf))]));
  const before = new Map(
    [...byTeam(prevRows)].map(([c, rs]) => [c, sum(rs, (r) => mtd(r, prevAsOf))]),
  );
  const clients = [...new Set([...now.keys(), ...before.keys()])]
    .map((client) => {
      const prev = before.get(client) ?? 0;
      const cur = now.get(client) ?? 0;
      return { client, prev, cur, diff: cur - prev };
    })
    .sort((a, b) => b.diff - a.diff);
  const prev = sum(clients, (c) => c.prev);
  const cur = sum(clients, (c) => c.cur);
  return { clients, grand: { prev, cur, diff: cur - prev } };
}

/** Green (1) → red (n) background for rank / zero-count cells. */
export function scaleColor(i: number, n: number, reverse = false): string {
  const t = n <= 1 ? 0 : i / (n - 1);
  const x = reverse ? 1 - t : t;
  // green #63BE7B → yellow #FFEB84 → red #F8696B (Excel's default 3-colour scale)
  const lerp = (a: number, b: number, k: number) => Math.round(a + (b - a) * k);
  const [from, to, k] =
    x < 0.5
      ? [[0x63, 0xbe, 0x7b], [0xff, 0xeb, 0x84], x * 2]
      : [[0xff, 0xeb, 0x84], [0xf8, 0x69, 0x6b], (x - 0.5) * 2];
  return `rgb(${lerp(from[0], to[0], k as number)}, ${lerp(from[1], to[1], k as number)}, ${lerp(from[2], to[2], k as number)})`;
}

/** Indian grouping, "-" for zero, parentheses for negatives — as in the company's sheets. */
export function inr(v: number, dashZero = true): string {
  if (dashZero && Math.round(v) === 0) return "-";
  const s = Math.round(Math.abs(v)).toLocaleString("en-IN");
  return v < 0 ? `(${s})` : s;
}
