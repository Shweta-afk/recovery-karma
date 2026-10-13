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

/** Indian PIN code → CIBIL state code by its first three digits, so the State box fills itself
 *  from the PIN. Prefixes shared by two states/UTs (e.g. 160 Chandigarh/Mohali, 605 Puducherry/
 *  Tamil Nadu, 244/247/262 UP/Uttarakhand) are left out — those the admin picks by hand. */
const PIN_STATE_RANGES: [from: number, to: number, code: string][] = [
  [110, 110, "07"],
  [121, 133, "06"],
  [135, 136, "06"],
  [140, 159, "03"],
  [171, 177, "02"],
  [180, 193, "01"],
  [194, 194, "38"],
  [201, 243, "09"],
  [245, 245, "09"],
  [246, 246, "05"],
  [248, 249, "05"],
  [250, 261, "09"],
  [263, 263, "05"],
  [270, 285, "09"],
  [301, 345, "08"],
  [360, 395, "24"],
  [400, 402, "27"],
  [403, 403, "30"],
  [404, 445, "27"],
  [450, 488, "23"],
  [490, 497, "22"],
  [500, 509, "36"],
  [515, 535, "28"],
  [560, 591, "29"],
  [600, 604, "33"],
  [606, 608, "33"],
  [610, 643, "33"],
  [670, 681, "32"],
  [683, 695, "32"],
  [700, 736, "19"],
  [737, 737, "11"],
  [738, 743, "19"],
  [744, 744, "35"],
  [745, 749, "19"],
  [751, 770, "21"],
  [781, 788, "18"],
  [790, 792, "12"],
  [793, 794, "17"],
  [795, 795, "14"],
  [796, 796, "15"],
  [797, 798, "13"],
  [799, 799, "16"],
  [800, 813, "10"],
  [814, 816, "20"],
  [817, 821, "10"],
  [822, 822, "20"],
  [823, 824, "10"],
  [825, 835, "20"],
  [841, 855, "10"],
];

/** "400072" → "27" (Maharashtra); "" when the PIN is incomplete or its prefix is shared. */
export function stateForPin(pin: string | null | undefined): string {
  const p = String(pin ?? "").trim();
  if (!/^[1-9]\d{5}$/.test(p)) return "";
  const n = Number(p.slice(0, 3));
  return PIN_STATE_RANGES.find(([from, to]) => n >= from && n <= to)?.[2] ?? "";
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
    region: stateCodeFor(pick(x, /^state$/i)) || stateForPin(/^\d{6}$/.test(pin) ? pin : ""),
    addressType: "1",
  };
}

/** The fields PayPrime needs. Its docs mark every field required; the user's call (2026-10-11)
 *  was to require only name, PAN and DOB and send the rest only when filled. But PayPrime itself
 *  rejects a request without an email ("The email field is required.") or a state ("The region
 *  field is required.") — seen live 2026-10-10, after that change — so those two are required
 *  here too. Such rejections carry no transaction and are not charged. Mobile is required too,
 *  checked separately (it comes from the borrower row or the manual form's own field). */
export const CIBIL_REQUIRED: (keyof CibilForm)[] = ["firstName", "pan", "dob", "email", "region"];

/** What is wrong with the form, field by field. Empty = ready to send. Optional fields are only
 *  checked when filled in. */
export function validateCibilForm(f: CibilForm): Partial<Record<keyof CibilForm, string>> {
  const e: Partial<Record<keyof CibilForm, string>> = {};
  if (!f.firstName.trim()) e.firstName = "Required";
  if (!PAN_RE.test(f.pan.trim().toUpperCase())) e.pan = "10 characters, e.g. ABCDE1234F";
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(f.dob) ? new Date(`${f.dob}T00:00:00Z`) : null;
  if (!dob || isNaN(dob.getTime()) || dob.getUTCFullYear() < 1900 || dob > new Date()) {
    e.dob = "Date of birth, YYYY-MM-DD";
  }
  if (f.gender && f.gender !== "Male" && f.gender !== "Female") e.gender = "Male or Female";
  if (!EMAIL_RE.test(f.email.trim())) e.email = f.email.trim() ? "A valid email" : "Required";
  if (f.postalCode.trim() && !PIN_RE.test(f.postalCode.trim())) e.postalCode = "6-digit PIN code";
  if (!CIBIL_STATES.some(([c]) => c === f.region)) e.region = "Pick the state";
  return e;
}

