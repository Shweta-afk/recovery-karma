// Pure rules for the phone-number (DID) inventory: which number an outbound call goes out on, when
// a number needs a rest, and who may be given one. No I/O; tested in
// scripts/telephony-numbers.test.ts. guard.server.ts / telephony-numbers.server.ts load the rows.

export type DidStatus = "available" | "assigned" | "cooling" | "blocked" | "retired";
export type DidUse = "outbound" | "inbound" | "both";

export interface DidRow {
  id: string;
  number: string;
  status: DidStatus;
  use: DidUse;
  client_id: string | null;
  portfolio_id: string | null;
  vendor_queue: string | null;
  daily_cap: number | null;
  resting_until: string | null;
  cooling_until: string | null;
}

/** Last 10 digits, so 0-, 91- and +91-prefixed forms of one number are the same number. Returns
 *  "" when there aren't 10 digits. 1600-series numbers are already 10 digits. */
export function normaliseDid(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
}

/** Split a pasted block (new lines, commas, spaces between numbers) into normalised numbers.
 *  `bad` holds what couldn't be read as a number. */
export function parseDidList(text: string): { numbers: string[]; bad: string[] } {
  const parts = text
    .split(/[\n,;\t]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const numbers: string[] = [];
  const bad: string[] = [];
  for (const p of parts) {
    const n = normaliseDid(p);
    if (n && p.replace(/[\d\s+()-]/g, "") === "") numbers.push(n);
    else bad.push(p);
  }
  return { numbers: [...new Set(numbers)], bad };
}

/** A released number may be given out again once its cooling-off has passed. */
export function isAssignable(did: Pick<DidRow, "status" | "cooling_until">, now: Date): boolean {
  if (did.status === "available") return true;
  if (did.status === "cooling") return !did.cooling_until || new Date(did.cooling_until) <= now;
  return false;
}

export function coolingUntil(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/** Midnight IST today, as an instant — the daily cap resets then, not at UTC midnight. */
export function istDayStart(now: Date): Date {
  const IST = 330 * 60_000;
  const local = new Date(now.getTime() + IST);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() - IST);
}

export type DidPick =
  | { ok: true; did: DidRow; reason: "same_as_last_time" | "least_used" }
  | { ok: true; did: null; reason: "company_has_no_numbers" }
  | { ok: false; reason: "all_numbers_at_cap" | "all_numbers_resting" };

/**
 * The number an outbound call goes out on.
 *  - Only the company's own outbound-capable numbers, not resting.
 *  - A portfolio with numbers of its own uses only those; others use the unscoped ones.
 *  - The number this borrower was last called from, if it is still usable — so they recognise it.
 *  - Otherwise the least-used number today (ties: list order), under its daily cap.
 * A company with no numbers at all gets `did: null` — the vendor's default caller ID applies.
 */
export function pickDid(args: {
  dids: DidRow[];
  clientId: string;
  portfolioId?: string | null;
  /** The number this borrower was last called from by this company. */
  lastDidId?: string | null;
  usedToday: Map<string, number>;
  defaultDailyCap: number;
  now: Date;
}): DidPick {
  const owned = args.dids.filter(
    (d) => d.status === "assigned" && d.client_id === args.clientId && d.use !== "inbound",
  );
  if (!owned.length) return { ok: true, did: null, reason: "company_has_no_numbers" };

  const forPortfolio = args.portfolioId
    ? owned.filter((d) => d.portfolio_id === args.portfolioId)
    : [];
  const scoped = forPortfolio.length ? forPortfolio : owned.filter((d) => !d.portfolio_id);
  const awake = scoped.filter((d) => !d.resting_until || new Date(d.resting_until) <= args.now);
  if (!awake.length) return { ok: false, reason: "all_numbers_resting" };

  const used = (d: DidRow) => args.usedToday.get(d.id) ?? 0;
  const underCap = awake.filter((d) => used(d) < (d.daily_cap ?? args.defaultDailyCap));
  if (!underCap.length) return { ok: false, reason: "all_numbers_at_cap" };

  const last = args.lastDidId ? underCap.find((d) => d.id === args.lastDidId) : undefined;
  if (last) return { ok: true, did: last, reason: "same_as_last_time" };

  const best = underCap.reduce((a, b) => (used(b) < used(a) ? b : a));
  return { ok: true, did: best, reason: "least_used" };
}

export function didPickMessage(reason: "all_numbers_at_cap" | "all_numbers_resting"): string {
  return reason === "all_numbers_at_cap"
    ? "Every calling number for your company has reached today's limit. Ask your platform admin for more numbers."
    : "Every calling number for your company is resting. Ask your platform admin.";
}

/** A sudden drop in pick-ups usually means a number has been marked as spam. */
export type DidHealth = "ok" | "watch" | "rest" | "too_few_calls";

export const HEALTH_MIN_CALLS = 50;

/** Compare a number's 7-day answer rate with the company's average across its numbers. */
export function didHealth(args: {
  calls7d: number;
  answered7d: number;
  companyRate: number;
}): DidHealth {
  if (args.calls7d < HEALTH_MIN_CALLS || args.companyRate <= 0) return "too_few_calls";
  const ratio = args.answered7d / args.calls7d / args.companyRate;
  if (ratio < 0.5) return "rest";
  if (ratio < 0.75) return "watch";
  return "ok";
}
