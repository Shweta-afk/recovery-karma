// Matches a vendor-keyed webhook event (SkyCRM reports its own callid + the agent's extension) to
// our telephony_calls ledger row, keeps the ledger current, and records inbound calls. Imported
// only by webhook-handler.ts, so none of this reaches the browser bundle.
import { getSupabaseAdmin } from "@/lib/supabase-admin.server";
import { getTelephonyProvider } from "./index";
import {
  debtorByPhone,
  didByNumber,
  insertInboundLedger,
  ledgerForWebhook,
  markEndedByCustomer,
  updateLedger,
} from "./guard.server";
import { copyTalkTimeToCallLogs } from "./talk-time";
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

  if (!ledger && status.direction === "inbound" && status.vendorCallId) {
    ledger = await recordInbound(status);
    // Lost a race with a simultaneous event for the same call (unique vendor_callid).
    ledger ??= await ledgerForWebhook({ vendorCallId: status.vendorCallId }).catch(() => null);
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
  if (status.vendorStatus) {
    const prior = ledger.vendor_events ? `${ledger.vendor_events} > ` : "";
    patch.vendor_events = `${prior}${status.vendorStatus}`.slice(-500);
  }
  if (ledger.direction === "inbound" && !ledger.agent_id && status.agentHandle) {
    // Recorded from the dialled number while still in the queue; now an extension has it.
    const { data: agent } = (await (getSupabaseAdmin() as any)
      .from("agents")
      .select("id, client_id")
      .eq("agent_extension", status.agentHandle)
      .maybeSingle()) as { data: { id: string; client_id: string } | null };
    if (agent?.client_id === ledger.client_id) {
      patch.agent_id = agent.id;
      patch.agent_handle = status.agentHandle;
    }
  }
  await updateLedger(ledger.id, patch);
  if (status.status === "completed" && status.durationSeconds !== undefined) {
    await markEndedByCustomer(ledger.id);
  }
  // The agent has usually saved the disposition by now. A later save copies it from the ledger.
  await copyTalkTimeToCallLogs(
    getSupabaseAdmin() as never,
    ours,
    status.status,
    status.durationSeconds,
  );
  return {
    status: { ...status, providerCallId: ours, customIdentifier: ours },
    ownerClientId: ledger.client_id,
  };
}

/**
 * A new inbound call. The DIALLED NUMBER decides the company: each number belongs to one company
 * at a time (telephony_dids), so a borrower calling back always reaches the company that called
 * them. The extension that rang says which agent picked up. Before the inventory exists, or for a
 * number not in it, the extension's company is used (the previous behaviour).
 */
async function recordInbound(status: CallStatusEvent) {
  const did = status.didNumber ? await didByNumber(status.didNumber).catch(() => null) : null;
  const agent = status.agentHandle
    ? ((
        await (getSupabaseAdmin() as any)
          .from("agents")
          .select("id, client_id")
          .eq("agent_extension", status.agentHandle)
          .maybeSingle()
      ).data as { id: string; client_id: string } | null)
    : null;

  const clientId = did?.client_id ?? agent?.client_id ?? null;
  if (!clientId) {
    if (status.didNumber) {
      console.warn(
        `[telephony-webhook] inbound call on ${status.didNumber} — number not assigned to any company; not recorded`,
      );
    }
    return null;
  }
  let agentId = agent?.id ?? null;
  if (agent && agent.client_id !== clientId) {
    // The vendor queue for this number rang another company's extension: a queue set up wrongly.
    // Record the call for the number's company, but not against an agent who can't see its borrowers.
    console.error(
      `[telephony-webhook] number ${did?.number} belongs to company ${clientId} but rang extension ${status.agentHandle} of company ${agent.client_id} — check the number's queue in SkyCRM`,
    );
    agentId = null;
  }
  const debtor = await debtorByPhone(clientId, status.remotePhone).catch(() => null);
  return insertInboundLedger({
    clientId,
    agentId,
    provider: getTelephonyProvider().name,
    agentHandle: agentId ? (status.agentHandle ?? null) : null,
    remotePhone: status.remotePhone ?? null,
    vendorCallId: status.vendorCallId as string,
    didId: did?.id ?? null,
    didNumber: did?.number ?? null,
    debtorId: debtor?.id ?? null,
  });
}
