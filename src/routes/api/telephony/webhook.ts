// Public webhook endpoint for Tata Tele SmartFlo call lifecycle events.
// Tata POSTs to this endpoint when calls complete, are missed, etc.
//
// Route: POST /api/telephony/webhook
// Called by: Tata SmartFlo (external, not authenticated via our app auth)
// This is a Nitro event handler, not an RPC-style createServerFn.

import { defineEventHandler, createError, readBody } from "h3";
import { getTelephonyProvider } from "@/lib/telephony";
import { ingestProviderWebhook } from "@/lib/telephony/server";

export default defineEventHandler(async (event) => {
  // Ensure this is a POST request
  if (event.method !== "POST") {
    throw createError({
      statusCode: 405,
      statusMessage: "Method Not Allowed",
      message: "Webhook endpoint accepts POST only",
    });
  }

  try {
    // Parse JSON body
    const payload = await readBody(event);

    if (!payload) {
      throw new Error("Empty request body");
    }

    // Validate basic structure (Tata webhook should have $uuid)
    if (typeof payload !== "object" || !payload.$uuid) {
      throw createError({
        statusCode: 400,
        statusMessage: "Bad Request",
        message: "Invalid Tata webhook payload: missing $uuid",
      });
    }

    // Parse webhook into normalized CallStatusEvent
    const provider = getTelephonyProvider();
    let status;
    try {
      status = provider.parseStatusWebhook(payload);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw createError({
        statusCode: 400,
        statusMessage: "Bad Request",
        message: `Failed to parse Tata webhook: ${msg}`,
      });
    }

    // Process the event (updates in-memory dialer state, persists logs, etc.)
    await ingestProviderWebhook(status);

    // Return 200 OK so Tata doesn't retry
    return {
      ok: true,
      providerCallId: status.providerCallId,
      status: status.status,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[webhook] Error processing Tata webhook: ${msg}`, error);

    // If it's already an HTTP error, re-throw it
    if (error instanceof Error && error.constructor.name === "H3Error") {
      throw error;
    }

    // Generic server error
    throw createError({
      statusCode: 500,
      statusMessage: "Internal Server Error",
      message: "Failed to process webhook",
    });
  }
});
