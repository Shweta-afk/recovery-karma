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
import {
  DEFAULT_TRUNK,
  channelHeadroom,
  type CompanyShare,
  type TrunkSettings,
} from "./channel-plan";
import { didPickMessage, istDayStart, normaliseDid, pickDid, type DidRow } from "./did-rules";

export interface DialAgent {
  id: string;
  phone: string;
  extension: string | null;
}

/** PostgREST "table not in schema cache" / Postgres "relation does not exist". */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    /does not exist/i.test(error.message ?? "")
  );
}

/** A function (or a column) from a migration that hasn't been applied yet. */
function isMissingObject(error: { code?: string; message?: string }): boolean {
  return (
    isMissingTable(error) ||
    error.code === "PGRST202" ||
    error.code === "42883" ||
    error.code === "42703" ||
    error.code === "PGRST204"
  );
}

// Untyped Supabase client (no generated Database types) — see CLAUDE.md's typecheck note.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => getSupabaseAdmin() as any;

export async function loadTelephonySettings(
  clientId: string,
): Promise<TelephonySettingsRow | null> {
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
        console.warn(
          "[telephony-guard] do_not_call table missing — apply 20260926_skycrm_telephony.sql",
        );
        return hits;
      }
      // Any other failure fails CLOSED: we can't prove the number is allowed.
      throw new Error("Could not check the do-not-call list — call not placed.");
    }
    for (const row of (data ?? []) as Array<{ phone: string }>) hits.add(row.phone);
  }
  return hits;
}

/** Trunk size and inbound reserve (telephony_platform). Before 20261026 is applied: the old
 *  fixed 60-channel trunk with nothing kept for inbound, i.e. exactly the previous behaviour. */
export async function loadTrunk(): Promise<
  TrunkSettings & { didCoolingDays: number; defaultDidDailyCap: number }
> {
  const { data, error } = await db()
    .from("telephony_platform")
    .select("total_channels, inbound_reserve, did_cooling_days, default_did_daily_cap")
    .maybeSingle();
  if (error || !data) {
    if (error && !isMissingObject(error))
      console.warn(`[telephony-guard] telephony_platform unreadable: ${error.message}`);
    return {
      totalChannels: GLOBAL_CHANNEL_LIMIT,
      inboundReserve: 0,
      didCoolingDays: 60,
      defaultDidDailyCap: 150,
    };
  }
  const row = data as {
    total_channels: number;
    inbound_reserve: number;
    did_cooling_days: number;
    default_did_daily_cap: number;
  };
  return {
    totalChannels: row.total_channels ?? DEFAULT_TRUNK.totalChannels,
    inboundReserve: row.inbound_reserve ?? DEFAULT_TRUNK.inboundReserve,
    didCoolingDays: row.did_cooling_days ?? 60,
    defaultDidDailyCap: row.default_did_daily_cap ?? 150,
  };
}

/** Every company's share plus what is open right now — the inputs to channelHeadroom. */
export async function loadChannelState(): Promise<{
  trunk: TrunkSettings;
  companies: CompanyShare[];
  inboundActive: number;
}> {
  const since = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
  const [trunk, open, shares] = await Promise.all([
    loadTrunk(),
    db()
      .from("telephony_calls")
      .select("client_id, direction")
      .is("ended_at", null)
      .gt("started_at", since),
    db().from("telephony_settings").select("client_id, enabled, channel_limit, channel_reserved"),
  ]);
  if (open.error) throw new Error(open.error.message);
  let shareRows = shares.data as Array<{
    client_id: string;
    enabled: boolean;
    channel_limit: number;
    channel_reserved?: number;
  }> | null;
  if (shares.error) {
    // channel_reserved not there yet (20261026 not applied): no guarantees, ceilings only.
    const legacy = await db()
      .from("telephony_settings")
      .select("client_id, enabled, channel_limit");
    shareRows = legacy.data ?? [];
  }
  const openRows = (open.data ?? []) as Array<{ client_id: string; direction: string }>;
  const outbound = new Map<string, number>();
  let inboundActive = 0;
  for (const r of openRows) {
    if (r.direction === "inbound") inboundActive++;
    else outbound.set(r.client_id, (outbound.get(r.client_id) ?? 0) + 1);
  }
  const companies: CompanyShare[] = (shareRows ?? []).map((r) => ({
    clientId: r.client_id,
    reserved: r.channel_reserved ?? 0,
    max: r.channel_limit ?? 0,
    activeOutbound: outbound.get(r.client_id) ?? 0,
    enabled: !!r.enabled,
  }));
  // Calls from companies with no settings row (simulator) still occupy the trunk.
  for (const [clientId, n] of outbound) {
    if (!companies.some((c) => c.clientId === clientId)) {
      companies.push({
        clientId,
        reserved: 0,
        max: trunk.totalChannels,
        activeOutbound: n,
        enabled: false,
      });
    }
  }
  return { trunk, companies, inboundActive };
}

