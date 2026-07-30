// Server actions for making calls and logging outcomes via Smart Flo.
// Uses TanStack Server Functions (RPC) — callable from client with proper RLS.

import { createServerFn } from "@tanstack/react-start";
import { startCall as startCallTelephony, hangupCall as hangupCallTelephony } from "@/lib/telephony/server";
import { saveCallLog } from "@/lib/disposition-store";
import type { CallLogOutcome } from "@/lib/fetch-debtors";

// ─── Make a call via Smart Flo ─────────────────────────────────────────────────
// Uses the exact same pattern as telephony/server.ts startCall

export const makeCall = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      debtorId: string;
      debtorNumber: string;
      agentEmail: string;
      agentNumber: string;
      aiScore?: number;
    }) => d,
  )
  .handler(async ({ data }) => {
    // Start the call via the telephony provider (Smart Flo or simulator)
    const { providerCallId } = await startCallTelephony({
      callLogId: crypto.randomUUID(),
      agentNumber: data.agentNumber,
      debtorNumber: data.debtorNumber,
      aiScore: data.aiScore,
    });

    return {
      ok: true,
      callLogId: crypto.randomUUID(),
      providerCallId,
      message: `Call initiated to ${data.debtorNumber}`,
    };
  });

// ─── Hang up a call ───────────────────────────────────────────────────────────

export const endCall = createServerFn({ method: "POST" })
  .inputValidator((d: { providerCallId: string }) => d)
  .handler(async ({ data }) => {
    try {
      await hangupCallTelephony({
        providerCallId: data.providerCallId,
      });
      return { ok: true, message: "Call ended" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to end call: ${msg}`);
    }
  });

// ─── Log call outcome ──────────────────────────────────────────────────────────

export const logCallOutcome = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      debtorId: string;
      agentEmail: string;
      outcome: CallLogOutcome;
      durationSeconds?: number;
      promiseAmount?: number;
      promiseDate?: string;
      notes?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    try {
      // Combine notes with promise details if applicable
      let notes = data.notes ?? "";
      if (data.outcome === "promised" && data.promiseAmount) {
        notes += `\nPromised: ₹${data.promiseAmount}`;
        if (data.promiseDate) {
          notes += ` by ${data.promiseDate}`;
        }
      }

      await saveCallLog({
        debtorId: data.debtorId,
        agentEmail: data.agentEmail,
        callType: "human",
        outcome: data.outcome,
        durationSeconds: data.durationSeconds,
        notes: notes.trim(),
      });

      return {
        ok: true,
        message: `Call outcome logged: ${data.outcome}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to log call outcome: ${msg}`);
    }
  });
