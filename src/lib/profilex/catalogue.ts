// The ProfileX (Neokred) services SamvadX is allowed to call, as data rather than code — adding
// a fifth endpoint is one entry here plus a price in the admin rate card, no new code path.
//
// Client-safe on purpose: paths and service-ids are not secrets and the UI needs the labels and
// prices to tell a manager what a click will cost. The actual credentials (`secret-key`,
// `access-key`, `client-user-id`) live only in server env — see profilex-actions.server.ts.
//
// Verified against ProfileX's published Postman collection (docs.profilex.tech) on 2026-08-26.

/** What a service consumes. For a debtor-triggered lookup (runProfilexTrace, the Trace tab on a
 *  debtor profile) nothing here accepts a free-text value from the browser: `mobile` comes from
 *  the debtor's own `phone_primary`, `mobile+name` adds their stored name, and a derived input
 *  (`uan`, `gstin`) is read from an earlier trace on that same debtor. That is what keeps every
 *  lookup rooted in data already in the portfolio.
 *
 *  `din` is the one exception, and it is typed in by hand — no debtor row carries a director's
 *  DIN, and nothing derives one. A service with `input: "din"` MUST also set `manualOnly: true`,
 *  which keeps it off the debtor Trace tab entirely and reachable only from Admin > Insights
 *  (runManualInsight), where an admin is the one supplying the value. */
export type ProfilexInput =
  /** The debtor's own number, sent as `mobile` — or as `phone`, which some endpoints want
   *  instead. Same value either way; only the body key differs. */
  | "mobile"
  | "phone"
  | "mobile+name"
  | "mobile+firstName"
  /** The number plus the whole stored name in one `name` field (the Financial Behaviour
   *  lookups) — not split into firstName/lastName like the two inputs above. */
  | "mobile+fullName"
  | "uan"
  | "gstin"
  | "din"
  /** A CIBIL report (PayPrime). The phone comes from the debtor row; name, PAN, date of birth,
   *  gender, email and address are typed by an admin on the debtor's Insights tab, prefilled
   *  from the bank file. Never runs through runProfilexTrace — see `provider`. */
  | "cibil";

/** How a derived input is obtained: which service supplies it, and how to read it back out of
 *  that service's stored response. Declaring it here rather than branching in the server action
 *  means adding a new chained service is a catalogue entry, not new code. */
export interface DerivedFrom {
  /** The standalone service that produces this value — named to a manager when nothing on
   *  file can supply it yet. */
  label: string;
  /** Every stored trace that can supply the value, tried in order. More than one because a
   *  bundle (Skip Tracing V2) returns the same blocks as the standalone services: a manager who
   *  already paid for the bundle should not have to pay again for Mobile to UAN to unlock
   *  Employment History. */
  sources: { service: string; extract: (data: Record<string, unknown>) => string | null }[];
}

export interface ProfilexService {
  /** Who is called. Absent = ProfileX (Neokred). "payprime" = the CIBIL report from
   *  b2b.payprime.in, which has its own server action (cibil-actions.server.ts), its own
   *  credentials and an IP allow-list on PayPrime's side; runProfilexTrace and
   *  runManualInsight refuse it. Kept in this catalogue so plans, rate cards, spend and usage
   *  reports treat it like every other Insights service. */
  provider?: "payprime";
  /** Stable slug — persisted in `debtor_traces.service_id`, so never rename one in place. */
  id: string;
  label: string;
  /** Path appended to PROFILEX_BASE_URL. */
  path: string;
  /** The per-service `service-id` request header ProfileX routes on. OMIT it for services the
   *  provider's docs call without one (the skip-tracing bundles): sending any service-id to
   *  those — even a well-formed one — returns HTTP 500 "Invalid service url". */
  serviceId?: string;
  input: ProfilexInput;
  /** Required for `uan`/`gstin` inputs; omitted for the ones that start from the phone. */
  derivedFrom?: DerivedFrom;
  /** True for a service whose input (currently only `din`) nothing on a debtor row can ever
   *  supply. Hidden from the debtor Trace tab (trace-panel.tsx filters these out) and refused
   *  server-side by runProfilexTrace even if called directly; reachable only from Admin >
   *  Insights, where an admin types the value in. Still subject to the normal per-company
   *  enabled_services allow-list and rate card. */
  manualOnly?: boolean;
  /** Price in ₹ keyed by the provider's `data.status`. ProfileX bills per service AND per
   *  status: a "not found" (status 2/3) still costs money on most services. Overridable per
   *  client via profilex_settings.rate_card — these are the published list prices. */
  defaultPrices: Record<string, number>;
  blurb: string;
  /** Send the number as `91XXXXXXXXXX` rather than 10 digits — the CRIF report's documented
   *  shape. Only the request body changes; matching and reuse still use the 10-digit number. */
  mobileWithCountryCode?: boolean;
  /** Recently added — shows a small "New" tag beside the label wherever services are listed.
   *  Remove once it has been around a while; it carries no behaviour. */
  isNew?: boolean;
}

