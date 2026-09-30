// Matches a vendor-keyed webhook event (SkyCRM reports its own callid + the agent's extension) to
// our telephony_calls ledger row, keeps the ledger current, and records inbound calls. Imported
// only by webhook-handler.ts, so none of this reaches the browser bundle.
import { getSupabaseAdmin } from "@/lib/supabase-admin.server";
import { getTelephonyProvider } from "./index";
import { insertInboundLedger, ledgerForWebhook, updateLedger } from "./guard.server";
import type { CallStatusEvent } from "./types";

/** Swap a vendor-keyed webhook event onto our providerCallId and keep the ledger current.
 *  Events from providers that already echo our id (no vendorCallId/agentHandle) pass through. */
export async function reconcileWithLedger(
  status: CallStatusEvent,
): Promise<{ status: CallStatusEvent; ownerClientId?: string; stale?: boolean }> {
  if (!status.vendorCallId && !status.agentHandle) return { status };
  let ledger = await ledgerForWebhook({
    vendorCallId: status.vendorCallId,
    agentHandle: status.agentHandle,
  }).catch(() => null);

  if (!ledger && status.direction === "inbound" && status.agentHandle && status.vendorCallId) {
    // agent_extension isn't in database.types.ts until `bun run gen:types` runs post-migration.
    const { data } = (await (getSupabaseAdmin() as any)
      .from("agents")
      .select("id, client_id")
      .eq("agent_extension", status.agentHandle)
      .maybeSingle()) as { data: { id: string; client_id: string } | null };
    if (data) {
      ledger = await insertInboundLedger({
        clientId: data.client_id,
        agentId: data.id,
        provider: getTelephonyProvider().name,
        agentHandle: status.agentHandle,
        remotePhone: status.remotePhone ?? null,
        vendorCallId: status.vendorCallId,
      });
      // Lost a race with a simultaneous event for the same call (unique vendor_callid).
      ledger ??= await ledgerForWebhook({ vendorCallId: status.vendorCallId }).catch(() => null);
    }
  }
  if (!ledger) return { status };

  const ours = ledger.provider_call_id ?? ledger.id;
  const live = ["ringing", "connected"].includes(status.status);
  if (ledger.ended_at && live) {
    // Delivered out of order after the hangup. Applying it would reopen the ledger row and flip
    // the agent's screen back to "connected" on a call that has already ended.
    return {
      status: { ...status, providerCallId: ours, customIdentifier: ours },
      ownerClientId: ledger.client_id,
      stale: true,
    };
  }
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status: status.status };
  if (status.vendorCallId && !ledger.vendor_callid) patch.vendor_callid = status.vendorCallId;
  if (status.status === "connected" && !ledger.answered_at) patch.answered_at = now;
  if (!live) {
    if (!ledger.ended_at) patch.ended_at = now;
    if (status.durationSeconds !== undefined) patch.duration_seconds = status.durationSeconds;
  }
  if (status.recordingPath) patch.recording_path = status.recordingPath;
  await updateLedger(ledger.id, patch);
  return {
    status: { ...status, providerCallId: ours, customIdentifier: ours },
    ownerClientId: ledger.client_id,
  };
}

