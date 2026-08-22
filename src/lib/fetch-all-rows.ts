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

export async function fetchAllRows<T>(
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const all: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await page(from, from + MAX_PAGE_ROWS - 1);
    if (error) return { data: all, error };
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < MAX_PAGE_ROWS) break;
    from += MAX_PAGE_ROWS;
  }
  return { data: all, error: null };
}