const readUan = (d: Record<string, unknown>) => (d?.uan ? String(d.uan) : null);

// `result` is a list of GSTINs for the number; the first is the one to resolve contacts for.
const readGstin = (d: Record<string, unknown>) => {
  const first = (d?.result as { gstin?: string }[] | undefined)?.[0];
  return first?.gstin ? String(first.gstin) : null;
};

/** A sub-block of the Skip Tracing bundle, which nests each standalone service's payload under
 *  its own key (vreMobileToUan, vrePhoneToPrefill, ...) in the same shape. */
const inBundle =
  (key: string, read: (d: Record<string, unknown>) => string | null) =>
  (d: Record<string, unknown>) => {
    const block = d?.[key];
    return block && typeof block === "object" ? read(block as Record<string, unknown>) : null;
  };

export const SKIP_TRACING_SERVICE = "skip-tracing";

const UAN_FROM_MOBILE: DerivedFrom = {
  label: "Mobile to UAN",
  sources: [
    { service: "mobile-to-uan", extract: readUan },
    { service: SKIP_TRACING_SERVICE, extract: inBundle("vreMobileToUan", readUan) },
  ],
};

// No bundle source: the Skip Tracing we use (VRE Skip Tracing) carries no GST block. Only the
// separate "+ GST" variant does — add it here if that is ever the one wired.
const GSTIN_FROM_MOBILE: DerivedFrom = {
  label: "Mobile to GST",
  sources: [{ service: "mobile-to-gst", extract: readGstin }],
};

