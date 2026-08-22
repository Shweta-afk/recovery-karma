/**
 * Boundary tests for fetchAllRows.
 *
 * It now fetches pages in concurrent batches rather than chaining them, which moves the
 * end-of-table detection from "the page I just awaited was short" to "some page in this batch
 * was short or empty". The interesting cases are exact multiples of the page size, where the
 * final full page is followed by an empty one rather than a short one — get that wrong and
 * rows go missing silently, which is the exact failure mode the pagination was added to fix.
 */
import { expect, test } from "bun:test";
import { fetchAllRows } from "../src/lib/fetch-all-rows";

function fakeTable(total: number) {
  let requests = 0;
  const page = (from: number, to: number) => {
    requests++;
    const rows: { i: number }[] = [];
    for (let i = from; i <= Math.min(to, total - 1); i++) rows.push({ i });
    return Promise.resolve({ data: rows, error: null });
  };
  return { page, requests: () => requests };
}

// 1000 = one exact page, 4000 = one exact batch at CONCURRENCY 4, 15059 = the live debtor count.
for (const total of [0, 1, 999, 1000, 1001, 3999, 4000, 4001, 15059]) {
  test(`returns all ${total} rows, in order, exactly once`, async () => {
    const t = fakeTable(total);
    const { data, error } = await fetchAllRows<{ i: number }>(t.page);
    expect(error).toBeNull();
    expect(data.length).toBe(total);
    // Order must match the sequential implementation even though requests settle out of order.
    expect(data.map((r) => r.i)).toEqual(Array.from({ length: total }, (_, i) => i));
  });
}

test("surfaces an error rather than presenting a partial read as complete", async () => {
  const { error } = await fetchAllRows<{ i: number }>((from) =>
    Promise.resolve(
      from === 0
        ? { data: Array.from({ length: 1000 }, (_, i) => ({ i })), error: null }
        : { data: null, error: { message: "boom" } },
    ),
  );
  // Callers key off `error` and skip writing their cache — silently caching a short read is
  // how the original 1000-row truncation bug hid for so long.
  expect(error?.message).toBe("boom");
});
