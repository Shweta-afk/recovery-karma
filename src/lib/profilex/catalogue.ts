// The ProfileX (Neokred) services SamvadX is allowed to call, as data rather than code — adding
// a fifth endpoint is one entry here plus a price in the admin rate card, no new code path.
//
// Client-safe on purpose: paths and service-ids are not secrets and the UI needs the labels and
// prices to tell a manager what a click will cost. The actual credentials (`secret-key`,
// `access-key`, `client-user-id`) live only in server env — see profilex-actions.server.ts.
//
// Verified against ProfileX's published Postman collection (docs.profilex.tech) on 2026-08-26.

/** What a service consumes. Nothing here accepts a free-text value from the browser: `mobile`
 *  is read from the debtor's own `phone_primary`, and `uan` from a stored mobile-to-uan trace
 *  on that same debtor. That is what keeps lookups to numbers already in a portfolio. */
export type ProfilexInput = "mobile" | "uan";

export interface ProfilexService {
  /** Stable slug — persisted in `debtor_traces.service_id`, so never rename one in place. */
  id: string;
  label: string;
  /** Path appended to PROFILEX_BASE_URL. */
  path: string;
  /** The per-service `service-id` request header ProfileX routes on. */
  serviceId: string;
  input: ProfilexInput;
  /** Price in ₹ keyed by the provider's `data.status`. ProfileX bills per service AND per
   *  status: a "not found" (status 2/3) still costs money on most services. Overridable per
   *  client via profilex_settings.rate_card — these are the published list prices. */
  defaultPrices: Record<string, number>;
  blurb: string;
}

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
    id: "mobile-to-prefill-ext",
    label: "Mobile to Prefill Ext",
    path: "/core-svc/api/v2/exp/validation-service/mobile-to-prefill-two",
    serviceId: "f37ab538-ac7d-40ba-9128-4f9d8b99ab6e",
    input: "mobile",
    defaultPrices: { "1": 6, "2": 3 },
    blurb: "Basic demographics (age, state) from the phone number alone.",
  },
  {
    id: "employment-latest",
    label: "Employment — Latest",
    path: "/core-svc/api/v2/vre/exp/validation-service/employment-latest-premium",
    serviceId: "ac5bb035-420b-4be8-86c1-c4e093c4d980",
    input: "uan",
    defaultPrices: { "1": 5, "2": 1 },
    blurb: "Current employer, date of joining and whether an exit has been marked.",
  },
  {
    id: "employment-history",
    label: "Employment — History",
    path: "/core-svc/api/v2/vre/emp-history/details",
    serviceId: "772b5313-92d4-4e06-9446-254888a219f2",
    input: "uan",
    // This one returns status 3 rather than 2 for "not found".
    defaultPrices: { "1": 5, "2": 1, "3": 1 },
    blurb: "Full employment history across employers, not just the current one.",
  },
];

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
