// Error messages a company's users may see. They must never carry database text, vendor names,
// server settings or provider responses — only a short plain sentence and a code like SX-1003.
// The real detail goes to the server log (Railway → Logs, search the code), and what each code
// means is listed in docs/ERROR_CODES.md. That list is kept OUT of this file on purpose: this
// module is bundled into the browser, so anything written here a client could read.
//
// Server:  throw appError("SX-1003", "Could not load your Insights wallet.", error);
// Browser: toast.error(errorText(e, "Could not save"));
//
// scripts/error-codes.test.ts checks every code used is unique and listed in the doc.

const CODE_RE = /\(SX-\d{4}\)\s*$/;

/** Shown when an error's own text is not safe to show. */
export const GENERIC_CODE = "SX-9000";

/** Server side: log the real cause with its code, return an error safe to show. */
export function appError(code: string, message: string, detail?: unknown): Error {
  if (detail !== undefined) {
    console.error(`[${code}] ${message}`, describe(detail));
  }
  return new Error(`${message.trim()} (${code})`);
}

function describe(detail: unknown): string {
  if (detail instanceof Error) return detail.message;
  if (detail && typeof detail === "object") {
    try {
      return JSON.stringify(detail);
    } catch {
      return String(detail);
    }
  }
  return String(detail);
}

// Text that only ever comes from the database, a vendor or the server's set-up — never from a
// message we wrote for users. Anything matching is replaced before it reaches the screen.
const LEAKY = [
  /\b(profilex|neokred|payprime|exotel|skycrm|kookoo|ozonetel|groq|gemini|whisper|resend|railway|supabase|postgres|postgrest|lovable)\b/i,
  /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/, // env var names, e.g. PROFILEX_SECRET_KEY
  /\b[a-z]+_[a-z_]+\b/, // snake_case identifiers: tables, columns, functions
  /\b(PGRST\d+|\d{5})\b/, // PostgREST / Postgres error codes
  /\b(violates|row-level|policy|relation|column|constraint|duplicate key|syntax error|permission denied|schema cache|function|jwt|migration|\.sql|stack|undefined|null value|ECONN|ETIMEDOUT|fetch failed|failed to fetch|networkerror)\b/i,
  /\bHTTP\s*\d{3}\b/i,
  /https?:\/\//i,
  /[{}<>]/,
];

function isLeaky(message: string): boolean {
  return LEAKY.some((re) => re.test(message));
}

function rawMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e)
    return String((e as { message: unknown }).message);
  return "";
}

// A Postgres/PostgREST error object (has code + details/hint) is never shown as-is.
function isDatabaseError(e: unknown): boolean {
  return !!e && typeof e === "object" && "code" in e && ("details" in e || "hint" in e);
}

/**
 * Browser side: what to show for a caught error. Our own coded messages and plain validation
 * sentences pass through; database/vendor/server text becomes `fallback (SX-9000)` and the
 * original is kept in the browser console for whoever is debugging.
 */
export function errorText(e: unknown, fallback: string): string {
  const message = rawMessage(e).trim();
  if (message && CODE_RE.test(message)) return message;
  if (message && !isDatabaseError(e) && !isLeaky(message) && message.length <= 200) return message;
  if (message) console.error(`[${GENERIC_CODE}]`, e);
  return `${fallback.replace(/[.\s]+$/, "")}. Please try again (${GENERIC_CODE}).`;
}
