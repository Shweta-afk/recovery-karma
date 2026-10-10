// CIBIL report through PayPrime (b2b.payprime.in) — the pure half: form shape, prefill from what
// the bank file and earlier lookups already hold, validation, the request body and reading the
// response. No Supabase, no React, so the server action, the panel and the tests share it
// (scripts/cibil-payprime.test.ts). The server half is src/lib/cibil-actions.server.ts.
//
// API spec: b2b.payprime.in/cibilDocs (checked 2026-10-10). POST /api/cibil-report, JSON body
// with the API token inside it. PayPrime only accepts calls from the IPs/domain registered under
// Developer Setting → Api Token, so it works only from a server whose outbound IP is listed.

export interface CibilForm {
  firstName: string;
  lastName: string;
  /** PAN — sent as id_number with id_type "TaxId". */
  pan: string;
  /** YYYY-MM-DD */
  dob: string;
  gender: "Male" | "Female" | "";
  email: string;
  streetAddress: string;
  city: string;
  postalCode: string;
  /** CIBIL state code, two digits (see CIBIL_STATES). */
  region: string;
  addressType: string;
}

/** CIBIL's state codes. The docs' example (PIN 516401, Andhra Pradesh) sends "28", which
 *  matches this list. */
export const CIBIL_STATES: [code: string, name: string][] = [
  ["01", "Jammu & Kashmir"],
  ["02", "Himachal Pradesh"],
  ["03", "Punjab"],
  ["04", "Chandigarh"],
  ["05", "Uttarakhand"],
  ["06", "Haryana"],
  ["07", "Delhi"],
  ["08", "Rajasthan"],
  ["09", "Uttar Pradesh"],
  ["10", "Bihar"],
  ["11", "Sikkim"],
  ["12", "Arunachal Pradesh"],
  ["13", "Nagaland"],
  ["14", "Manipur"],
  ["15", "Mizoram"],
  ["16", "Tripura"],
  ["17", "Meghalaya"],
  ["18", "Assam"],
  ["19", "West Bengal"],
  ["20", "Jharkhand"],
  ["21", "Odisha"],
  ["22", "Chhattisgarh"],
  ["23", "Madhya Pradesh"],
  ["24", "Gujarat"],
  ["25", "Daman & Diu"],
  ["26", "Dadra & Nagar Haveli"],
  ["27", "Maharashtra"],
  ["28", "Andhra Pradesh"],
  ["29", "Karnataka"],
  ["30", "Goa"],
  ["31", "Lakshadweep"],
  ["32", "Kerala"],
  ["33", "Tamil Nadu"],
  ["34", "Puducherry"],
  ["35", "Andaman & Nicobar"],
  ["36", "Telangana"],
  ["38", "Ladakh"],
];

/** CIBIL address categories. */
export const CIBIL_ADDRESS_TYPES: [code: string, name: string][] = [
  ["1", "Permanent"],
  ["2", "Residence"],
  ["3", "Office"],
  ["4", "Not categorised"],
];

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const STATE_ALIASES: Record<string, string> = {
  jk: "01",
  jammukashmir: "01",
  uttaranchal: "05",
  newdelhi: "07",
  nctofdelhi: "07",
  up: "09",
  orissa: "21",
  mp: "23",
  pondicherry: "34",
  tamilnadu: "33",
  wb: "19",
  ap: "28",
  ts: "36",
};

/** A bank file's state ("Andhra Pradesh", "MAHARASHTRA", "TN") → CIBIL code, or "". */
export function stateCodeFor(raw: string | null | undefined): string {
  const k = squash(String(raw ?? ""));
  if (!k) return "";
  if (STATE_ALIASES[k]) return STATE_ALIASES[k];
  const hit = CIBIL_STATES.find(([, name]) => squash(name) === k);
  return hit ? hit[0] : "";
}

