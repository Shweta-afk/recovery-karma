// Agents asking a manager to run Insights on a debtor, plus the per-debtor flags the debtor list
// colours its cards by. Usual store shape: get*() for an immediate render, refresh*() to pull from
// Supabase and broadcast, writes refresh themselves.
//
// The manager notification is NOT sent from here — a trigger on insight_requests does it (and a
// trigger on debtor_traces closes the request and tells the agent once a lookup completes). See
// migrations/20260926_insight_requests.sql.
import { supabase, getMyAgentRow } from "./supabase";

export const INSIGHT_FLAGS_UPDATED = "insight-flags-updated";

export interface InsightRequest {
  id: string;
  debtorId: string;
  requestedBy: string | null;
  requestedByName: string | null;
  note: string | null;
  createdAt: string;
}

export type InsightFlag = "requested" | "traced";

let traced = new Set<string>();
let requested = new Set<string>();
const openByDebtor = new Map<string, InsightRequest | null>();

function broadcast() {
  window.dispatchEvent(new CustomEvent(INSIGHT_FLAGS_UPDATED));
}

/** "requested" wins over "traced": an open request on an already-looked-up debtor means the agent
 *  wants more, and that is the thing a manager scanning the list needs to spot. */
export function getInsightFlag(debtorId: string): InsightFlag | null {
  if (requested.has(debtorId)) return "requested";
  if (traced.has(debtorId)) return "traced";
  return null;
}

export async function refreshInsightFlags(): Promise<void> {
  const { data, error } = await supabase.rpc("insight_debtor_flags");
  // Migration not applied yet, or a transient failure: leave every card plain rather than throw.
  if (error || !data) return;
  const flags = data as { traced?: string[]; requested?: string[] };
  traced = new Set(flags.traced ?? []);
  requested = new Set(flags.requested ?? []);
  broadcast();
}

/** The open request on one debtor, if any. Undefined = not loaded yet. */
export function getOpenRequest(debtorId: string): InsightRequest | null | undefined {
  return openByDebtor.get(debtorId);
}

export async function refreshOpenRequest(debtorId: string): Promise<void> {
  const { data, error } = await supabase
    .from("insight_requests")
    .select(
      "id, debtor_id, requested_by, note, created_at, requester:agents!insight_requests_requested_by_fkey(name)",
    )
    .eq("debtor_id", debtorId)
    .eq("status", "open")
    .maybeSingle();
  if (error) {
    openByDebtor.set(debtorId, null);
    broadcast();
    return;
  }
  const row = data as Record<string, unknown> | null;
  openByDebtor.set(
    debtorId,
    row
      ? {
          id: String(row.id),
          debtorId: String(row.debtor_id),
          requestedBy: (row.requested_by as string | null) ?? null,
          requestedByName: ((row.requester as { name?: string } | null)?.name as string) ?? null,
          note: (row.note as string | null) ?? null,
          createdAt: String(row.created_at),
        }
      : null,
  );
  if (row) requested.add(debtorId);
  else requested.delete(debtorId);
  broadcast();
}

export async function requestInsights(debtorId: string, note?: string): Promise<void> {
  const me = await getMyAgentRow();
  if (!me?.client_id) throw new Error("Your session expired — sign in again");
  const { error } = await supabase.from("insight_requests").insert({
    client_id: me.client_id,
    debtor_id: debtorId,
    requested_by: me.id,
    note: note?.trim() || null,
  });
  // 23505 = the one-open-request-per-debtor index: someone already asked, which is the outcome
  // the agent wanted anyway.
  if (error && error.code !== "23505") throw new Error(error.message);
  await refreshOpenRequest(debtorId);
}

/** Manager/admin closes a request without running a lookup. */
export async function dismissInsightRequest(debtorId: string, requestId: string): Promise<void> {
  const me = await getMyAgentRow();
  const { error } = await supabase
    .from("insight_requests")
    .update({ status: "dismissed", resolved_at: new Date().toISOString(), resolved_by: me?.id })
    .eq("id", requestId);
  if (error) throw new Error(error.message);
  await refreshOpenRequest(debtorId);
}

/** Called after any successful lookup. A fresh lookup's trace row already closed the request via
 *  the DB trigger, but one served from an earlier result writes no row — so close it here too
 *  (a no-op when already closed). The DB notifies the requesting agent on open -> done. */
export async function markDebtorTraced(debtorId: string): Promise<void> {
  traced.add(debtorId);
  requested.delete(debtorId);
  openByDebtor.set(debtorId, null);
  broadcast();
  const me = await getMyAgentRow().catch(() => null);
  await supabase
    .from("insight_requests")
    .update({ status: "done", resolved_at: new Date().toISOString(), resolved_by: me?.id })
    .eq("debtor_id", debtorId)
    .eq("status", "open");
}
