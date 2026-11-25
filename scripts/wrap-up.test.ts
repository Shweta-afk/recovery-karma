// Wrap-up (2026-11-25): an agent writing a Productive Dial disposition is rung for nobody, and
// a forgotten wrap-up ends by itself. See src/lib/telephony/wrap-up.ts.
import { describe, expect, test } from "bun:test";
import {
  MAX_WRAP_UP_MS,
  endWrapUp,
  inWrapUp,
  notInWrapUp,
  startWrapUp,
} from "../src/lib/telephony/wrap-up";

describe("wrap-up", () => {
  const t0 = Date.parse("2026-11-25T08:54:00Z");

  test("an agent in wrap-up is not free; others are", () => {
    startWrapUp("8604", t0);
    expect(inWrapUp("8604", t0 + 1000)).toBe(true);
    expect(notInWrapUp(["8604", "8605"], t0 + 1000)).toEqual(["8605"]);
    endWrapUp("8604");
    expect(inWrapUp("8604", t0 + 2000)).toBe(false);
  });

  test("a wrap-up nobody ends runs out by itself", () => {
    startWrapUp("8606", t0);
    expect(inWrapUp("8606", t0 + MAX_WRAP_UP_MS - 1)).toBe(true);
    expect(inWrapUp("8606", t0 + MAX_WRAP_UP_MS)).toBe(false);
    expect(notInWrapUp(["8606"], t0 + MAX_WRAP_UP_MS + 1)).toEqual(["8606"]);
  });

  test("starting again restarts the clock", () => {
    startWrapUp("8607", t0);
    startWrapUp("8607", t0 + 60_000);
    expect(inWrapUp("8607", t0 + MAX_WRAP_UP_MS + 30_000)).toBe(true);
    endWrapUp("8607");
  });
});