/** Channels this company may still open right now, and whether its own ceiling is what stops it. */
export async function channelsFor(
  clientId: string,
  settings: TelephonySettingsRow | null,
): Promise<{ lines: number; atCompanyCeiling: boolean }> {
  try {
    const state = await loadChannelState();
    const lines = channelHeadroom({
      ...state,
      clientId,
      fallbackMax: settings ? settings.channel_limit : undefined,
    });
    const me = state.companies.find((c) => c.clientId === clientId);
    return { lines, atCompanyCeiling: !!me && me.activeOutbound >= me.max };
  } catch (err) {
    console.warn(
      `[telephony-guard] channel state unreadable: ${err instanceof Error ? err.message : err}`,
    );
    return { lines: settings ? 0 : GLOBAL_CHANNEL_LIMIT, atCompanyCeiling: false };
  }
}

// ─── Caller number (DID) per call ──────────────────────────────────────────────

/** The company's numbers, or [] when the inventory table doesn't exist yet. */
export async function loadCompanyDids(clientId: string): Promise<DidRow[]> {
  const { data, error } = await db()
    .from("telephony_dids")
    .select(
      "id, number, status, use, client_id, portfolio_id, vendor_queue, daily_cap, resting_until, cooling_until",
    )
    .eq("client_id", clientId)
    .eq("status", "assigned");
  if (error) {
    if (!isMissingObject(error))
      throw new Error("Could not load your company's calling numbers — call not placed.");
    return [];
  }
  return (data ?? []) as DidRow[];
}

export interface DidUsage {
  callsToday: number;
  calls7d: number;
  answered7d: number;
}

/** Calls on each number today (IST) and over the last 7 days (telephony_did_usage). */
export async function didUsage(didIds: string[], now = new Date()): Promise<Map<string, DidUsage>> {
  const out = new Map<string, DidUsage>();
  if (!didIds.length) return out;
  const { data, error } = await db().rpc("telephony_did_usage", {
    p_did_ids: didIds,
    p_day_start: istDayStart(now).toISOString(),
    p_week_start: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
  });
  if (error) throw new Error(`Could not count calls per number (${error.message})`);
  for (const r of (data ?? []) as Array<{
    did_id: string;
    calls_today: number;
    calls_7d: number;
    answered_7d: number;
  }>) {
    out.set(r.did_id, {
      callsToday: r.calls_today,
      calls7d: r.calls_7d,
      answered7d: r.answered_7d,
    });
  }
  return out;
}

/** Outbound calls placed on each of `dids` since midnight IST. */
async function callsTodayByDid(dids: DidRow[]): Promise<Map<string, number>> {
  try {
    const usage = await didUsage(dids.map((d) => d.id));
    return new Map([...usage].map(([id, u]) => [id, u.callsToday]));
  } catch {
    throw new Error("Could not check today's calls per number — call not placed.");
  }
}

/** The number this company last called `phone` from. */
async function lastDidFor(clientId: string, phone: string): Promise<string | null> {
  const last10 = normalisePhone(phone);
  if (last10.length !== 10) return null;
  const { data } = await db()
    .from("telephony_calls")
    .select("did_id")
    .eq("client_id", clientId)
    .eq("direction", "outbound")
    .not("did_id", "is", null)
    .like("remote_phone", `%${last10}`)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { did_id: string } | null)?.did_id ?? null;
}

export type ChosenDid = { id: string; number: string } | null;

/** Which number this call goes out on. `requested` (a manual dial's picker) is honoured only if it
 *  is one of the company's own usable numbers. Throws the agent-facing reason when every number
 *  is at its cap or resting. */