const PAN_RE = /^[A-Z]{5}\d{4}[A-Z]$/;
const PIN_RE = /^[1-9]\d{5}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 16-07-1978, 16/07/1978, 1978-07-16 → 1978-07-16; anything else → "". */
export function isoDob(raw: string | null | undefined): string {
  const m = String(raw ?? "")
    .trim()
    .match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/);
  if (!m) return "";
  const [a, b, c] = [m[1], m[2], m[3]];
  const [y, mo, d] = a.length === 4 ? [a, b, c] : [c, b, a];
  if (y.length !== 4) return "";
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function genderOf(raw: string | null | undefined): CibilForm["gender"] {
  const g = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (g === "m" || g === "male") return "Male";
  if (g === "f" || g === "female") return "Female";
  return "";
}

/** First value in the bank file's columns whose name matches `key`. */
function pick(extra: Record<string, unknown>, key: RegExp): string {
  for (const [k, v] of Object.entries(extra)) {
    if (key.test(k) && v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  }
  return "";
}

export interface PrefillSource {
  name: string;
  email: string | null;
  /** The bank file's columns for this debtor (debtors.extra). */
  extra: Record<string, unknown>;
  /** What earlier Insights lookups found on this debtor (buildLoanLookupData's row). */
  lookup?: { pan?: string; dob?: string; gender?: string; emails?: string[] } | null;
}

/** Everything already on file, so the admin types only what is genuinely missing. The bank file
 *  wins over a lookup where both exist: it is what the lender holds for this loan. */
export function buildPrefill(src: PrefillSource): CibilForm {
  const parts = src.name.trim().split(/\s+/).filter(Boolean);
  const x = src.extra ?? {};
  const pan = (pick(x, /^pan(_?(no|number|card))?$/i) || src.lookup?.pan || "").toUpperCase();
  const pin = pick(x, /pin_?code|^pin$|postal|zip/i).replace(/\D/g, "");
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
    pan: PAN_RE.test(pan) ? pan : "",
    dob: isoDob(pick(x, /^(dob|date_?of_?birth|birth_?date)$/i)) || isoDob(src.lookup?.dob),
    gender: genderOf(pick(x, /^(gender|sex)$/i)) || genderOf(src.lookup?.gender),
    email: (src.email ?? "").trim() || pick(x, /e_?mail/i) || src.lookup?.emails?.[0] || "",
    streetAddress: pick(x, /^(address|address_?1|address_?line_?1|residence_?address|addr)$/i),
    city: pick(x, /^(city|district|town)$/i),
    postalCode: /^\d{6}$/.test(pin) ? pin : "",
    region: stateCodeFor(pick(x, /^state$/i)),
    addressType: "1",
  };
}

/** What is wrong with the form, field by field. Empty = ready to send. */
export function validateCibilForm(f: CibilForm): Partial<Record<keyof CibilForm, string>> {
  const e: Partial<Record<keyof CibilForm, string>> = {};
  if (!f.firstName.trim()) e.firstName = "Required";
  if (!f.lastName.trim()) e.lastName = "Required — CIBIL needs a surname";
  if (!PAN_RE.test(f.pan.trim().toUpperCase())) e.pan = "10 characters, e.g. ABCDE1234F";
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(f.dob) ? new Date(`${f.dob}T00:00:00Z`) : null;
  if (!dob || isNaN(dob.getTime()) || dob.getUTCFullYear() < 1900 || dob > new Date()) {
    e.dob = "Date of birth, YYYY-MM-DD";
  }
  if (f.gender !== "Male" && f.gender !== "Female") e.gender = "Required";
  if (!EMAIL_RE.test(f.email.trim())) e.email = "A valid email";
  if (f.streetAddress.trim().length < 5) e.streetAddress = "Full residential address";
  if (!f.city.trim()) e.city = "Required";
  if (!PIN_RE.test(f.postalCode.trim())) e.postalCode = "6-digit PIN code";
  if (!CIBIL_STATES.some(([c]) => c === f.region)) e.region = "Pick the state";
  if (!CIBIL_ADDRESS_TYPES.some(([c]) => c === f.addressType)) e.addressType = "Required";
  return e;
}

/** PayPrime's request body, WITHOUT the token (the server adds it, and it is never stored).
 *  The two consent fields are fixed: a company only reaches this after a superadmin has
 *  recorded its consent agreement (profilex_settings.cibil_consent_at). */
