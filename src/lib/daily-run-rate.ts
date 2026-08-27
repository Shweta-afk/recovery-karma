/**
 * DRR — Daily Run Rate. "To hit the monthly target, how much must I collect *per day* over
 * the days I have left?"
 *
 * It is deliberately NOT the old "Run Rate" tile, which was a *projection* (current pace,
 * extrapolated to month end — i.e. where you will land if nothing changes). DRR is the
 * opposite direction: it is the demand the remaining target places on the days left. It rises
 * as you fall behind and falls as you get ahead, so it is actionable in a way a projection
 * never is. Both numbers are useful, which is why the dashboard now shows DRR *and* keeps the
 * projection beside it.
 *
 *     DRR = max(0, monthlyTarget − collectedSoFar) / calendarDaysRemaining
 *
 * **Calendar days, not working days** (owner decision, 2026-08-27). Note the rest of the agent
 * dashboard scales its *call-count* target by Mon-Fri working days, so the two live side by
 * side with different notions of "a day". That is known and accepted; see docs/BACKLOG.md.
 *
 * Days are counted in **IST**, like every other date in this app — the month rolls at midnight
 * IST, so an agent opening the dashboard at 00:30 on the 1st sees a fresh month, not the last
 * day of the old one.
 */
import { istDayKey } from "./monthly-trend";
import { getPortfolios } from "./portfolio-store";

/** The IST calendar month `now` falls in, and how much of it is left. */
export interface MonthDays {
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31 — today's date in IST. */
  today: number;
  /** Days in this month (28-31). */
  total: number;
  /** Days already gone, today NOT counted — today is still collectable. */
  elapsed: number;
  /** Days left INCLUDING today. Never below 1, so it is always a safe divisor: on the last
   * day of the month the whole remaining target is due today, which is correct. */
  remaining: number;
}

export function monthDays(now: Date = new Date()): MonthDays {
  // Via the IST day key rather than getFullYear()/getMonth(), so a viewer in another timezone
  // (or a server-rendered pass) still gets India's calendar.
  const [y, m, d] = istDayKey(now.toISOString()).split("-").map(Number);
  const total = new Date(y, m, 0).getDate(); // day 0 of next month = last day of this one
  return {
    year: y,
    month: m,
    today: d,
    total,
    elapsed: d - 1,
    remaining: Math.max(1, total - d + 1),
  };
}

/** "YYYY-MM" for a timestamp, in IST — the month key that pairs with istDayKey's day key.
 * Month-to-date sums must use this rather than getMonth(), or collections logged between
 * midnight and 05:30 IST on the 1st land in the previous month. */
export function istMonthKey(iso: string | null | undefined): string {
  return istDayKey(iso).slice(0, 7);
}

export interface DrrResult {
  /** The monthly target being worked toward. */
  target: number;
  /** Collected so far this month. */
  achieved: number;
  /** What is still owed. Zero once the target is met. */
  shortfall: number;
  /** Days left including today. */
  daysRemaining: number;
  /**
   * ₹ per remaining day needed to close the shortfall — the headline number.
   * `null` when no target is set, which is NOT the same as zero: zero means "you're done",
   * null means "nobody told us what done is". The UI must show these differently.
   */
  drr: number | null;
  /** True once the target is met. */
  met: boolean;
  /** What DRR was at the start of the month — the "flat" pace, for context on how far the
   * required rate has drifted from the original ask. Null when no target is set. */
  baseline: number | null;
}

export function computeDrr(target: number, achieved: number, now: Date = new Date()): DrrResult {
  const { total, remaining } = monthDays(now);
  const hasTarget = Number.isFinite(target) && target > 0;
  const shortfall = Math.max(0, target - achieved);
  return {
    target,
    achieved,
    shortfall,
    daysRemaining: remaining,
    drr: hasTarget ? Math.round(shortfall / remaining) : null,
    met: hasTarget && shortfall === 0,
    baseline: hasTarget ? Math.round(target / total) : null,
  };
}

/**
 * An agent's monthly ₹ collection target: their `portfolio_agent_targets.target_amount` summed
 * across every portfolio they hold.
 *
 * ⚠️ `target_amount` has **no period column**. Reading it as a MONTHLY figure is a convention
 * this function establishes, not something the schema enforces — a manager who enters a
 * portfolio-lifetime number there will silently distort every DRR on the platform. The
 * target-setting UI labels it "per month" for exactly this reason. See docs/BACKLOG.md.
 *
 * Returns 0 when nothing is set, which `computeDrr` reports as `drr: null` rather than
 * inventing a target.
 */
export function monthlyCollectionTarget(agentEmail: string): number {
  if (!agentEmail) return 0;
  return getPortfolios().reduce(
    (sum, p) => sum + (p.agentTargets?.[agentEmail]?.targetAmount ?? 0),
    0,
  );
}

/** Team-level target: every listed agent's monthly target, summed. */
export function teamMonthlyCollectionTarget(agentEmails: string[]): number {
  const portfolios = getPortfolios();
  return agentEmails.reduce(
    (sum, email) =>
      sum + portfolios.reduce((s, p) => s + (p.agentTargets?.[email]?.targetAmount ?? 0), 0),
    0,
  );
}
