// PostgREST caps rows returned per request at db.max_rows (this project's default: 1000) —
// silently, with no error and no truncation flag in the response. Writes aren't capped, so a
// 10k-row portfolio inserts fine and the very next unpaginated read-back only sees the first
// 1000, with nothing anywhere to say so. fetchAllRows() pages past that ceiling.
//
// Lives in its own module (rather than in portfolio-store, where it started) because
// disposition-store and payments-store need the identical guard on their own call_logs /
// payments / debtors reads — sharing it through portfolio-store would have meant a static
// import cycle, since portfolio-store already reaches into payments-store.
export const MAX_PAGE_ROWS = 1000;

/**
 * Pages fetched at once. The first implementation chained them — await page 1, then page 2 —
 * so 15,059 debtors meant 16 round trips end to end and several seconds before anything
 * rendered. Pages are independent range queries, so they can go together.
 *
 * 4 is a deliberate middle: it turns 16 trips into 4 batches while keeping the burst small,
 * because two other stores page their own tables at the same time on a page load.
 */
const CONCURRENCY = 4;

/**
 * Reads every row past PostgREST's per-request cap, a batch of pages at a time.
 *
 * Rows are appended in page order regardless of which request settles first, so the result is
 * identical to the sequential version. A batch may request pages past the end of the table;
 * those come back empty and are discarded — a few wasted requests in exchange for cutting the
 * wall time by ~4x, and only ever on the final batch.
 */
export async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const batch = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) => {
        const start = from + i * MAX_PAGE_ROWS;
        return page(start, start + MAX_PAGE_ROWS - 1);
      }),
    );

    let done = false;
    for (const { data, error } of batch) {
      // Return what we have rather than a partial set silently presented as complete — the
      // callers all check `error` and bail without writing their cache.
      if (error) return { data: all, error };
      if (!data || data.length === 0) {
        done = true;
        break;
      }
      all.push(...data);
      // A short page can only mean end of table for a range query over a stable ordering.
      if (data.length < MAX_PAGE_ROWS) done = true;
    }
    if (done) break;
    from += CONCURRENCY * MAX_PAGE_ROWS;
  }
  return { data: all, error: null };
}
