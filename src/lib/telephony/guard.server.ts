// Server-side call guard: every provider dial goes through prepareCall (single calls) or
// planDialerCapacity + prepareCall (dialer legs). Rules themselves are in guard-rules.ts.
import { getSupabaseAdmin } from "@/lib/supabase-admin.server";
import {
  GLOBAL_CHANNEL_LIMIT,
  STALE_CALL_MINUTES,
  channelLimitMessage,
  evaluateCall,
  normalisePhone,
  type TelephonySettingsRow,
} from "./guard-rules";

export interface DialAgent {
  id: string;
  phone: string;
  extension: string | null;
}

/** PostgREST "table not in schema cache" / Postgres "relation does not exist". */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST205" || error.code === "42P01" || /does not exist/i.test(error.message ?? "");
}

// Untyped Supabase client (no generated Database types) — see CLAUDE.md's typecheck note.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabaseAdmin() as any;

export async function loadTelephonySettings(clientId: string): Promise<TelephonySettingsRow | null> {
  const { data, error } = await db()
    .from("telephony_settings")
    .select(
      "enabled, seat_limit, channel_limit, inbound_did, inbound_queue, call_window_start, call_window_end",
    )
    .eq("client_id", clientId)
    .maybeSingle();
  // Missing table (migration not applied yet) must not take calling down: treat as "no row".
  if (error) {
    console.warn(`[telephony-guard] telephony_settings unreadable: ${error.message}`);
    return null;
  }
  return (data as TelephonySettingsRow | null) ?? null;
}

/** Which of `phones` are on the company's do-not-call list (as normalised 10-digit keys). */
export async function doNotCallSet(clientId: string, phones: string[]): Promise<Set<string>> {
  const keys = [...new Set(phones.map(normalisePhone).filter((p) => p.length === 10))];
  const hits = new Set<string>();
  for (let i = 0; i < keys.length; i += 200) {
    const { data, error } = await db()
      .from("do_not_call")
      .select("phone")
      .eq("client_id", clientId)
      .in("phone", keys.slice(i, i + 200));
    if (error) {
      // Code deployed ahead of 20260926_skycrm_telephony.sql: no list exists yet to honour.
      if (isMissingTable(error)) {
        console.warn("[telephony-guard] do_not_call table missing — apply 20260926_skycrm_telephony.sql");
        return hits;
      }
      // Any other failure fails CLOSED: we can't prove the number is allowed.
      throw new Error("Could not check the do-not-call list — call not placed.");
    }
    for (const row of (data ?? []) as Array<{ phone: string }>) hits.add(row.phone);
  }
  return hits;
}

/** Channels this company may still open right now (0 = none). */
export async function remainingChannels(
  clientId: string,
  settings: TelephonySettingsRow | null,
): Promise<number> {
  const since = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
  const { data, error } = await db()
    .from("telephony_calls")
    .select("client_id")
    .is("ended_at", null)
    .gt("started_at", since);
  if (error) {
    console.warn(`[telephony-guard] telephony_calls unreadable: ${error.message}`);
    return settings ? 0 : GLOBAL_CHANNEL_LIMIT;
  }
  const rows = (data ?? []) as Array<{ client_id: string }>;
  const mine = rows.filter((r) => r.client_id === clientId).length;
  const companyLimit = settings ? settings.channel_limit : GLOBAL_CHANNEL_LIMIT;
  return Math.max(0, Math.min(companyLimit - mine, GLOBAL_CHANNEL_LIMIT - rows.length));
}

/** Throws the agent-facing reason if the call isn't allowed; otherwise reserves a channel and
 *  returns the ledger row id plus what the provider should ring on our side. */
