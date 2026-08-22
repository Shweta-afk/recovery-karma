/**
 * A localStorage-backed array cache that parses at most once per write.
 *
 * The stores all followed the same shape: `getX()` did `JSON.parse(localStorage.getItem(KEY))`
 * on every call. That is fine for a small cache and ruinous for a large one — the portfolios
 * cache measured 7.5MB live, so each read cost roughly 50-150ms of blocked main thread, and
 * the reads happen in loops. toPortfolio() runs per portfolio and each call reaches into both
 * the dispositions and payments caches, so Portfolio Overview alone did ~26 full parses per
 * render, repeated on every one of the three events its reload is wired to. That is the jank.
 *
 * Parsing is now memoised: the array is held after the first read and returned by reference
 * until something invalidates it. Invalidation is precise rather than time-based —
 *   * write() replaces the memo with exactly what it just stored;
 *   * another tab writing the same key fires a `storage` event and drops the memo.
 * There is no TTL, so a caller can never observe a stale snapshot of its own writes.
 *
 * Callers get the SAME array reference across reads, so they must not mutate it in place.
 * Every existing caller filters/maps, which allocates, so this holds today.
 *
 * write() also folds in the quota fallback each store had grown its own copy of: when
 * localStorage refuses the value (the 7.5MB cache exceeded it routinely), the data is served
 * from memory for this tab instead and the write reports false so the caller can log it.
 */
export function createJsonCache<T>(key: string) {
  let memo: T[] | null = null;
  /** Set only when a write was rejected — see write(). */
  let fallback: T[] | null = null;

  // Guarded for SSR: these modules are imported during server render and by the route smoke
  // test, where neither window nor localStorage exists.
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (e) => {
      if (e.key === key) memo = null;
    });
  }

  return {
    read(): T[] {
      if (fallback) return fallback;
      if (memo) return memo;
      try {
        const raw = localStorage.getItem(key);
        memo = raw ? (JSON.parse(raw) as T[]) : [];
        return memo;
      } catch {
        return [];
      }
    },

    /** Returns false when localStorage rejected the value and it is memory-only for this tab. */
    write(value: T[]): boolean {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        memo = value;
        fallback = null;
        return true;
      } catch {
        // Not a crash: reads keep working off `fallback` with this tab's freshest data. Only
        // cross-tab sync pauses, since the native `storage` event fires on writes that land.
        fallback = value;
        memo = null;
        return false;
      }
    },
  };
}