export function cibilRequestBody(f: CibilForm, phone: string): Record<string, unknown> {
  return {
    first_name: f.firstName.trim(),
    last_name: f.lastName.trim(),
    id_type: "TaxId",
    id_number: f.pan.trim().toUpperCase(),
    street_address: f.streetAddress.trim(),
    city: f.city.trim(),
    postal_code: Number(f.postalCode.trim()),
    region: f.region,
    address_type: Number(f.addressType),
    email: f.email.trim(),
    phone: Number(phone),
    dob: f.dob,
    gender: f.gender,
    legal_copy_status: "Accept",
    user_consent_data_share: true,
  };
}

type Json = Record<string, unknown>;

/** PAYPRIME_API_TOKEN may hold several tokens, comma-separated. PayPrime issues one token per
 *  allow-listed IP, and Railway sends outbound traffic from any of the service's three static
 *  IPs, so the token that matches a given call's IP isn't knowable in advance. */
export function parseTokens(raw: string | undefined): string[] {
  return [
    ...new Set(
      String(raw ?? "")
        .split(/[,\s]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

/** PayPrime's "Invalid Api token" answer — rejected before any transaction, so nothing was
 *  charged and the next token can be tried safely. Anything carrying a txn_id is never this. */
export function isInvalidToken(json: Json | null): boolean {
  if (!json || json.txn_id) return false;
  const text = `${json.statuscode ?? ""} ${json.status ?? ""} ${json.message ?? ""}`;
  return /invalid\s*api\s*token/i.test(text);
}

export interface CibilOutcome {
  /** "1" = report generated; "2" = PayPrime answered with a transaction but no report; null =
   *  rejected before any transaction (bad token, bad parameters). */
  status: "1" | "2" | null;
  /** Whether PayPrime is likely to have charged the wallet. Any response carrying a txn_id is
   *  treated as charged: PayPrime does not document whether a failed transaction is refunded,
   *  and under-recording spend is the failure that matters (same rule as priceFor). */
  billable: boolean;
  txnId: string | null;
  htmlUrl: string | null;
  score: number | null;
  message: string;
}

/** The first plausible credit score anywhere in the response (CIBIL scores run 300–900; -1 and
 *  0–10 mean "no history"/NH and are reported as null). Searched by key name because PayPrime
 *  only documents the envelope, not the cibilData shape. */
export function findScore(node: unknown, depth = 0): number | null {
  if (!node || typeof node !== "object" || depth > 12) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const s = findScore(v, depth + 1);
      if (s !== null) return s;
    }
    return null;
  }
  const entries = Object.entries(node as Json);
  for (const [k, v] of entries) {
    if (/score$/i.test(k) && !/name|type|version|factor|reason/i.test(k)) {
      const n = Number(typeof v === "object" && v ? ((v as Json).value ?? (v as Json).score) : v);
      if (Number.isFinite(n) && n >= 300 && n <= 900) return Math.round(n);
    }
  }
  for (const [, v] of entries) {
    const s = findScore(v, depth + 1);
    if (s !== null) return s;
  }
  return null;
}

export function readCibilOutcome(httpStatus: number, json: Json | null): CibilOutcome {
  const txnId = json?.txn_id ? String(json.txn_id) : null;
  const inner = ((json?.data as Json | undefined)?.data ?? json?.data) as Json | undefined;
  const htmlUrl = typeof inner?.htmlUrl === "string" ? inner.htmlUrl : null;
  const ok =
    httpStatus === 200 &&
    json?.status === true &&
    String(json?.txn_status ?? "").toLowerCase() === "success";
  const message =
    (typeof json?.message === "string" && json.message) ||
    (typeof json?.status === "string" && json.status) ||
    `HTTP ${httpStatus}`;
  return {
    status: ok ? "1" : txnId ? "2" : null,
    billable: ok || !!txnId,
    txnId,
    htmlUrl,
    score: ok ? findScore(inner?.cibilData ?? inner) : null,
    message,
  };
}
