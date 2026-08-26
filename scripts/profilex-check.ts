#!/usr/bin/env bun
/**
 * Verify ProfileX configuration — locally, or against a deployed environment.
 *
 * WHY THIS EXISTS: Railway's variables have silently drifted from .env.local before and broke
 * production for over a week (TELEPHONY_PROVIDER stayed "tata" after Tata was removed). ProfileX
 * fails the same quiet way: with no credentials the Trace tab just errors, and nobody notices
 * until a manager tries to use it.
 *
 *   bun run scripts/profilex-check.ts          # config only — free, no API call
 *   bun run scripts/profilex-check.ts --live   # also probe the API — SEE COST WARNING BELOW
 *
 * The --live probe calls Mobile to UAN, deliberately the cheapest service: ₹0 when it finds
 * nothing, ₹3 if it does. There is no free ping endpoint — ProfileX bills on HTTP 200 whether
 * or not a record was found, so ANY successful call to any other service costs money.
 */
import { PROFILEX_SERVICES, getService } from "../src/lib/profilex/catalogue";
import { normaliseBaseUrl } from "../src/lib/profilex/billing";

const LIVE = process.argv.includes("--live");
const REQUIRED = ["PROFILEX_CLIENT_USER_ID", "PROFILEX_SECRET_KEY", "PROFILEX_ACCESS_KEY"] as const;

// A number that is well-formed but will not resolve, so a live probe stays on the ₹0 path.
const PROBE_MOBILE = "9999999999";

let failed = false;
const fail = (msg: string) => {
  console.error(`  ✗ ${msg}`);
  failed = true;
};

console.log("ProfileX configuration\n");

const baseUrl = normaliseBaseUrl(process.env.PROFILEX_BASE_URL);
const rawBase = process.env.PROFILEX_BASE_URL;
console.log(`  base URL: ${baseUrl}${rawBase ? "" : "  (default)"}`);
if (rawBase && normaliseBaseUrl(rawBase) !== rawBase.replace(/\/+$/, "")) {
  console.log(
    `            (normalised from ${rawBase} — catalogue paths already include /core-svc/api/v2)`,
  );
}

for (const key of REQUIRED) {
  const v = process.env[key];
  if (!v) {
    fail(`${key} is not set`);
    continue;
  }
  // Every credential ProfileX issues is a UUID; a truncated paste is the likely mistake here.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
  console.log(
    `  ✓ ${key} set (${v.length} chars)${uuid ? "" : "  ⚠ not a UUID — check for a truncated paste"}`,
  );
}

// A VITE_-prefixed copy would be compiled into the browser bundle and leak the credentials.
for (const key of REQUIRED) {
  if (process.env[`VITE_${key}`])
    fail(`VITE_${key} is set — remove it, that leaks the secret to the browser`);
}

console.log(`\n  ${PROFILEX_SERVICES.length} services in the catalogue:`);
for (const s of PROFILEX_SERVICES) {
  const prices = Object.entries(s.defaultPrices)
    .map(([st, p]) => `status ${st}: ₹${p}`)
    .join(", ");
  console.log(`    ${s.id.padEnd(22)} ${s.input.padEnd(7)} ${prices}`);
}

if (LIVE && !failed) {
  const service = getService("mobile-to-uan")!;
  console.log(`\n  Probing ${service.label} with ${PROBE_MOBILE} (₹0 if not found, ₹3 if found)…`);
  const res = await fetch(`${baseUrl}${service.path}`, {
    method: "POST",
    headers: {
      "client-user-id": process.env.PROFILEX_CLIENT_USER_ID!,
      "secret-key": process.env.PROFILEX_SECRET_KEY!,
      "access-key": process.env.PROFILEX_ACCESS_KEY!,
      "service-id": service.serviceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ mobile: PROBE_MOBILE }),
  });
  const text = await res.text();
  const status = (() => {
    try {
      return JSON.parse(text)?.data?.status ?? null;
    } catch {
      return null;
    }
  })();

  console.log(`    HTTP ${res.status}, provider status ${JSON.stringify(status)}`);
  console.log(
    `    rate limit: ${res.headers.get("x-ratelimit-remaining") ?? "?"} of ${res.headers.get("x-ratelimit-limit") ?? "?"} remaining`,
  );
  if (res.status === 200) console.log("  ✓ credentials accepted");
  else if (res.status === 401 || res.status === 403)
    fail(`credentials rejected — ${text.slice(0, 200)}`);
  else fail(`unexpected HTTP ${res.status} — ${text.slice(0, 200)}`);
} else if (!LIVE) {
  console.log("\n  (config only — pass --live to probe the API)");
}

console.log(
  failed
    ? "\n✗ ProfileX is not correctly configured\n"
    : "\n✓ ProfileX configuration looks right\n",
);
process.exit(failed ? 1 : 0);