export const PROFILEX_SERVICES: ProfilexService[] = [
  {
    id: SKIP_TRACING_SERVICE,
    // The console card "VRE Skip Tracing" (₹46), described as "based on mobile and first name".
    // NOT "VRE Skip Tracing V2" (₹15, a smaller bundle), nor the X / + GST / + Locate variants.
    label: "Skip Tracing",
    path: "/core-svc/api/v2/exp/vre-skip-tracing",
    // Deliberately no serviceId — see the field's comment. Verified 2026-09-17: without the
    // header an empty request reaches input validation ("Missing required input fields: mobile,
    // firstName"); the skip-tracing paths reject any service-id as "Invalid service url".
    input: "mobile+firstName",
    // The console lists ₹46 for status 1 only. An unpriced status resolves to the highest known
    // price (see priceFor), so a not-found is recorded at ₹46 until the real figure is known —
    // over-recording rather than under.
    defaultPrices: { "1": 46 },
    blurb:
      "The broadest single lookup: alternate numbers and addresses, emails, PAN and father's " +
      "name, UAN and current employer, UPI IDs and LPG connection. Its UAN also unlocks the " +
      "employment lookups without paying for Mobile to UAN separately.",
  },
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
    id: "get-alternate-phone",
    label: "Alternate Phone Numbers",
    path: "/core-svc/api/v2/vre/exp/get-alternate-phone",
    serviceId: "8b0915a9-213a-4068-87d4-58dc966d62fe",
    input: "phone",
    // Free when nothing is found, so a miss on an unreachable debtor costs nothing.
    defaultPrices: { "1": 6, "2": 0 },
    blurb:
      "Other numbers reachable for this debtor. Free when nothing is found, and anything it " +
      "returns is added to the debtor's alternate numbers for the dialer.",
  },
  {
    id: "get-alternate-address",
    label: "Alternate Addresses",
    path: "/core-svc/api/v2/vre/exp/get-alternate-address",
    serviceId: "3bbb95f9-9119-49b0-b968-e5532e4b0600",
    input: "phone",
    // The console card lists ₹4 for status 1 only; an unpriced status resolves to ₹4.
    defaultPrices: { "1": 4 },
    blurb:
      "Addresses seen for this number, each with a confidence score and when it was last seen.",
  },
  {
    id: "mobile-to-multiple-upi",
    label: "UPI IDs",
    path: "/core-svc/api/v2/vre/exp/upi/v1/mobile-to-multiple-vpa",
    serviceId: "8fd8642b-5d4f-4793-a110-3a7b9ca6c96d",
    input: "mobile",
    defaultPrices: { "1": 1.58, "2": 1.58 },
    blurb:
      "Every UPI ID registered to the number, plus the name they are held under — a cheap way " +
      "to confirm the person is still transacting.",
  },
  {
    id: "mobile-to-lpg-advance",
    label: "LPG Connection",
    // The provider's own path really is spelled "lgp" — not a typo on our side.
    path: "/core-svc/api/v2/exp/v2/mobile-lgp-advance",
    input: "mobile",
    defaultPrices: { "1": 15, "2": 15 },
    blurb:
      "The debtor's gas connection: name, full registered address and consumer number. Charged " +
      "the same whether or not anything is found.",
  },
  {
    id: "mobile-to-esic",
    label: "ESIC Details",
    // The console card "VRE Mobile to esic details". Added 2026-10-19 from ProfileX's Postman
    // collection (VRE folder) — not the non-VRE "Mobile to ESIC details" (/validation-service/).
    path: "/core-svc/api/v2/vre/exp/mobile-to-esic-details",
    serviceId: "e4d84bf0-cfed-4f30-9fe3-1419526de64c",
    input: "mobile",
    defaultPrices: { "1": 9, "2": 9 },
    blurb:
      "The debtor's ESIC (Employee State Insurance) record from their phone number — shows " +
      "whether an employer is paying ESIC for them, which points to salaried work. Charged the " +
      "same whether or not anything is found.",
    isNew: true,
  },
  {
    id: "financial-behaviour",
    label: "Financial Behaviour Analysis",
    // The console card "VRE Financial Behaviour Analysis" (Financial Suite). Added 2026-10-19
    // from the Postman collection's VRE folder; body is { mobile, name }.
    path: "/core-svc/api/v2/vre/exp/financial-behaviour-analysis",
    serviceId: "94dd7927-2c10-4ccf-8817-23c0d70d17b9",
    input: "mobile+fullName",
    defaultPrices: { "1": 11.25, "2": 11.25 },
    blurb:
      "How the debtor handles money, from their phone number and name: their financial " +
      "behaviour across loans and accounts. Charged the same whether or not anything is found.",
    isNew: true,
  },
  {
    id: "financial-behaviour-crif",
    label: "Financial Behaviour — CRIF Report",
    // The console card "Financial Behaviour Analysis [Crif Report]". Added 2026-10-19 from the
    // Postman collection; its example sends the number as "91XXXXXXXXXX" with the full name.
    path: "/core-svc/api/v2/exp/credit-report/v2",
    serviceId: "abcd8882-1424-4e04-9b6f-0aaecafc0aff",
    input: "mobile+fullName",
    mobileWithCountryCode: true,
    // The console lists ₹11.25 for status 1 only; an unpriced status resolves to ₹11.25.
    defaultPrices: { "1": 11.25 },
    blurb:
      "The debtor's credit history from the CRIF bureau, found from their phone number and " +
      "name — loans, repayment record and enquiries, without needing a PAN.",
    isNew: true,
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
  {
    id: "din-to-contact",
    label: "DIN to Contact",
    // Confirmed 2026-09-23 against ProfileX's published Postman collection (see
    // recoveryai-profilex memory for the fetch URL) — path, service-id and body all verified;
    // no not-found example in the collection, and the console pricing card wasn't checked, so
    // treat the price below as unconfirmed (see the comment on defaultPrices).
    path: "/core-svc/api/v2/vre/exp/din-to-contact",
    serviceId: "d6ad42e9-3a72-44b9-9a06-7f869b5104c0",
    input: "din",
    // No debtor field ever holds a company director's DIN, and nothing derives one — this can
    // only run from Admin > Insights, where an admin types the DIN in by hand. See
    // ProfilexInput's and manualOnly's doc comments.
    manualOnly: true,
    // The console card wasn't checked for this one (no ProfileX console access when this was
    // added). Priced alongside GST to Contact as a placeholder — same shape of lookup (an
    // identifier resolved to a contact) — since ProfileX's API docs never carry pricing.
    // Confirm against the console/contract and correct it in Admin > Settings before enabling
    // this for any company; every spend figure in Reports is calculated from the rate card.
    defaultPrices: { "1": 1.42 },
    blurb:
      "A company director's mobile number and email, resolved from their DIN (Director " +
      "Identification Number) — typed in by an admin, not run against a debtor. Useful when a " +
      "business or proprietor loan needs to reach a director directly.",
  },
  {
    id: "cibil-report",
    label: "CIBIL Report",
    provider: "payprime",
    path: "/api/cibil-report",
    input: "cibil",
    // PayPrime's commission plan (b2b.payprime.in/commission-charges, checked 2026-10-10):
    // ₹65 + 18% GST = ₹76.70, deducted from the PayPrime wallet. Only a success is priced; an
    // unpriced outcome resolves to the same ₹76.70 (priceFor fails expensive), since PayPrime
    // does not document whether a failed transaction is charged.
    defaultPrices: { "1": 76.7 },
    blurb:
      "The borrower's full CIBIL credit report: score, loans and cards, repayment history and " +
      "recent enquiries. Needs their PAN (Skip Tracing returns it), date of birth and address. " +
      "Has its own on/off switch per company.",
  },
];