export async function chooseDid(args: {
  clientId: string;
  debtorPhone: string;
  portfolioId?: string | null;
  requested?: string;
  defaultDailyCap: number;
}): Promise<ChosenDid> {
  const dids = await loadCompanyDids(args.clientId);
  if (!dids.length) return null;
  const [usedToday, lastDidId] = await Promise.all([
    callsTodayByDid(dids),
    lastDidFor(args.clientId, args.debtorPhone),
  ]);
  const common = {
    clientId: args.clientId,
    portfolioId: args.portfolioId,
    usedToday,
    defaultDailyCap: args.defaultDailyCap,
    now: new Date(),
  };
  const wanted = args.requested ? normaliseDid(args.requested) : "";
  const requestedDid = wanted ? dids.find((d) => d.number === wanted) : undefined;
  if (requestedDid) {
    const r = pickDid({
      ...common,
      dids: [requestedDid],
      portfolioId: requestedDid.portfolio_id,
      lastDidId: requestedDid.id,
    });
    if (r.ok && r.did) return { id: r.did.id, number: r.did.number };
  }
  const pick = pickDid({ ...common, dids, lastDidId });
  if (!pick.ok) {
    await recordRefusal(args.clientId, "no_number");
    throw new Error(didPickMessage(pick.reason));
  }
  return pick.did ? { id: pick.did.id, number: pick.did.number } : null;
}

// At most one refusal row per company and reason per minute: the dialer asks again every few
// seconds while agents wait, and the report wants "how often were they waiting", not tick counts.
const lastRefusal = new Map<string, number>();

/** Best-effort: a dial turned away for lack of a line or number (see telephony_refusals). */
export async function recordRefusal(
  clientId: string,
  reason: "company_limit" | "platform_busy" | "no_number",
): Promise<void> {
  const key = `${clientId}:${reason}`;
  if (Date.now() - (lastRefusal.get(key) ?? 0) < 60_000) return;
  lastRefusal.set(key, Date.now());
  const { error } = await db().from("telephony_refusals").insert({ client_id: clientId, reason });
  if (error && !isMissingObject(error))
    console.warn(`[telephony-guard] refusal not recorded: ${error.message}`);
}

/** The inventory row for a number a borrower dialled (inbound routing). */
export async function didByNumber(raw: string): Promise<DidRow | null> {
  const number = normaliseDid(raw);
  if (!number) return null;
  const { data, error } = await db()
    .from("telephony_dids")
    .select(
      "id, number, status, use, client_id, portfolio_id, vendor_queue, daily_cap, resting_until, cooling_until",
    )
    .eq("number", number)
    .maybeSingle();
  if (error) return null;
  return (data as DidRow | null) ?? null;
}

