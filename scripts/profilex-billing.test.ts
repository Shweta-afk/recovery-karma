// The money-critical half of the ProfileX integration: what a lookup cost, which billing month
// it lands in, and which numbers it surfaced. Getting any of these wrong either under-reports
// spend (so the budget cap never bites) or writes junk into a debtor's dialable numbers.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  extractPhones,
  normaliseBaseUrl,
  isHit,
  istMonthStart,
  normalisePhone,
  readProviderStatus,
} from "../src/lib/profilex/billing";
import {
  ALL_SERVICE_IDS,
  LEGACY_SERVICE_IDS,
  SKIP_TRACING_SERVICE,
  getService,
  priceFor,
} from "../src/lib/profilex/catalogue";

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

describe("skip tracing (VRE Skip Tracing V2)", () => {
  const skip = getService(SKIP_TRACING_SERVICE)!;

  test("is catalogued with no service-id, because sending one is rejected", () => {
    // Verified live: any service-id on this path returns HTTP 500 "Invalid service url".
    expect(skip).toBeDefined();
    expect(skip.serviceId).toBeUndefined();
    expect(skip.input).toBe("mobile+firstName");
  });

  test("an unpriced not-found is recorded at the known price, never ₹0", () => {
    expect(priceFor(skip, "1")).toBe(15);
    expect(priceFor(skip, "2")).toBe(15);
    expect(priceFor(skip, null)).toBe(15);
  });

  // Mirrors the real V2 response: each standalone service's payload nested under its own key.
  const bundle = {
    status: "1",
    vreMobileToUan: { status: "1", uan: "100938918944" },
    vreMobileToGst: { status: "1", result: [{ gstin: "29AAMCC4504G1ZN", legal_name: "X LTD" }] },
    vrePhoneToPrefill: { alternatePhone: [{ serialNo: 1, phoneNumber: "9663594134" }] },
  };

  test("its UAN unlocks the employment lookups without paying for Mobile to UAN", () => {
    const from = getService("employment-history")!.derivedFrom!;
    const viaBundle = from.sources.find((s) => s.service === SKIP_TRACING_SERVICE);
    expect(viaBundle?.extract(bundle)).toBe("100938918944");
  });

  test("its GSTIN unlocks GST to Contact", () => {
    const from = getService("gst-to-contact")!.derivedFrom!;
    const viaBundle = from.sources.find((s) => s.service === SKIP_TRACING_SERVICE);
    expect(viaBundle?.extract(bundle)).toBe("29AAMCC4504G1ZN");
  });

  test("the standalone service is still tried first", () => {
    const from = getService("employment-latest")!.derivedFrom!;
    expect(from.sources[0].service).toBe("mobile-to-uan");
    expect(from.sources[0].extract({ uan: "101751597636" })).toBe("101751597636");
  });

  test("a bundle with a block missing yields nothing rather than throwing", () => {
    const from = getService("gst-to-contact")!.derivedFrom!;
    const viaBundle = from.sources.find((s) => s.service === SKIP_TRACING_SERVICE)!;
    expect(viaBundle.extract({ status: "1" })).toBeNull();
  });

  test("its alternate numbers reach the writeback", () => {
    expect([...extractPhones(bundle)]).toContain("9663594134");
  });
});

describe("extractPhones — plain lists under a phone key", () => {
  test("captures numbers held in a string array, the shape the other skip-trace bundles use", () => {
    const body = {
      getAlternatePhoneNumber: { alternate_phones: ["+918660820296", "+919632065320"] },
    };
    expect([...extractPhones(body)].sort()).toEqual(["8660820296", "9632065320"]);
  });

  test("still drops non-dialable entries inside such a list", () => {
    expect([...extractPhones({ phones: ["12345", "", null, "9632065320"] })]).toEqual([
      "9632065320",
    ]);
  });
});

describe("ALL_SERVICE_IDS", () => {
  test("covers the whole catalogue, including skip tracing", () => {
    expect(ALL_SERVICE_IDS).toContain(SKIP_TRACING_SERVICE);
    expect(new Set(ALL_SERVICE_IDS).size).toBe(ALL_SERVICE_IDS.length);
  });
});

describe("LEGACY_SERVICE_IDS", () => {
  test("matches the migration's backfill exactly, so both sides of the migration agree", () => {
    // loadSettings falls back to this list when enabled_services does not exist yet. If it ever
    // drifts from what the migration backfills, a company's plan would silently change the
    // moment the migration is applied.
    const sql = readFileSync(
      "src/supabase/migrations/20260917_profilex_enabled_services.sql",
      "utf8",
    );
    const arrayBody = sql.match(/SET enabled_services = ARRAY\[([\s\S]*?)\]/)?.[1] ?? "";
    const backfilled = [...arrayBody.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(backfilled.length).toBeGreaterThan(0);
    expect([...backfilled].sort()).toEqual([...LEGACY_SERVICE_IDS].sort());
  });

  test("never includes skip tracing — existing companies are opted in explicitly", () => {
    expect(LEGACY_SERVICE_IDS).not.toContain(SKIP_TRACING_SERVICE);
  });

  test("every legacy id is still a real catalogue service", () => {
    for (const id of LEGACY_SERVICE_IDS) expect(ALL_SERVICE_IDS).toContain(id);
  });
});