export const CIBIL_SERVICE = "cibil-report";

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

/** What every company could use before per-company plans existed (2026-09-17). Kept in lockstep
 *  with the backfill in migrations/20260917_profilex_enabled_services.sql — it is also what a
 *  deployment still missing that column behaves as, so neither side of the migration changes
 *  what an existing company sees. */
export const LEGACY_SERVICE_IDS: readonly string[] = [
  "mobile-to-uan",
  "employment-latest",
  "employment-history",
  "phone-to-prefill",
  "mobile-to-gst",
  "gst-to-contact",
];

/** Every catalogue id. NOT a default for companies: a company can only call what a superadmin
 *  has put in its `profilex_settings.enabled_services`, so a newly added (and possibly pricier)
 *  service never appears for every tenant at once. This exists for the superadmin's "select all". */
export const ALL_SERVICE_IDS: string[] = PROFILEX_SERVICES.map((s) => s.id);

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

const rupees = (n: number) => (Number.isInteger(n) ? `₹${n}` : `₹${n.toFixed(2)}`);

/**
 * What THIS company pays for a lookup — not the provider's list price.
 *
 * Both halves of that used to be wrong. It read `defaultPrices` while runProfilexTrace charges
 * `priceFor(..., rate_card)`, so a company on a marked-up plan was quoted one number and billed
 * another. And a service priced for "found" only (Skip Tracing, ₹46) fell to `miss = 0` and
 * claimed a miss was free, when priceFor's fail-expensive rule charges the full ₹46. Both
 * numbers now come from priceFor itself, so what is shown is by construction what is charged.
 */
/**
 * The provider statuses a company's rate card should be editable for.
 *
 * Always includes "1" (found) and "2" (not found), even when the provider's console lists only
 * a found price: a miss is still charged, and without a box for it a superadmin cannot record
 * what it actually costs — priceFor would keep falling back to the found price. Any extra
 * status the catalogue knows (employment history returns 3 for a miss) or the company's card
 * already carries is included too, so nothing stored becomes uneditable.
 */
export function priceStatuses(
  service: ProfilexService,
  rateCard?: Record<string, Record<string, number>>,
): string[] {
  return [
    ...new Set([
      "1",
      "2",
      ...Object.keys(service.defaultPrices),
      ...Object.keys(rateCard?.[service.id] ?? {}),
    ]),
  ].sort();
}

/** "found" / "not found", with the provider's status code when more than one means not-found. */
export function statusLabel(status: string, allStatuses: string[]): string {
  if (status === "1") return "found";
  return allStatuses.filter((s) => s !== "1").length > 1 ? `not found (${status})` : "not found";
}

export function priceLine(
  s: ProfilexService,
  rateCard?: Record<string, Record<string, number>>,
): string {
  const hit = priceFor(s, "1", rateCard);
  const missStatuses = Object.keys({ ...s.defaultPrices, ...(rateCard?.[s.id] ?? {}) }).filter(
    (k) => k !== "1",
  );
  // With no not-found status priced, an actual miss takes priceFor's unrecognised-status path,
  // so quote that rather than inventing a free one.
  const miss = missStatuses.length
    ? Math.min(...missStatuses.map((k) => priceFor(s, k, rateCard)))
    : priceFor(s, null, rateCard);
  return miss === 0
    ? `${rupees(hit)} if found, free if not`
    : `${rupees(hit)} if found, ${rupees(miss)} if not`;
}
