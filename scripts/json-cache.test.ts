/**
 * createJsonCache exists to stop the stores re-parsing a multi-megabyte localStorage blob on
 * every read. Reference identity across reads is the property that proves it: if a second
 * read returned a structurally-equal but different array, JSON.parse ran again and the whole
 * point is lost.
 */
import { expect, test } from "bun:test";
import { createJsonCache } from "../src/lib/json-cache";

test("parses once — repeated reads return the same reference", () => {
  const cache = createJsonCache<{ n: number }>("smoke_parse_once");
  cache.write([{ n: 1 }, { n: 2 }]);

  const a = cache.read();
  const b = cache.read();
  expect(a).toBe(b); // same object, i.e. no re-parse
  expect(a.length).toBe(2);
});

test("a write is visible to the very next read", () => {
  // The store pattern is write-then-refresh-then-read, so a caller must never see its own
  // write missing. This is why the memo is invalidated on write rather than on a timer.
  const cache = createJsonCache<{ n: number }>("smoke_write_through");
  cache.write([{ n: 1 }]);
  expect(cache.read().map((r) => r.n)).toEqual([1]);

  cache.write([{ n: 1 }, { n: 2 }]);
  expect(cache.read().map((r) => r.n)).toEqual([1, 2]);
});

test("an unwritten key reads as empty rather than throwing", () => {
  const cache = createJsonCache<{ n: number }>(`smoke_absent_${Date.now()}`);
  expect(cache.read()).toEqual([]);
});
