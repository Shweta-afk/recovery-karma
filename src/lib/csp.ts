// Content-Security-Policy in REPORT-ONLY mode, plus the endpoint that collects violations.
//
// Why report-only first: a CSP that blocks something the app genuinely needs breaks a page for
// every user at once, and the only way to learn what that is used to be "users complain".
// Report-only enforces nothing — the browser just POSTs each would-be violation to
// /api/csp-report, which logs one compact line. Run it through a normal working week (every role,
// Call Queue, Reports, Superadmin), read the logs, then promote the policy to enforcing.
//
// KNOWN GAP BEFORE ENFORCING: script-src allows 'unsafe-inline' because the root layout carries
// an inline theme script and TanStack Start inlines its hydration payload. That makes this policy
// useful for finding every OTHER source (fonts, media, connect, frames) but it does not yet stop
// injected inline scripts. Enforcing for real needs per-request nonces on those inline scripts.

import { enforceRateLimit } from "./rate-limit.server";

export const CSP_REPORT_PATH = "/api/csp-report";

/** Origin of the Supabase project (REST + realtime), so connect-src is exact rather than a
 *  wildcard. Falls back to the hosted wildcard if the env var is missing or malformed. */
function supabaseSources(): string[] {
  const raw = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? "";
  try {
    const u = new URL(raw);
    return [u.origin, `wss://${u.host}`];
  } catch {
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
}

export function buildCspReportOnly(): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'"], // see KNOWN GAP above
    "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    // Call recordings play from whatever host the telephony vendor serves them from.
    "media-src": ["'self'", "blob:", "https:"],
    // wss: is open on purpose while the browser-calling (SIP over WebSocket) vendor is undecided;
    // tighten to the vendor's host once one is chosen.
    "connect-src": ["'self'", ...supabaseSources(), "wss:"],
    "worker-src": ["'self'", "blob:"],
    "frame-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": [
      "'self'",
      "https://*.lovable.dev",
      "https://*.lovable.app",
      "https://*.lovableproject.com",
    ],
    "report-uri": [CSP_REPORT_PATH],
  };
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

const MAX_REPORT_BYTES = 10_000;

/** Accepts both report formats (legacy `application/csp-report` and Reporting API
 *  `application/reports+json`), logs a compact line, and always answers 204. Unauthenticated by
 *  necessity — the browser sends it — so it is size-capped, rate-limited and never stores or
 *  reflects the payload beyond a truncated log line. */
export async function handleCspReport(request: Request): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    enforceRateLimit("csp-report", 300, 60_000);
    const text = await request.text();
    if (text.length > MAX_REPORT_BYTES) return new Response(null, { status: 204 });
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list.slice(0, 5)) {
      const r = ((item as { "csp-report"?: unknown; body?: unknown })?.["csp-report"] ??
        (item as { body?: unknown })?.body ??
        {}) as Record<string, unknown>;
      const pick = (...keys: string[]) =>
        String(keys.map((k) => r[k]).find(Boolean) ?? "").slice(0, 200);
      console.warn(
        `[csp-report] directive=${pick("effective-directive", "effectiveDirective", "violated-directive")}` +
          ` blocked=${pick("blocked-uri", "blockedURL")} page=${pick("document-uri", "documentURL")}`,
      );
    }
  } catch {
    // Malformed body or rate limit hit — nothing useful to do, and a browser will not retry.
  }
  return new Response(null, { status: 204 });
}
