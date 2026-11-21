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

/** How a caller number is written in reports ("DID Used"), the way the company's own call export
 *  writes it: 0 + the 10-digit number (07969263743). Blank when the call recorded none (inbound
 *  calls, calls before 2026-11-21, companies without numbers). */
export function formatDidUsed(n: string | null | undefined): string {
  const d = normaliseDid(n ?? "");
  return d ? `0${d}` : "";
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

/** Which kind of call is asking for a number. "manual" = the Manual Dial dock; "queue" = any call
 *  on a portfolio's account from the Call Queue (click-to-call, Progressive, Productive Dial). */
export type CallKind = "manual" | "queue";

export type NumberRefusal =
  | "no_manual_numbers"
  | "no_portfolio"
  | "no_portfolio_numbers"
  | "no_prefix"
  | "all_numbers_at_cap"
  | "all_numbers_resting";

export type DidPick =
  | { ok: true; did: DidRow; reason: "requested" | "least_used" }
  | { ok: true; did: null; reason: "company_has_no_numbers" }
  | { ok: false; reason: NumberRefusal };

/**
 * The number an outbound call goes out on (user, 2026-11-20).
 *  - Only the company's own outbound-capable numbers. A company with none at all gets
 *    `did: null` — the vendor's default caller ID, as before numbers existed.
 *  - Manual Dial uses only the numbers the admin marked Manual. Call Queue calls use only the
 *    numbers the manager picked for that portfolio, and never a Manual one. Nothing picked →
 *    refused, so a portfolio never dials on a number nobody chose.
 *  - With SkyCRM a number must have its prefix: the prefix is what makes the borrower see it.
 *  - Rotates: the least-used allowed number today, under its daily cap and not resting. A
 *    Manual Dial caller may ask for one of the manual numbers; anything else is ignored.
 */
export function pickCallerNumber(args: {
  dids: Array<DidRow & { prefix?: string | null; manual?: boolean }>;
  clientId: string;
  kind: CallKind;
  portfolioId?: string | null;
  /** Number ids the manager picked for `portfolioId` (portfolio_dids). */
  portfolioNumberIds?: ReadonlySet<string>;
  requestedId?: string | null;
  requirePrefix: boolean;
  usedToday: Map<string, number>;
  defaultDailyCap: number;
  now: Date;
}): DidPick {
  const owned = args.dids.filter(
    (d) => d.status === "assigned" && d.client_id === args.clientId && d.use !== "inbound",
  );
  if (!owned.length) return { ok: true, did: null, reason: "company_has_no_numbers" };

  let allowed: typeof owned;
  if (args.kind === "manual") {
    allowed = owned.filter((d) => d.manual);
    if (!allowed.length) return { ok: false, reason: "no_manual_numbers" };
  } else {
    if (!args.portfolioId) return { ok: false, reason: "no_portfolio" };
    const chosen = args.portfolioNumberIds ?? new Set<string>();
    allowed = owned.filter((d) => !d.manual && chosen.has(d.id));
    if (!allowed.length) return { ok: false, reason: "no_portfolio_numbers" };
  }
  if (args.requirePrefix) {
    allowed = allowed.filter((d) => !!d.prefix);
    if (!allowed.length) return { ok: false, reason: "no_prefix" };
  }
  const awake = allowed.filter((d) => !d.resting_until || new Date(d.resting_until) <= args.now);
  if (!awake.length) return { ok: false, reason: "all_numbers_resting" };

  const used = (d: DidRow) => args.usedToday.get(d.id) ?? 0;
  const underCap = awake.filter((d) => used(d) < (d.daily_cap ?? args.defaultDailyCap));
  if (!underCap.length) return { ok: false, reason: "all_numbers_at_cap" };

  if (args.kind === "manual" && args.requestedId) {
    const asked = underCap.find((d) => d.id === args.requestedId);
    if (asked) return { ok: true, did: asked, reason: "requested" };
  }
  // Ties go to the lowest number, so a fresh day starts at the top of the list and walks down.
  const best = [...underCap]
    .sort((a, b) => a.number.localeCompare(b.number))
    .reduce((a, b) => (used(b) < used(a) ? b : a));
  return { ok: true, did: best, reason: "least_used" };
}

/** Numbers a manager may put on a portfolio: the company's outbound-capable ones that the admin
 *  hasn't kept for Manual Dial. */
export function portfolioNumberChoices<T extends DidRow & { manual?: boolean }>(dids: T[]): T[] {
  return dids.filter((d) => d.status === "assigned" && d.use !== "inbound" && !d.manual);
}

export function didPickMessage(reason: NumberRefusal): string {
  switch (reason) {
    case "no_manual_numbers":
      return "No numbers are set for Manual Dial yet. Ask your admin to choose them in Settings → Calling numbers.";
    case "no_portfolio":
      return "This account isn't in a portfolio, so it has no calling numbers. Use Manual Dial instead.";
    case "no_portfolio_numbers":
      return "This portfolio has no calling numbers chosen yet. Ask your manager to choose them on the portfolio page.";
    case "no_prefix":
      return "The calling numbers for this call aren't fully set up yet. Contact SamvadX support.";
    case "all_numbers_at_cap":
      return "Every calling number for this call has reached today's limit. Ask your admin for more numbers.";
    case "all_numbers_resting":
      return "Every calling number for this call is resting. Ask your admin.";
  }
}

/** One number + prefix per pair in a pasted list (SkyCRM sends them as "DID / Prefix" columns:
 *  "00917969263701  3701", one per line or alternating lines). A 3–6 digit token is the prefix of
 *  the number just before it. `bad` holds tokens that are neither. */
export function parseNumbersWithPrefixes(text: string): {
  rows: Array<{ number: string; prefix: string | null }>;
  bad: string[];
} {
  const tokens = text
    .split(/[\s,;|]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => !/^(did|prefix|queue|number)s?$/i.test(t));
  const rows: Array<{ number: string; prefix: string | null }> = [];
  const bad: string[] = [];
  for (const t of tokens) {
    if (/^\+?\d{10,15}$/.test(t)) {
      const number = normaliseDid(t);
      if (!rows.some((r) => r.number === number)) rows.push({ number, prefix: null });
    } else if (/^\d{3,6}$/.test(t) && rows.length && rows[rows.length - 1].prefix === null) {
      rows[rows.length - 1].prefix = t;
    } else bad.push(t);
  }
  return { rows, bad };
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
