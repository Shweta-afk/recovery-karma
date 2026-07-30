// Public HTTP endpoint for provider call-status callbacks (Tata SmartFlo posts here).
//
// This is mounted directly on the server fetch entry (src/server.ts) rather than as a route
// file: this version of TanStack Start has no stable server-route convention, and a route
// module under src/routes/api/** is not picked up by the generated route tree.
//
// Auth note: the provider cannot present our app's session, so this endpoint is unauthenticated
// by necessity. It only accepts a status event and moves in-memory call state — it never
// reads or writes user data based on the payload.

export const TELEPHONY_WEBHOOK_PATH = "/api/telephony/webhook";

export async function handleTelephonyWebhook(request: Request): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Webhook endpoint accepts POST only" }, 405);
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

  console.log("[webhook] provider payload:", JSON.stringify(payload));

  try {
    // Imported lazily so the SSR entry doesn't pull the dialer engine in on cold boot.
    const [{ getTelephonyProvider }, { ingestCallStatusEvent }] = await Promise.all([
      import("./index"),
      import("./server"),
    ]);

    const status = getTelephonyProvider().parseStatusWebhook(payload);
    await ingestCallStatusEvent(status);
    console.log(
      `[webhook] ingested ${status.status} for ${status.providerCallId}` +
        (status.customIdentifier ? ` (custom_identifier=${status.customIdentifier})` : ""),
    );
    return json({ ok: true, providerCallId: status.providerCallId, status: status.status });
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
