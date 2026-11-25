import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { INTENSITY_BANDS } from "../src/lib/debtor-page-store";

describe("Call Queue intensity filter", () => {
  test("every band the screen offers is one debtor_list understands", () => {
    const sql = readFileSync(
      "src/supabase/migrations/20261125_debtor_list_call_intensity.sql",
      "utf8",
    );
    for (const [band] of INTENSITY_BANDS) expect(sql).toContain(`p->>'intensity' = '${band}'`);
    expect(sql).toContain("WHEN 'intensity' THEN intensity_expr");
    expect(sql).toContain("AS call_count");
    // Same counting rule as the Feedback File's "Intensity of Calls": no-dial updates don't count.
    expect(sql).toContain("dial_mode IS DISTINCT FROM 'no_call'");
  });
});