export async function prepareCall(args: {
  clientId: string;
  provider: string;
  agent: DialAgent;
  debtorPhone: string;
  refId: string;
  settings?: TelephonySettingsRow | null;
  /** Pass when the caller already filtered the batch against do_not_call. */
  skipDoNotCall?: boolean;
}): Promise<{ ledgerId: string; agentHandle: string }> {
  const settings =
    args.settings === undefined ? await loadTelephonySettings(args.clientId) : args.settings;
  const onDoNotCall = args.skipDoNotCall
    ? false
    : (await doNotCallSet(args.clientId, [args.debtorPhone])).size > 0;

  const decision = evaluateCall({
    settings,
    provider: args.provider,
    agentExtension: args.agent.extension,
    onDoNotCall,
    now: new Date(),
  });
  if (!decision.ok) throw new Error(decision.message);

  const agentHandle =
    args.provider === "skycrm" ? (args.agent.extension as string).trim() : args.agent.phone;

  const { data, error } = await db().rpc("telephony_reserve_channel", {
    p_client_id: args.clientId,
    p_client_limit: settings ? settings.channel_limit : GLOBAL_CHANNEL_LIMIT,
    p_global_limit: GLOBAL_CHANNEL_LIMIT,
    p_stale_minutes: STALE_CALL_MINUTES,
    p_agent_id: args.agent.id,
    p_provider: args.provider,
    p_ref_id: args.refId,
    p_direction: "outbound",
    p_agent_handle: agentHandle,
    p_remote_phone: args.debtorPhone,
  });
  if (error) {
    const friendly = channelLimitMessage(error.message ?? "");
    if (friendly) throw new Error(friendly);
    // A real provider must not dial without a ledger row: hangup and webhook matching depend on it.
    if (args.provider !== "sim") throw new Error("Could not reserve a calling line — call not placed.");
    console.warn(`[telephony-guard] channel reservation failed (sim, continuing): ${error.message}`);
    return { ledgerId: "", agentHandle };
  }
  return { ledgerId: data as string, agentHandle };
}

export interface LedgerRow {
  id: string;
  client_id: string;
  agent_id: string | null;
  provider_call_id: string | null;
  direction: "outbound" | "inbound";
  agent_handle: string | null;
  remote_phone: string | null;
  vendor_callid: string | null;
  status: string;
  answered_at: string | null;
  ended_at: string | null;
}

const LEDGER_COLS =
  "id, client_id, agent_id, provider_call_id, direction, agent_handle, remote_phone, vendor_callid, status, answered_at, ended_at";

export async function updateLedger(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!id) return;
  const { error } = await db().from("telephony_calls").update(patch).eq("id", id);
  if (error) console.warn(`[telephony-guard] ledger update failed: ${error.message}`);
}

export async function ledgerByProviderCallId(providerCallId: string): Promise<LedgerRow | null> {
  const { data } = await db()
    .from("telephony_calls")
    .select(LEDGER_COLS)
    .eq("provider_call_id", providerCallId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as LedgerRow | null) ?? null;
}

/** Match a webhook event to our call: by SkyCRM's call id once known, else the one open call on
 *  that extension (click-to-call means an agent is on at most one call at a time). */
export async function ledgerForWebhook(args: {
  vendorCallId?: string;
  agentHandle?: string;
}): Promise<LedgerRow | null> {
  if (args.vendorCallId) {
    const { data } = await db()
      .from("telephony_calls")
      .select(LEDGER_COLS)
      .eq("vendor_callid", args.vendorCallId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data as LedgerRow;
  }
  if (args.agentHandle) {
    const since = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
    const { data } = await db()
      .from("telephony_calls")
      .select(LEDGER_COLS)
      .eq("agent_handle", args.agentHandle)
      .is("ended_at", null)
      .gt("started_at", since)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return data as LedgerRow;
  }
  return null;
}

/** Record an inbound call the provider told us about (no channel limit: we can't refuse it). */
export async function insertInboundLedger(row: {
  clientId: string;
  agentId: string | null;
  provider: string;
  agentHandle: string | null;
  remotePhone: string | null;
  vendorCallId: string;
}): Promise<LedgerRow | null> {
  const { data, error } = await db()
    .from("telephony_calls")
    .insert({
      client_id: row.clientId,
      agent_id: row.agentId,
      provider: row.provider,
      direction: "inbound",
      agent_handle: row.agentHandle,
      remote_phone: row.remotePhone,
      vendor_callid: row.vendorCallId,
      status: "ringing",
    })
    .select(LEDGER_COLS)
    .single();
  if (error) {
    console.warn(`[telephony-guard] inbound ledger insert failed: ${error.message}`);
    return null;
  }
  const inserted = data as LedgerRow;
  await updateLedger(inserted.id, { provider_call_id: inserted.id });
  return { ...inserted, provider_call_id: inserted.id };
}
