// Pure billing/parsing helpers for the ProfileX integration, kept out of the .server.ts file so
// they can be unit-tested without pulling in createServerFn or the Supabase admin client. These
// decide what a lookup cost and which numbers it surfaced, so they are worth testing directly.

/**
 * Normalise whatever was put in PROFILEX_BASE_URL to the origin the catalogue paths expect.
 *
 * ProfileX hands out its base URL as `https://profilex-api.neokred.tech/core-svc/api/v2/`, but
 * every path in the catalogue is copied verbatim from their Postman collection and already
 * carries the `/core-svc/api/v2` prefix. Concatenating the two yields a doubled prefix and a
 * 404 — and because this is an env var, it would fail silently in production rather than at
 * build time. Accept either form instead of relying on whoever sets the variable getting the
 * split right.
 */
export function normaliseBaseUrl(raw: string | undefined | null): string {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/\/+$/, "");
  if (!trimmed) return "https://profilex-api.neokred.tech";
  return trimmed.replace(/\/core-svc\/api\/v2$/i, "");
}

/** Start of the current calendar month in IST — the billing period the budget cap covers.
 *  Doing this in UTC would roll the budget over 5.5h early and let a month's last evening
 *  spend against the next month's cap. */
/** A decoded ProfileX response body. Untyped by necessity — the shape differs per service. */
export type Row = Record<string, unknown>;

export function istMonthStart(now: Date = new Date()): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const startIst = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1, 0, 0, 0, 0);
  return new Date(startIst - IST_OFFSET_MS);
}

/** ProfileX signals "found" with data.status "1"; "2"/"3" mean no record. At least one endpoint
 *  (Employment Latest) returns a null status alongside a success message, so this normalises to
 *  a string or null and lets pricing decide what an unknown status costs. */
export function readProviderStatus(json: Row | null): string | null {
  const raw = (json?.data as Row | undefined)?.status ?? json?.status;
  if (raw === null || raw === undefined || raw === "") return null;
  return String(raw);
}

export function isHit(status: string | null): boolean {
  return status === "1";
}

/** Indian mobile numbers found anywhere in a response, normalised to bare 10 digits.
 *  Scans generically rather than by known field name so that adding a contact-returning
 *  endpoint to the catalogue later needs no change here. */
export function extractPhones(node: unknown, found = new Set<string>()): Set<string> {
  if (node === null || node === undefined) return found;
  if (Array.isArray(node)) {
    for (const v of node) extractPhones(v, found);
    return found;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      // Numbers belonging to someone OTHER than the debtor must never reach their dialable
      // numbers: LPG Advance returns the gas distributor's landline, and an agent ringing a
      // dealer about somebody's debt is both useless and a third-party disclosure risk. The
      // landline even survives the digit checks — "08023…" normalises to a 10-digit number
      // starting 8, indistinguishable from a mobile.
      const THIRD_PARTY =
        /distributor|dealer|agency|branch|office|helpline|support|customer_care|customercare|employer|establishment/i;
      if (/phone|mobile|contact/i.test(k) && !THIRD_PARTY.test(k)) {
        // A phone-ish key can hold one number or a plain list of them — the skip-tracing bundles
        // return `alternate_phones: ["+918660820296"]`, which the recursion below never sees as
        // phone data because array items carry no key of their own.
        const candidates = Array.isArray(v) ? v : [v];
        for (const c of candidates) {
          if (typeof c !== "string" && typeof c !== "number") continue;
          // Same rule as normalisePhone, so what the writeback adds and what it de-duplicates
          // against the debtor's existing numbers can never disagree. Anything that is not then a
          // 10-digit mobile is an id, a score or a landline we can't dial.
          const ten = normalisePhone(String(c));
          if (/^[6-9]\d{9}$/.test(ten)) found.add(ten);
        }
      }
      if (v && typeof v === "object") extractPhones(v, found);
    }
  }
  return found;
}

export function normalisePhone(raw: string | null | undefined): string {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  // Domestic format with the trunk prefix — the provider returns alternate numbers like
  // "09632065320", which read as 11 digits and were silently dropped from the writeback.
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

/** Every way a 10-digit mobile can sit in `debtors.phone_primary`. Uploads store whatever the
 *  bank's file had, so the same borrower can be "9876543210" in one file and "+919876543210" in
 *  the next — matching on the bare number alone would miss exactly the repeat we want to catch. */
export function phoneVariants(mobile: string): string[] {
  return [mobile, `91${mobile}`, `+91${mobile}`, `0${mobile}`, `+91 ${mobile}`];
}

/** First word of a name, lower-cased. Name-taking services (mobile+name) can answer differently
 *  for two different people on one number, so a reused result must at least agree on this. */
export function firstNameKey(name: string | null | undefined): string {
  return (
    String(name ?? "")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? ""
  );
}

/** A previously paid-for lookup on the same phone + service, from a debtor row in an earlier
 *  upload (`live`) or from the monthly archive (`archive`). */
export interface ReuseCandidate {
  id: string;
  source: "live" | "archive";
  providerStatus: string | null;
  createdAt: string;
  debtorName: string | null;
  httpStatus: number | null;
  response: unknown;
}

/** The newest candidate still inside its freshness window — a found result lives for
 *  `hitTtlHours`, a miss for the shorter `missTtlHours`, the same rule the per-debtor cache uses
 *  so a borrower is treated identically whether or not their row was re-uploaded. */
export function pickReusable(
  candidates: ReuseCandidate[],
  opts: {
    hitTtlHours: number;
    missTtlHours: number;
    now?: number;
    /** Set for name-taking services: only reuse when the first name agrees. */
    sameFirstNameAs?: string | null;
  },
): ReuseCandidate | null {
  const now = opts.now ?? Date.now();
  const wantName = opts.sameFirstNameAs === undefined ? null : firstNameKey(opts.sameFirstNameAs);
  let best: ReuseCandidate | null = null;
  for (const c of candidates) {
    const created = new Date(c.createdAt).getTime();
    if (!Number.isFinite(created)) continue;
    const ttlHours = isHit(c.providerStatus) ? opts.hitTtlHours : opts.missTtlHours;
    if (now - created >= ttlHours * 3_600_000) continue;
    if (wantName !== null && firstNameKey(c.debtorName) !== wantName) continue;
    if (!best || created > new Date(best.createdAt).getTime()) best = c;
  }
  return best;
}
