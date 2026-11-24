import { describe, expect, test } from "bun:test";
import { takenBackByTopup } from "../src/lib/topup-takebacks";

const t = (id: string, amount: number, createdAt: string) => ({ id, amount, createdAt });

describe("takenBackByTopup", () => {
  test("no take-backs → nothing taken", () => {
    const m = takenBackByTopup([t("a", 10000, "2026-10-28T08:54:02Z")], []);
    expect(m.get("a")).toBe(0);
  });

  test("one recharge, part taken back (Gajanan, 2026-11-21)", () => {
    const m = takenBackByTopup(
      [t("a", 10000, "2026-10-28T08:54:02Z")],
      [t("x", 4498.58, "2026-11-21T12:51:17Z")],
    );
    expect(m.get("a")).toBe(4498.58);
  });

  test("newest recharge first, then spills into older ones", () => {
    const m = takenBackByTopup(
      [t("old", 5000, "2026-10-01T00:00:00Z"), t("new", 2000, "2026-11-01T00:00:00Z")],
      [t("x", 3000, "2026-11-10T00:00:00Z")],
    );
    expect(m.get("new")).toBe(2000);
    expect(m.get("old")).toBe(1000);
  });

  test("a recharge made after the take-back is never reduced by it", () => {
    const m = takenBackByTopup(
      [t("before", 1000, "2026-10-01T00:00:00Z"), t("after", 9000, "2026-11-15T00:00:00Z")],
      [t("x", 500, "2026-11-01T00:00:00Z")],
    );
    expect(m.get("before")).toBe(500);
    expect(m.get("after")).toBe(0);
  });

  test("never takes more than a recharge held", () => {
    const m = takenBackByTopup(
      [t("a", 1000, "2026-10-01T00:00:00Z")],
      [t("x", 800, "2026-10-02T00:00:00Z"), t("y", 800, "2026-10-03T00:00:00Z")],
    );
    expect(m.get("a")).toBe(1000);
  });
});
