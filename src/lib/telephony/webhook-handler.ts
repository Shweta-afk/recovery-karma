// Public HTTP endpoint for provider call-status callbacks (the active telephony provider posts here).
//
// This is mounted directly on the server fetch entry (src/server.ts) rather than as a route
// file: this version of TanStack Start has no stable server-route convention, and a route
// module under src/routes/api/** is not picked up by the generated route tree.
//
// Auth: the provider cannot present our app's session, so it proves itself with a shared secret
// (TELEPHONY_WEBHOOK_SECRET) sent as an `x-webhook-secret` header or a `?secret=` query param.
// With no secret configured the endpoint rejects everything — an open webhook would let anyone on
// the internet forge "connected"/"completed" call events and inject recording URLs.

export const TELEPHONY_WEBHOOK_PATH = "/api/telephony/webhook";

/** Constant-time comparison so response timing can't be used to recover the secret. */
async function secretMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given) return false;
  const { timingSafeEqual, createHash } = await import("node:crypto");
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function handleTelephonyWebhook(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Webhook endpoint accepts POST only" }, 405);
  }

  const expected = process.env.TELEPHONY_WEBHOOK_SECRET?.trim();
  if (!expected) {
    console.error("[webhook] rejected: TELEPHONY_WEBHOOK_SECRET is not set");
    return json({ error: "Webhook is not configured" }, 503);
  }
  const given =
    request.headers.get("x-webhook-secret") ?? new URL(request.url).searchParams.get("secret");
  if (!(await secretMatches(given, expected))) {
    return json({ error: "Unauthorized" }, 401);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Body is not valid JSON" }, 400);
  }

  if (typeof payload !== "object" || payload === null) {
    return json({ error: "Expected a JSON object" }, 400);
  }

  // The raw payload carries debtor phone numbers — never write it to logs.

  try {
    // Imported lazily so the SSR entry doesn't pull the dialer engine in on cold boot.
    const [{ getTelephonyProvider }, { ingestCallStatusEvent }] = await Promise.all([
      import("./index"),
      import("./server"),
    ]);

    const status = getTelephonyProvider().parseStatusWebhook(payload);
    await ingestCallStatusEvent(status);
    console.log(`[webhook] ingested ${status.status}`);
    return json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[webhook] failed to process payload:", msg);
    // 200 on purpose: a parse failure on our side is not something the provider can fix by
    // retrying, and retries would just repeat the same error every few seconds.
    return json({ ok: false, error: msg }, 200);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
