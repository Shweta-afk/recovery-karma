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
  phoneVariants,
  pickReusable,
} from "../src/lib/profilex/billing";
import {
  ALL_SERVICE_IDS,
  LEGACY_SERVICE_IDS,
  PROFILEX_SERVICES,
  SKIP_TRACING_SERVICE,
  priceLine,
  priceStatuses,
  statusLabel,
  getService,
  priceFor,
  providerCost,
  SAMVADX_PRICES,
} from "../src/lib/profilex/catalogue";

describe("priceFor", () => {
  const employment = getService("employment-latest")!;
  const uan = getService("mobile-to-uan")!;

  test("charges the found price on status 1", () => {
    expect(providerCost(employment, "1")).toBe(5);
  });

  test("still charges on a not-found — ProfileX bills for status 2", () => {
    expect(providerCost(employment, "2")).toBe(1);
  });

  test("mobile-to-uan is genuinely free when it finds nothing", () => {
    expect(providerCost(uan, "2")).toBe(0);
  });

  test("employment-history's status 3 is priced like any other miss", () => {
    expect(providerCost(getService("employment-history")!, "3")).toBe(1);
  });

  test("an unknown or null status fails EXPENSIVE, not free", () => {
    // Employment Latest has been seen returning a null status with a success message. Recording
    // ₹0 there would silently under-report spend, which is the failure that matters.
    expect(providerCost(employment, null)).toBe(5);
    expect(providerCost(employment, "99")).toBe(5);
  });

  test("a client rate card overrides list price per status", () => {
    const card = { "employment-latest": { "1": 4.5 } };
    expect(priceFor(employment, "1", card)).toBe(4.5);
    // A status the card leaves blank costs the company's found price, never the provider's
    // list price (user, 2026-10-21).
    expect(priceFor(employment, "2", card)).toBe(4.5);
  });

  test("Financial Behaviour priced ₹15 for found only costs ₹15 for a miss too", () => {
    // The bug: the company was quoted and charged the provider's ₹11.25 for status 2.
    const fb = getService("financial-behaviour")!;
    const card = { "financial-behaviour": { "1": 15 } };
    expect(priceFor(fb, "1", card)).toBe(15);
    expect(priceFor(fb, "2", card)).toBe(15);
    expect(priceFor(fb, "OK", card)).toBe(15);
    expect(priceFor(fb, null, card)).toBe(15);
    expect(priceLine(fb, card)).toBe("₹15 if found, ₹15 if not");
  });

  test("a miss price the company did set is kept, including ₹0", () => {
    const card = { "employment-latest": { "1": 7, "2": 2 }, "mobile-to-uan": { "1": 5, "2": 0 } };
    expect(priceFor(employment, "2", card)).toBe(2);
    expect(priceFor(uan, "2", card)).toBe(0);
  });

  test("with no price for the service at all, SamvadX's standard price applies", () => {
    expect(priceFor(employment, "2", { "mobile-to-uan": { "1": 5 } })).toBe(1);
  });

  test("an unknown status fails expensive within the company's own prices", () => {
    const card = { "employment-latest": { "1": 7, "2": 2 } };
    expect(priceFor(employment, "99", card)).toBe(7);
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

  test("an empty reply is a not-found; no reply at all is unknown", () => {
    expect(readProviderStatus({ data: { status: null } })).toBe("2");
    expect(readProviderStatus({ data: {} })).toBe("2");
    expect(readProviderStatus({ data: { status: "" } })).toBe("2");
    expect(readProviderStatus(null)).toBeNull();
    expect(readProviderStatus({ status: "WEIRD" })).toBe("WEIRD");
  });

  // Shapes copied from live debtor_traces (2026-10-29). Each of these misses used to be read as
  // an unknown status and charged — and shown — at the FOUND price.
  test("reads every not-found shape ProfileX really returns as a miss", () => {
    const ok = (data: Record<string, unknown>, message: string) => ({
      data,
      status: "OK",
      message,
      success: true,
      statusCode: 200,
      transactionId: "t",
    });
    // Employment Latest / History
    expect(
      readProviderStatus(
        ok({ uan: [], status: null, summary: null, uan_details: null }, "No record(s) found"),
      ),
    ).toBe("2");
    // Mobile to GST / GST to Contact
    expect(
      readProviderStatus(
        ok(
          {
            result: [],
            status: null,
            request_id: "r",
            result_code: "103",
            http_response_code: 200,
          },
          "No record found for the given input",
        ),
      ),
    ).toBe("2");
    // Phone to Prefill
    expect(
      readProviderStatus(
        ok({ name: null, email: [], status: "201", address: [] }, "Record Not Found"),
      ),
    ).toBe("2");
    // Financial Behaviour: "success" message, nothing in it
    expect(
      readProviderStatus(
        ok(
          { Score: null, status: null, LoanAccounts: [], Applicant: null },
          "Data Fetched Successfully",
        ),
      ),
    ).toBe("2");
    // CRIF report: status_code 422
    expect(
      readProviderStatus(ok({ status: "OK", status_code: "422" }, "Data Fetched Successfully")),
    ).toBe("2");
  });

  test("an OK reply that carries data is a hit", () => {
    // UPI IDs
    expect(
      readProviderStatus({
        data: { status: "OK", upi_id: ["x@sbi"], status_code: "1", mobile_number: "9" },
        status: "OK",
        message: "Data Fetched Successfully",
      }),
    ).toBe("1");
    expect(
      readProviderStatus({
        data: { status: "OK", name: "A B" },
        status: "OK",
        message: "Record found",
      }),
    ).toBe("1");
    // A documented code always wins over the message.
    expect(readProviderStatus({ data: { status: 2 }, message: "Success" })).toBe("2");
    expect(readProviderStatus({ data: { status: "1", x: null }, message: "Record found" })).toBe(
      "1",
    );
  });

  test("a not-found is charged the not-found price, end to end", () => {
    const employment = getService("employment-latest")!;
    const card = { "employment-latest": { "1": 7, "2": 2 } };
    const miss = readProviderStatus({
      data: { uan: [], status: null },
      status: "OK",
      message: "No record(s) found",
    });
    expect(priceFor(employment, miss, card)).toBe(2);
    expect(providerCost(employment, miss)).toBe(1);
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

describe("skip tracing (VRE Skip Tracing, the ₹46 card)", () => {
  const skip = getService(SKIP_TRACING_SERVICE)!;

  test("is the v1 endpoint, not V2 or the X / + GST / + Locate variants", () => {
    expect(skip.path).toBe("/core-svc/api/v2/exp/vre-skip-tracing");
    expect(skip.input).toBe("mobile+firstName");
  });

  test("is catalogued with no service-id, because sending one is rejected", () => {
    // Verified live: the skip-tracing paths return HTTP 500 "Invalid service url" for any
    // service-id, and reach input validation without one.
    expect(skip.serviceId).toBeUndefined();
  });

  test("an unpriced not-found is recorded at the known ₹46, never ₹0", () => {
    expect(providerCost(skip, "1")).toBe(46);
    expect(providerCost(skip, "2")).toBe(46);
    expect(providerCost(skip, null)).toBe(46);
  });

  // Mirrors the real v1 response: each source's payload nested under its own key. Note there is
  // no vreMobileToGst block in this bundle.
  const bundle = {
    status: "1",
    vreMobileToUan: { status: "1", uan: "101629726934" },
    getAlternatePhoneNumber: { status: "1", alternate_phones: ["+918660820296"] },
    vrePhoneToPrefill: { alternatePhone: [{ serialNo: 1, phoneNumber: "09632065320" }] },
  };

  test("its UAN unlocks the employment lookups without paying for Mobile to UAN", () => {
    for (const id of ["employment-latest", "employment-history"]) {
      const via = getService(id)!.derivedFrom!.sources.find(
        (s) => s.service === SKIP_TRACING_SERVICE,
      );
      expect(via?.extract(bundle)).toBe("101629726934");
    }
  });

  test("it does NOT claim to unlock GST to Contact — this bundle has no GST block", () => {
    const sources = getService("gst-to-contact")!.derivedFrom!.sources.map((s) => s.service);
    expect(sources).not.toContain(SKIP_TRACING_SERVICE);
  });

  test("the standalone service is still tried first", () => {
    const from = getService("employment-latest")!.derivedFrom!;
    expect(from.sources[0].service).toBe("mobile-to-uan");
    expect(from.sources[0].extract({ uan: "101751597636" })).toBe("101751597636");
  });

  test("a bundle with a block missing yields nothing rather than throwing", () => {
    const via = getService("employment-latest")!.derivedFrom!.sources.find(
      (s) => s.service === SKIP_TRACING_SERVICE,
    )!;
    expect(via.extract({ status: "1" })).toBeNull();
  });

  test("both of its alternate-number sources reach the writeback", () => {
    // getAlternatePhoneNumber holds a plain string array; vrePhoneToPrefill holds objects.
    expect([...extractPhones(bundle)].sort()).toEqual(["8660820296", "9632065320"]);
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

describe("the trunk-0 domestic format", () => {
  test("normalisePhone strips a leading 0 from an 11-digit number", () => {
    expect(normalisePhone("09632065320")).toBe("9632065320");
  });

  test("extractPhones keeps it, as the provider returns it in vrePhoneToPrefill", () => {
    expect([...extractPhones({ alternatePhone: [{ phoneNumber: "09632065320" }] })]).toEqual([
      "9632065320",
    ]);
  });

  test("an 11-digit number that does not start with 0 is still rejected", () => {
    expect([...extractPhones({ phone: "19632065320" })]).toEqual([]);
  });
});

describe("the alternate-contact lookups", () => {
  test("Alternate Phone Numbers is genuinely free on a miss", () => {
    const svc = getService("get-alternate-phone")!;
    expect(providerCost(svc, "1")).toBe(6);
    expect(providerCost(svc, "2")).toBe(0);
  });

  test("Alternate Addresses charges its only known price for an unpriced status", () => {
    const svc = getService("get-alternate-address")!;
    expect(providerCost(svc, "1")).toBe(4);
    expect(providerCost(svc, null)).toBe(4);
  });

  test("both send the debtor's number as `phone`, not `mobile`", () => {
    // The provider rejects these two with "Missing required input fields: phone" otherwise.
    for (const id of ["get-alternate-phone", "get-alternate-address"]) {
      expect(getService(id)!.input).toBe("phone");
    }
  });

  test("the numbers it returns reach the writeback", () => {
    // alternate_phones is a plain string array carrying +91 prefixes.
    const body = { alternate_phones: ["+918660820296", "09632065320"] };
    expect([...extractPhones(body)].sort()).toEqual(["8660820296", "9632065320"]);
  });
});

describe("UPI IDs and LPG Connection", () => {
  test("are priced the same found or not, as their console cards show", () => {
    expect(providerCost(getService("mobile-to-multiple-upi")!, "1")).toBe(1.58);
    expect(providerCost(getService("mobile-to-multiple-upi")!, "2")).toBe(1.58);
    expect(providerCost(getService("mobile-to-lpg-advance")!, "1")).toBe(15);
    expect(providerCost(getService("mobile-to-lpg-advance")!, "2")).toBe(15);
  });

  test("LPG Advance is called without a service-id, UPI IDs with one", () => {
    expect(getService("mobile-to-lpg-advance")!.serviceId).toBeUndefined();
    expect(getService("mobile-to-multiple-upi")!.serviceId).toBeDefined();
  });

  test("UPI IDs uses the VRE path — the non-VRE one is not on the account", () => {
    // Verified live: the non-VRE variant returns "You Dont Have UAT Access!!!" even for an
    // empty body, while this one reaches input validation.
    expect(getService("mobile-to-multiple-upi")!.path).toBe(
      "/core-svc/api/v2/vre/exp/upi/v1/mobile-to-multiple-vpa",
    );
  });
});

describe("third-party numbers never reach a debtor's dialable numbers", () => {
  // LPG Advance returns the gas distributor's landline next to the customer's own mobile.
  const lpg = {
    vreConsumerIdToLpg: {
      customer_name: "Saritha Jain",
      customer_mobile: "8861588181",
      distributor_name: "KAVITHA ENTERPRISES (BLR)",
      distributor_contact: "08023456789",
    },
  };

  test("the debtor's own number is still picked up", () => {
    expect([...extractPhones(lpg)]).toContain("8861588181");
  });

  test("the distributor's line is not, even though it looks like a mobile once normalised", () => {
    expect(normalisePhone("08023456789")).toBe("8023456789"); // passes the digit checks
    expect([...extractPhones(lpg)]).not.toContain("8023456789");
  });

  test("other third-party keys are excluded too", () => {
    for (const key of ["employer_phone", "branch_contact", "helpline_mobile", "office_phone"]) {
      expect([...extractPhones({ [key]: "9632065320" })]).toEqual([]);
    }
  });
});

describe("priceLine — what an admin is quoted must be what they are charged", () => {
  // Axiotta's real markups, as set by superadmin (list prices are ₹3 / ₹5 / ₹6 / ₹1.42).
  const marked: Record<string, Record<string, number>> = {
    "mobile-to-uan": { "1": 5 },
    "employment-latest": { "1": 7 },
    "phone-to-prefill": { "1": 8 },
    "mobile-to-gst": { "1": 4 },
  };

  test("quotes the company's price, not the provider's list price", () => {
    // Only the found price is set, so a miss costs the same (user, 2026-10-21).
    expect(priceLine(getService("mobile-to-uan")!, marked)).toBe("₹5 if found, ₹5 if not");
    expect(priceLine(getService("phone-to-prefill")!, marked)).toBe("₹8 if found, ₹8 if not");
  });

  test("falls back to SamvadX's standard price for a company with no override", () => {
    expect(priceLine(getService("mobile-to-uan")!)).toBe("₹5 if found, free if not");
  });

  test("never claims a miss is free when priceFor would charge for it", () => {
    // ProfileX charges ₹46 for a Skip Tracing miss, so SamvadX's not-found is ₹46, never free.
    expect(priceLine(getService("skip-tracing")!)).toBe("₹48 if found, ₹46 if not");
  });

  test("only says free where the charge really is ₹0", () => {
    expect(priceLine(getService("get-alternate-phone")!)).toBe("₹8 if found, free if not");
  });

  test("keeps paise for fractional prices", () => {
    expect(priceLine(getService("mobile-to-gst")!)).toBe("₹3.42 if found, ₹1.42 if not");
  });

  test("every service, every rate card: the quote equals priceFor", () => {
    for (const svc of PROFILEX_SERVICES) {
      for (const card of [undefined, marked]) {
        const line = priceLine(svc, card);
        const hit = priceFor(svc, "1", card);
        expect(line.startsWith(`₹${Number.isInteger(hit) ? hit : hit.toFixed(2)} if found`)).toBe(
          true,
        );
        // The quoted miss must be a price priceFor can actually produce, never invented.
        const missQuoted = line.includes("free if not")
          ? 0
          : Number(line.split(", ")[1].replace(/[^\d.]/g, ""));
        const possible = Object.keys({
          ...svc.defaultPrices,
          ...(SAMVADX_PRICES[svc.id] ?? {}),
          ...(card?.[svc.id] ?? {}),
        })
          .filter((k) => k !== "1")
          .map((k) => priceFor(svc, k, card));
        expect(possible.length ? possible : [priceFor(svc, null, card)]).toContain(missQuoted);
      }
    }
  });
});

describe("SAMVADX_PRICES — the sheet's SamvadX columns", () => {
  test("covers every ProfileX service in the catalogue", () => {
    for (const svc of PROFILEX_SERVICES.filter((x) => x.provider !== "payprime")) {
      expect(SAMVADX_PRICES[svc.id]).toBeDefined();
    }
  });

  test("never charges a company less than ProfileX charges SamvadX", () => {
    for (const svc of PROFILEX_SERVICES) {
      for (const status of Object.keys({ ...svc.defaultPrices, ...SAMVADX_PRICES[svc.id] })) {
        expect(priceFor(svc, status)).toBeGreaterThanOrEqual(providerCost(svc, status));
      }
    }
  });

  test("not found = ProfileX's not-found cost; blank on ProfileX's sheet = its found price", () => {
    const miss = (id: string) => priceFor(getService(id)!, "2");
    expect(miss("skip-tracing")).toBe(46);
    expect(miss("get-alternate-address")).toBe(4);
    expect(miss("financial-behaviour-crif")).toBe(11.25);
    expect(miss("gst-to-contact")).toBe(1.42);
    expect(miss("mobile-to-uan")).toBe(0);
    expect(miss("get-alternate-phone")).toBe(0);
    for (const svc of PROFILEX_SERVICES.filter((x) => x.provider !== "payprime")) {
      expect(priceFor(svc, "2")).toBe(providerCost(svc, "2"));
    }
  });

  test("a company's own price list still wins", () => {
    const svc = getService("employment-premium-mobile")!;
    expect(priceFor(svc, "1")).toBe(4.25);
    expect(priceFor(svc, "1", { "employment-premium-mobile": { "1": 5 } })).toBe(5);
  });
});

describe("priceStatuses — every service must be priceable for a miss", () => {
  test("found and not-found are always editable, even where the console lists one price", () => {
    // Skip Tracing and Alternate Addresses list only a found price. Without a status-2 box a
    // superadmin could not record what a miss really costs, and priceFor would keep charging
    // the found price for it.
    for (const svc of PROFILEX_SERVICES) {
      expect(priceStatuses(svc)).toContain("1");
      expect(priceStatuses(svc)).toContain("2");
    }
  });

  test("keeps an extra status the catalogue knows about", () => {
    // employment-history returns 3 for a miss.
    expect(priceStatuses(getService("employment-history")!)).toEqual(["1", "2", "3"]);
  });

  test("keeps a status the company's rate card already carries, so nothing becomes uneditable", () => {
    const card = { "get-alternate-address": { "1": 4, "7": 2 } };
    expect(priceStatuses(getService("get-alternate-address")!, card)).toEqual(["1", "2", "7"]);
  });

  test("setting a miss price actually changes what is charged", () => {
    const skip = getService("skip-tracing")!;
    expect(priceFor(skip, "2")).toBe(46); // SamvadX's not-found price
    expect(priceFor(skip, "2", { "skip-tracing": { "2": 5 } })).toBe(5);
  });

  test("labels disambiguate when more than one status means not-found", () => {
    const three = priceStatuses(getService("employment-history")!);
    expect(statusLabel("1", three)).toBe("found");
    expect(statusLabel("2", three)).toBe("not found (2)");
    expect(statusLabel("3", three)).toBe("not found (3)");
    const two = priceStatuses(getService("mobile-to-uan")!);
    expect(statusLabel("2", two)).toBe("not found");
  });
});

describe("cross-upload reuse", () => {
  const H = 3_600_000;
  const now = Date.parse("2026-09-20T00:00:00Z");
  const cand = (over: Partial<import("../src/lib/profilex/billing").ReuseCandidate>) => ({
    id: "t1",
    source: "live" as const,
    providerStatus: "1",
    createdAt: new Date(now - 24 * H).toISOString(),
    debtorName: "Ravi Kumar",
    httpStatus: 200,
    response: {},
    ...over,
  });
  const ttl = { hitTtlHours: 720, missTtlHours: 168, now };

  test("phoneVariants covers the ways an upload can store one mobile", () => {
    const v = phoneVariants("9876543210");
    expect(v).toContain("9876543210");
    expect(v).toContain("+919876543210");
    expect(v).toContain("919876543210");
    expect(v).toContain("09876543210");
  });

  test("reuses a found result inside the hit window", () => {
    expect(pickReusable([cand({})], ttl)?.id).toBe("t1");
  });

  test("does not reuse a found result past the hit window", () => {
    expect(
      pickReusable([cand({ createdAt: new Date(now - 721 * H).toISOString() })], ttl),
    ).toBeNull();
  });

  test("a miss expires on the shorter window", () => {
    const miss = cand({ providerStatus: "2", createdAt: new Date(now - 169 * H).toISOString() });
    expect(pickReusable([miss], ttl)).toBeNull();
    const freshMiss = cand({
      providerStatus: "2",
      createdAt: new Date(now - 167 * H).toISOString(),
    });
    expect(pickReusable([freshMiss], ttl)?.id).toBe("t1");
  });

  test("picks the newest of several usable results", () => {
    const older = cand({ id: "old", createdAt: new Date(now - 100 * H).toISOString() });
    const newer = cand({ id: "new", createdAt: new Date(now - 10 * H).toISOString() });
    expect(pickReusable([older, newer], ttl)?.id).toBe("new");
  });

  test("a name-taking service is not reused for a different first name on the same number", () => {
    expect(pickReusable([cand({})], { ...ttl, sameFirstNameAs: "Suresh Patil" })).toBeNull();
    expect(pickReusable([cand({})], { ...ttl, sameFirstNameAs: "  ravi  " })?.id).toBe("t1");
  });

  test("an unparseable date is never reused", () => {
    expect(pickReusable([cand({ createdAt: "garbage" })], ttl)).toBeNull();
  });
});

describe("DIN to Contact — the one manual-only, admin-typed lookup", () => {
  const service = getService("din-to-contact")!;

  test("is catalogued with a din input and marked manual-only", () => {
    expect(service).toBeDefined();
    expect(service.input).toBe("din");
    expect(service.manualOnly).toBe(true);
  });

  test("has no derivedFrom — it cannot be chained off a debtor trace either", () => {
    expect(service.derivedFrom).toBeUndefined();
  });

  test("is not in LEGACY_SERVICE_IDS — no tenant gets it until a superadmin opts in", () => {
    expect(LEGACY_SERVICE_IDS).not.toContain("din-to-contact");
  });

  test("still counted in ALL_SERVICE_IDS, like any other catalogue entry", () => {
    expect(ALL_SERVICE_IDS).toContain("din-to-contact");
  });

  test("prices a found result; an unrecognised status fails expensive to the same price", () => {
    // ProfileX's price sheet (2026-10-29): ₹2.98 found, ₹2.83 not found.
    expect(providerCost(service, "1")).toBe(2.98);
    expect(providerCost(service, "2")).toBe(2.83);
    expect(providerCost(service, null)).toBe(2.98);
  });
});
