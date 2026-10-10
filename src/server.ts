import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { CSP_REPORT_PATH, buildCspReportOnly, handleCspReport } from "./lib/csp";
import { TELEPHONY_WEBHOOK_PATH, handleTelephonyWebhook } from "./lib/telephony/webhook-handler";
import { ARCHIVE_CRON_PATH, handleArchiveCron } from "./lib/archive-cron.server";
import { APP_PING_BODY, APP_PING_PATH } from "./lib/company-address";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!body.includes('"unhandled":true') || !body.includes('"message":"HTTPError"')) {
    return response;
  }

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// Safe-by-default response headers. Deliberately NOT a full Content-Security-Policy: the app has
// an inline theme script and talks to Supabase/fonts, so a strict script-src needs a nonce
// pipeline and a report-only soak first. What IS here cannot break a page:
//  - frame-ancestors: no clickjacking (self + Lovable's preview hosts, since the project is still
//    connected to Lovable and previews embed it)
//  - HSTS, nosniff, referrer and permissions policies (microphone stays allowed for browser calling)
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "frame-ancestors 'self' https://*.lovable.dev https://*.lovable.app https://*.lovableproject.com",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), geolocation=(), payment=(), microphone=(self)",
};

function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  // Report-only: observes, never blocks. See src/lib/csp.ts before promoting it to enforcing.
  headers.set("Content-Security-Policy-Report-Only", buildCspReportOnly());
  // A new Response, not a mutation: responses coming out of the framework can have immutable headers.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    return withSecurityHeaders(await handleRequest(request, env, ctx));
  },
};

async function handleRequest(request: Request, env: unknown, ctx: unknown): Promise<Response> {
  try {
    if (new URL(request.url).pathname === CSP_REPORT_PATH) return await handleCspReport(request);
    // Provider status callbacks are plain HTTP from outside the app, not app routes.
    if (new URL(request.url).pathname === TELEPHONY_WEBHOOK_PATH) {
      return await handleTelephonyWebhook(request);
    }
    // The daily archive schedule (pg_cron + pg_net) — see src/lib/archive-cron.server.ts.
    if (new URL(request.url).pathname === ARCHIVE_CRON_PATH) {
      return await handleArchiveCron(request);
    }
    // Proves an address really reaches this app — checked before a company is given a
    // subdomain (see company-address.ts). Fixed text only; says nothing about anyone.
    if (new URL(request.url).pathname === APP_PING_PATH) {
      return new Response(APP_PING_BODY, {
        headers: { "content-type": "text/plain", "cache-control": "no-store" },
      });
    }
    const handler = await getServerEntry();
    const response = await handler.fetch(request, env, ctx);
    return await normalizeCatastrophicSsrResponse(response);
  } catch (error) {
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
}
