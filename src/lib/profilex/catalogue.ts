// The ProfileX (Neokred) services SamvadX is allowed to call, as data rather than code — adding
// a fifth endpoint is one entry here plus a price in the admin rate card, no new code path.
//
// Client-safe on purpose: paths and service-ids are not secrets and the UI needs the labels and
// prices to tell a manager what a click will cost. The actual credentials (`secret-key`,
// `access-key`, `client-user-id`) live only in server env — see profilex-actions.server.ts.
//
// Verified against ProfileX's published Postman collection (docs.profilex.tech) on 2026-08-26.

/** What a service consumes. Nothing here accepts a free-text value from the browser: `mobile`
 *  comes from the debtor's own `phone_primary`, `mobile+name` adds their stored name, and a
 *  derived input (`uan`, `gstin`) is read from an earlier trace on that same debtor. That is
 *  what keeps every lookup rooted in data already in the portfolio. */
export type ProfilexInput = "mobile" | "mobile+name" | "uan" | "gstin";

/** How a derived input is obtained: which service supplies it, and how to read it back out of
 *  that service's stored response. Declaring it here rather than branching in the server action
 *  means adding a new chained service is a catalogue entry, not new code. */
export interface DerivedFrom {
  /** Catalogue id of the service that produces this value. */
  service: string;
  /** Shown to a manager when the prerequisite has not been run yet. */
  label: string;
  /** Pull the value out of that service's `response.data`. Returns null when absent. */
  extract: (data: Record<string, unknown>) => string | null;
}

export interface ProfilexService {
  /** Stable slug — persisted in `debtor_traces.service_id`, so never rename one in place. */
  id: string;
  label: string;
  /** Path appended to PROFILEX_BASE_URL. */
  path: string;
  /** The per-service `service-id` request header ProfileX routes on. */
  serviceId: string;
  input: ProfilexInput;
  /** Required for `uan`/`gstin` inputs; omitted for the ones that start from the phone. */
  derivedFrom?: DerivedFrom;
  /** Price in ₹ keyed by the provider's `data.status`. ProfileX bills per service AND per
   *  status: a "not found" (status 2/3) still costs money on most services. Overridable per
   *  client via profilex_settings.rate_card — these are the published list prices. */
  defaultPrices: Record<string, number>;
  blurb: string;
}

const UAN_FROM_MOBILE: DerivedFrom = {
  service: "mobile-to-uan",
  label: "Mobile to UAN",
  extract: (d) => (d.uan ? String(d.uan) : null),
};

const GSTIN_FROM_MOBILE: DerivedFrom = {
  service: "mobile-to-gst",
  label: "Mobile to GST",
  // `result` is a list of GSTINs for the number; the first is the one to resolve contacts for.
  extract: (d) => {
    const first = (d.result as { gstin?: string }[] | undefined)?.[0];
    return first?.gstin ? String(first.gstin) : null;
  },
};

export const PROFILEX_SERVICES: ProfilexService[] = [
  {
    id: "mobile-to-uan",
    label: "Mobile to UAN",
    path: "/core-svc/api/v2/vre/exp/mobile-intelligence/mobile-to-uan/verification",
    serviceId: "1c490ea1-04bb-478f-acfa-4784ee0a3fae",
    input: "mobile",
    defaultPrices: { "1": 3, "2": 0 },
    blurb:
      "Finds the debtor's EPFO UAN from their phone number. Free when nothing is found, and it " +
      "is the only way to unlock the two employment lookups — always run this first.",
  },
  {
    id: "employment-latest",
    label: "Employment — Latest",
    path: "/core-svc/api/v2/vre/exp/validation-service/employment-latest-premium",
    serviceId: "ac5bb035-420b-4be8-86c1-c4e093c4d980",
    input: "uan",
    derivedFrom: UAN_FROM_MOBILE,
    defaultPrices: { "1": 5, "2": 1 },
    blurb: "Current employer, date of joining and whether an exit has been marked.",
  },
  {
    id: "employment-history",
    label: "Employment — History",
    path: "/core-svc/api/v2/vre/emp-history/details",
    serviceId: "772b5313-92d4-4e06-9446-254888a219f2",
    input: "uan",
    derivedFrom: UAN_FROM_MOBILE,
    // This one returns status 3 rather than 2 for "not found".
    defaultPrices: { "1": 5, "2": 1, "3": 1 },
    blurb: "Full employment history across employers, not just the current one.",
  },
  {
    id: "phone-to-prefill",
    label: "Phone to Prefill",
    path: "/core-svc/api/v2/vre/exp/validation-service/phone-to-prefill",
    serviceId: "db7cc657-6211-425c-a02a-6ac9eca68660",
    input: "mobile+name",
    defaultPrices: { "1": 6, "2": 5 },
    blurb:
      "Alternate phone numbers, email addresses and past addresses. The only wired service that " +
      "returns contact details, so it is the one that adds numbers to the debtor's record.",
  },
  {
    id: "mobile-to-gst",
    label: "Mobile to GST",
    path: "/core-svc/api/v2/vre/exp/mobile-to-gst",
    serviceId: "4888084f-87ec-45ae-b590-6a6aa780b448",
    input: "mobile",
    defaultPrices: { "1": 1.42, "2": 1.42 },
    blurb: "Any GST registrations tied to the number — useful when the debtor runs a business.",
  },
  {
    id: "gst-to-contact",
    label: "GST to Contact",
    path: "/core-svc/api/v2/vre/exp/gst-to-contact",
    serviceId: "c6d024c2-0f1d-4318-b2f1-95b8e53d7b89",
    input: "gstin",
    derivedFrom: GSTIN_FROM_MOBILE,
    // The console card shows no pricing for this one. Priced alongside Mobile to GST as a
    // placeholder — confirm against the contract and correct it in Admin > Settings, since every
    // spend figure in Reports is calculated from the rate card.
    defaultPrices: { "1": 1.42, "2": 1.42 },
    blurb: "Business phone and email registered against the debtor's GSTIN.",
  },
];

/** Services that were once wired and no longer are, so historical `debtor_traces` rows still
 *  render a name instead of a raw slug. `mobile-to-prefill-ext` was retired on 2026-08-26: it
 *  returned HTTP 500 "You Dont Have UAT Access!!!" on every attempt while the VRE variant
 *  (`phone-to-prefill`) works and returns a superset of its fields. Leaving it selectable only
 *  gave managers a button that always failed. */
export const RETIRED_SERVICE_LABELS: Record<string, string> = {
  "mobile-to-prefill-ext": "Mobile to Prefill Ext (retired)",
};

export function getService(id: string): ProfilexService | undefined {
  return PROFILEX_SERVICES.find((s) => s.id === id);
}

/** The service whose UAN the employment lookups depend on. */
export const UAN_SOURCE_SERVICE = "mobile-to-uan";

/**
 * What a call will cost, in ₹, given the provider status it comes back with. `rateCard` is the
 * client's override map from profilex_settings; anything missing falls back to list price.
 *
 * Fails EXPENSIVE on an unrecognised status: an unpriced status is far more likely to be a
 * billable one we haven't catalogued than a free one, and under-recording spend is the failure
 * mode that matters here. `Employment — Latest` has been seen returning a null status alongside
 * `message: "UAN found"`, so this is not hypothetical.
 */
export function priceFor(
  service: ProfilexService,
  status: string | null,
  rateCard?: Record<string, Record<string, number>> | null,
): number {
  const prices = { ...service.defaultPrices, ...(rateCard?.[service.id] ?? {}) };
  if (status !== null && status in prices) return prices[status];
  return Math.max(...Object.values(prices));
}