/** PayPrime's request body, WITHOUT the token (the server adds it, and it is never stored).
 *  Optional fields left blank are left out rather than sent empty. The two consent fields are
 *  fixed: a company only reaches this with its CIBIL switch on, which records its consent
 *  agreement (profilex_settings.cibil_consent_at). */
export function cibilRequestBody(f: CibilForm, phone: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    first_name: f.firstName.trim(),
    id_type: "TaxId",
    id_number: f.pan.trim().toUpperCase(),
    phone: Number(phone),
    dob: f.dob,
  };
  const opt = (key: string, value: unknown) => {
    if (value !== "" && value !== undefined && value !== null) body[key] = value;
  };
  opt("last_name", f.lastName.trim());
  opt("gender", f.gender);
  opt("email", f.email.trim());
  opt("street_address", f.streetAddress.trim());
  opt("city", f.city.trim());
  opt("postal_code", f.postalCode.trim() ? Number(f.postalCode.trim()) : "");
  opt("region", f.region);
  // Address type describes an address, so it goes only with one.
  if (f.streetAddress.trim()) opt("address_type", Number(f.addressType) || 1);
  body.legal_copy_status = "Accept";
  body.user_consent_data_share = true;
  return body;
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
  // PayPrime's top-level message is generic ("Generate Cibil Report Failed"); the reason — e.g.
  // "No Record Found" when the details match nobody at the bureau — is one level down.
  const inner2 = json?.data as Json | undefined;
  const reason = typeof inner2?.message === "string" ? inner2.message : "";
  const top =
    (typeof json?.message === "string" && json.message) ||
    (typeof json?.status === "string" && json.status) ||
    `HTTP ${httpStatus}`;
  const message = reason && reason !== top ? `${top}: ${reason}` : top;
  return {
    status: ok ? "1" : txnId ? "2" : null,
    billable: ok || !!txnId,
    txnId,
    htmlUrl,
    score: ok ? findScore(inner?.cibilData ?? inner) : null,
    message,
  };
}

// ── Downloadable report ─────────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

/** Whether a page fetched from PayPrime's htmlUrl is worth saving: real content, not an empty
 *  shell that only renders with the site's own scripts, nor a login/error page. */
export function isUsableReportHtml(html: string | null | undefined): boolean {
  if (!html || !/<html|<body|<table|<div/i.test(html)) return false;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (
    text.length >= 400 && !/sign in|log in|session expired|access denied/i.test(text.slice(0, 600))
  );
}

/** Point a saved page's relative links (styles, images) back at its own site. */
export function withBaseHref(html: string, url: string): string {
  let origin = "";
  try {
    origin = new URL(url).origin + "/";
  } catch {
    return html;
  }
  if (/<base\s/i.test(html)) return html;
  return /<head[^>]*>/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1><base href="${esc(origin)}">`)
    : `<base href="${esc(origin)}">${html}`;
}

/** A self-contained report built from the structured data, for when no page could be saved. */
export function buildReportHtml(r: {
  subject: string;
  score: number | null;
  createdAt: string;
  txnId: string | null;
  htmlUrl: string | null;
  fields: { label: string; value: string }[];
}): string {
  const rows = r.fields
    .map((f) => `<tr><th>${esc(f.label)}</th><td>${esc(f.value)}</td></tr>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>CIBIL report — ${esc(r.subject)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:32px;color:#111}h1{font-size:20px;margin:0 0 4px}
.meta{color:#555;margin-bottom:20px}.score{font-size:40px;font-weight:700;margin:8px 0 20px}
table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}
th{width:40%;color:#444;font-weight:500}@media print{body{margin:12mm}}</style></head><body>
<h1>CIBIL report</h1><div class="meta">${esc(r.subject)} · pulled ${esc(new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }))}${r.txnId ? ` · ${esc(r.txnId)}` : ""}</div>
<div>CIBIL score</div><div class="score">${r.score ?? "—"}</div>
${r.htmlUrl ? `<p>Full report online: <a href="${esc(r.htmlUrl)}">${esc(r.htmlUrl)}</a></p>` : ""}
${rows ? `<table>${rows}</table>` : "<p>No structured fields were returned.</p>"}
</body></html>`;
}

/** "CIBIL-Ravi-Kumar-2026-10-11.html" */
export function reportFileName(subject: string, createdAt: string): string {
  const who =
    subject
      .split("·")[0]
      .trim()
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "report";
  const day = new Date(createdAt).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  return `CIBIL-${who}-${day}.html`;
}
