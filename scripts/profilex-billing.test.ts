// The money-critical half of the ProfileX integration: what a lookup cost, which billing month
// it lands in, and which numbers it surfaced. Getting any of these wrong either under-reports
// spend (so the budget cap never bites) or writes junk into a debtor's dialable numbers.
import { describe, expect, test } from "bun:test";
import {
  extractPhones,
  normaliseBaseUrl,
  isHit,
  istMonthStart,
  normalisePhone,
  readProviderStatus,
} from "../src/lib/profilex/billing";
import { getService, priceFor } from "../src/lib/profilex/catalogue";

describe("priceFor", () => {
  const employment = getService("employment-latest")!;
  const uan = getService("mobile-to-uan")!;

  test("charges the found price on status 1", () => {
    expect(priceFor(employment, "1")).toBe(5);
  });

  test("still charges on a not-found — ProfileX bills for status 2", () => {
    expect(priceFor(employment, "2")).toBe(1);
  });

  test("mobile-to-uan is genuinely free when it finds nothing", () => {
    expect(priceFor(uan, "2")).toBe(0);
  });

  test("employment-history's status 3 is priced like any other miss", () => {
    expect(priceFor(getService("employment-history")!, "3")).toBe(1);
  });

  test("an unknown or null status fails EXPENSIVE, not free", () => {
    // Employment Latest has been seen returning a null status with a success message. Recording
    // ₹0 there would silently under-report spend, which is the failure that matters.
    expect(priceFor(employment, null)).toBe(5);
    expect(priceFor(employment, "99")).toBe(5);
  });

  test("a client rate card overrides list price per status", () => {
    const card = { "employment-latest": { "1": 4.5 } };
    expect(priceFor(employment, "1", card)).toBe(4.5);
    // Statuses the card doesn't mention keep the catalogue price.
    expect(priceFor(employment, "2", card)).toBe(1);
  });
});

describe("readProviderStatus", () => {
  test("reads data.status, coercing to string", () => {
    expect(readProviderStatus({ data: { status: 1 } })).toBe("1");
    expect(readProviderStatus({ data: { status: "2" } })).toBe("2");
  });

  test("falls back to a top-level status", () => {
    expect(readProviderStatus({ status: "1" })).toBe("1");
  });

  test("treats null, missing and empty-string as unknown", () => {
    expect(readProviderStatus({ data: { status: null } })).toBeNull();
    expect(readProviderStatus({ data: {} })).toBeNull();
    expect(readProviderStatus({ data: { status: "" } })).toBeNull();
    expect(readProviderStatus(null)).toBeNull();
  });

  test("only status 1 counts as a hit", () => {
    expect(isHit("1")).toBe(true);
    expect(isHit("2")).toBe(false);
    expect(isHit(null)).toBe(false);
  });
});

describe("istMonthStart", () => {
  test("returns the IST month boundary, not the UTC one", () => {
    // 2026-08-01 02:00 IST is still 2026-07-31 20:30 UTC — a UTC-based boundary would put this
    // in July and let the last evening of a month spend against the wrong budget.
    const start = istMonthStart(new Date("2026-07-31T20:30:00Z"));
    expect(start.toISOString()).toBe("2026-07-31T18:30:00.000Z"); // = 2026-08-01 00:00 IST
  });

  test("mid-month resolves to that month's first IST midnight", () => {
    expect(istMonthStart(new Date("2026-08-26T09:00:00Z")).toISOString()).toBe(
      "2026-07-31T18:30:00.000Z",
    );
  });
});

describe("extractPhones", () => {
  test("finds a mobile nested anywhere in the payload", () => {
    const body = {
      data: { uan_details: { "101751597636": { basic_details: { mobile: "9632065320" } } } },
    };
    expect([...extractPhones(body)]).toEqual(["9632065320"]);
  });

  test("strips a 91 country code and formatting", () => {
    expect([...extractPhones({ phone: "+91 96320-65320" })]).toEqual(["9632065320"]);
  });

  test("ignores empty and non-dialable values", () => {
    // Employment History routinely returns an empty mobile, and ids/scores sit next to it.
    expect([...extractPhones({ mobile: "" })]).toEqual([]);
    expect([...extractPhones({ mobile: "12345" })]).toEqual([]);
    // Indian mobiles start 6-9; a landline-style leading digit must not be dialed.
    expect([...extractPhones({ mobile: "1234567890" })]).toEqual([]);
    expect([...extractPhones({ member_id: "BGBNG23732610000010096" })]).toEqual([]);
  });

  test("walks arrays and de-duplicates", () => {
    const body = { a: [{ phone: "9632065320" }, { alternate_phone: "9632065320" }] };
    expect([...extractPhones(body)]).toEqual(["9632065320"]);
  });

  test("survives null and undefined branches", () => {
    expect([...extractPhones({ data: null, other: undefined })]).toEqual([]);
  });
});

describe("normalisePhone", () => {
  test("reduces stored formats to bare 10 digits for comparison", () => {
    expect(normalisePhone("+91 9632065320")).toBe("9632065320");
    expect(normalisePhone("9632065320")).toBe("9632065320");
    expect(normalisePhone(null)).toBe("");
  });
});

describe("normaliseBaseUrl", () => {
  const PATH = "/core-svc/api/v2/vre/exp/mobile-intelligence/mobile-to-uan/verification";

  test("accepts the bare origin", () => {
    expect(normaliseBaseUrl("https://profilex-api.neokred.tech")).toBe(
      "https://profilex-api.neokred.tech",
    );
  });

  test("accepts the form ProfileX actually hands out, without doubling the prefix", () => {
    // Their console gives out ".../core-svc/api/v2/", but catalogue paths already carry that
    // prefix — naive concatenation would 404, and silently, since this comes from an env var.
    for (const given of [
      "https://profilex-api.neokred.tech/core-svc/api/v2/",
      "https://profilex-api.neokred.tech/core-svc/api/v2",
      "https://profilex-api.neokred.tech/CORE-SVC/API/V2/",
    ]) {
      expect(normaliseBaseUrl(given) + PATH).toBe("https://profilex-api.neokred.tech" + PATH);
    }
  });

  test("strips stray trailing slashes", () => {
    expect(normaliseBaseUrl("https://profilex-api.neokred.tech///")).toBe(
      "https://profilex-api.neokred.tech",
    );
  });

  test("falls back to the production origin when unset or blank", () => {
    expect(normaliseBaseUrl(undefined)).toBe("https://profilex-api.neokred.tech");
    expect(normaliseBaseUrl("   ")).toBe("https://profilex-api.neokred.tech");
  });

  test("leaves a genuinely different host alone, for mock servers", () => {
    expect(normaliseBaseUrl("http://localhost:9999")).toBe("http://localhost:9999");
  });
});
