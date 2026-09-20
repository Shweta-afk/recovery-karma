// Tiny in-memory sliding-window limiter for server functions that cost money or reach real
// phones (dial, SMS). Per-process, like the dialer's own state — fine for one Railway
// instance; put it in the database or Redis before running more than one.

const hits = new Map<string, number[]>();
const MAX_KEYS = 5000;

/** Throws when `key` has already made `limit` calls in the last `windowMs`. */
export function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    throw new Error("Too many requests — slow down and try again in a minute.");
  }
  recent.push(now);
  hits.set(key, recent);

  if (hits.size > MAX_KEYS) {
    for (const [k, ts] of hits) {
      if (ts.every((t) => now - t >= windowMs)) hits.delete(k);
    }
  }
}