/** A borrower of `clientId` with this phone (primary number), for screen pop and missed calls. */
export async function debtorByPhone(
  clientId: string,
  phone: string | null | undefined,
): Promise<{
  id: string;
  name: string;
  assigned_agent_id: string | null;
  portfolio_id: string | null;
} | null> {
  const last10 = phone ? normalisePhone(phone) : "";
  if (last10.length !== 10) return null;
  const { data } = await db()
    .from("debtors")
    .select("id, name, assigned_agent_id, portfolio_id")
    .eq("client_id", clientId)
    .like("phone_primary", `%${last10}`)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  return (
    (data as {
      id: string;
      name: string;
      assigned_agent_id: string | null;
      portfolio_id: string | null;
    } | null) ?? null
  );
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
  debtorId?: string | null;
  /** Numbers kept for one portfolio are only used for its borrowers. */
  portfolioId?: string | null;
  /** A caller ID picked in the browser (manual dial); used only if it's one of the company's. */
  requestedCallerId?: string;
}): Promise<{ ledgerId: string; agentHandle: string; callerId?: string }> {
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

  // An agent is on one call at a time, so any call still "open" on their phone is over. Without
  // the provider's hangup event (no webhook yet, or a call ended from the browser phone) those
  // rows held a line each for STALE_CALL_MINUTES; 20 of them filled Axiotta's 20 lines on
  // 2026-11-03 and every dial said the company's lines were busy.
  await db()
    .from("telephony_calls")
    .update({ ended_at: new Date().toISOString(), status: "superseded" })
    .eq("client_id", args.clientId)
    .eq("agent_handle", agentHandle)
    .eq("direction", "outbound")
    .is("ended_at", null);

  const trunk = await loadTrunk();
  const did = await chooseDid({
    clientId: args.clientId,
    debtorPhone: args.debtorPhone,
    portfolioId: args.portfolioId,
    requested: args.requestedCallerId,
    defaultDailyCap: trunk.defaultDidDailyCap,
  });

  let { data, error } = await db().rpc("telephony_reserve_channel_v2", {
    p_client_id: args.clientId,
    p_stale_minutes: STALE_CALL_MINUTES,
    p_agent_id: args.agent.id || null,
    p_provider: args.provider,
    p_ref_id: args.refId,
    p_agent_handle: agentHandle,
    p_remote_phone: args.debtorPhone,
    p_did_id: did?.id ?? null,
    p_did_number: did?.number ?? null,
    p_debtor_id: args.debtorId ?? null,
  });
  if (error && isMissingObject(error)) {
    // 20261026_telephony_dids_channels.sql not applied: the old ceiling-only reservation.
    ({ data, error } = await db().rpc("telephony_reserve_channel", {
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
    }));
  }
  if (error) {
    const friendly = channelLimitMessage(error.message ?? "");
    if (friendly) {
      await recordRefusal(
        args.clientId,
        (error.message ?? "").includes("CHANNEL_LIMIT_COMPANY") ? "company_limit" : "platform_busy",
      );
      throw new Error(friendly);
    }
    // A real provider must not dial without a ledger row: hangup and webhook matching depend on it.
    if (args.provider !== "sim")
      throw new Error("Could not reserve a calling line — call not placed.");
    console.warn(
      `[telephony-guard] channel reservation failed (sim, continuing): ${error.message}`,
    );
    return { ledgerId: "", agentHandle, callerId: did?.number };
  }
  return { ledgerId: data as string, agentHandle, callerId: did?.number };
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
  /** Every live event's vendor words, in order (20261105_ledger_vendor_events.sql). */
  vendor_events?: string | null;
  /** Talk time on a completed call, ringing time otherwise — see talk-time.ts. */
  duration_seconds?: number | null;
}

const LEDGER_COLS =
  "id, client_id, agent_id, provider_call_id, direction, agent_handle, remote_phone, vendor_callid, status, answered_at, ended_at, vendor_events, duration_seconds";

export async function updateLedger(id: string, patch: Record<string, unknown>): Promise<void> {
  if (!id) return;
  const { error } = await db().from("telephony_calls").update(patch).eq("id", id);
  if (error) console.warn(`[telephony-guard] ledger update failed: ${error.message}`);
}

/** Same, but only while the call is still open, checked by the database at write time. For a
 *  writer that read the row earlier and may have been overtaken by the provider's final event. */
export async function updateLedgerIfOpen(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!id) return;
  const { error } = await db()
    .from("telephony_calls")
    .update(patch)
    .eq("id", id)
    .is("ended_at", null);
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
  didId?: string | null;
  didNumber?: string | null;
  debtorId?: string | null;
}): Promise<LedgerRow | null> {
  const base = {
    client_id: row.clientId,
    agent_id: row.agentId,
    provider: row.provider,
    direction: "inbound",
    agent_handle: row.agentHandle,
    remote_phone: row.remotePhone,
    vendor_callid: row.vendorCallId,
    status: "ringing",
  };
  const extra = {
    ...(row.didNumber ? { did_id: row.didId ?? null, did_number: row.didNumber } : {}),
    ...(row.debtorId ? { debtor_id: row.debtorId } : {}),
  };
  const insert = (values: Record<string, unknown>) =>
    db().from("telephony_calls").insert(values).select(LEDGER_COLS).single();
  let { data, error } = await insert({ ...base, ...extra });
  // did_id / debtor_id columns not there yet (20261026 not applied): record the call without them.
  if (error && isMissingObject(error) && Object.keys(extra).length)
    ({ data, error } = await insert(base));
  if (error) {
    console.warn(`[telephony-guard] inbound ledger insert failed: ${error.message}`);
    return null;
  }
  const inserted = data as LedgerRow;
  await updateLedger(inserted.id, { provider_call_id: inserted.id });
  return { ...inserted, provider_call_id: inserted.id };
}
