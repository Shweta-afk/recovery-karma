// Server-side call guard: every provider dial goes through prepareCall (single calls) or
// planDialerCapacity + prepareCall (dialer legs). Rules themselves are in guard-rules.ts.
import { getSupabaseAdmin } from "@/lib/supabase-admin.server";
import {
  GLOBAL_CHANNEL_LIMIT,
  STALE_CALL_MINUTES,
  channelLimitMessage,
  evaluateCall,
  differentNumber,
  normalisePhone,
  type TelephonySettingsRow,
} from "./guard-rules";
import {
  DEFAULT_TRUNK,
  channelHeadroom,
  type CompanyShare,
  type TrunkSettings,
} from "./channel-plan";
import {
  didPickMessage,
  istDayStart,
  normaliseDid,
  pickCallerNumber,
  type CallKind,
  type DidRow,
} from "./did-rules";
import {
  SILENT_PREDICTIVE_SECONDS,
  pickPredictiveLedger,
  sortOpenPredictive,
  type OpenPredictiveRow,
} from "./predictive-rules";

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
  const cols =
    "enabled, seat_limit, channel_limit, inbound_did, inbound_queue, call_window_start, call_window_end, managers_can_call";
  const read = (c: string) =>
    db().from("telephony_settings").select(c).eq("client_id", clientId).maybeSingle();
  let { data, error } = await read(`${cols}, predictive_queue`);
  // Deployed ahead of 20261117_predictive_dialing.sql: no predictive queue, same as before.
  if (error && isMissingObject(error)) ({ data, error } = await read(cols));
  // Missing table (migration not applied yet) must not take calling down: treat as "no row".
  if (error) {
    console.warn(`[telephony-guard] telephony_settings unreadable: ${error.message}`);
    return null;
  }
  return (data as TelephonySettingsRow | null) ?? null;
}

/** A manager may dial only where a superadmin switched "Managers can call" on for the company.
 *  Agents and admins are unaffected. */
export async function assertMayDial(caller: { role: string; clientId: string }): Promise<void> {
  if (caller.role !== "manager") return;
  const settings = await loadTelephonySettings(caller.clientId);
  if (!settings?.managers_can_call) {
    throw new Error("Calling isn't switched on for managers in your company. Ask SamvadX support.");
  }
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

export type CompanyDid = DidRow & { prefix: string | null; manual: boolean };

/** The company's numbers, or [] when the inventory table doesn't exist yet. Before
 *  20261120_calling_numbers_prefix_manual_portfolio.sql: no prefix, nothing marked manual. */
export async function loadCompanyDids(clientId: string): Promise<CompanyDid[]> {
  const base =
    "id, number, status, use, client_id, portfolio_id, vendor_queue, daily_cap, resting_until, cooling_until";
  const read = (cols: string) =>
    db().from("telephony_dids").select(cols).eq("client_id", clientId).eq("status", "assigned");
  let { data, error } = await read(`${base}, prefix, manual`);
  if (error && isMissingObject(error)) ({ data, error } = await read(base));
  if (error) {
    if (!isMissingObject(error))
      throw new Error("Could not load your company's calling numbers — call not placed.");
    return [];
  }
  return ((data ?? []) as Array<DidRow & { prefix?: string | null; manual?: boolean }>).map(
    (d) => ({ ...d, prefix: d.prefix ?? null, manual: !!d.manual }),
  );
}

/** The numbers a manager picked for a portfolio (portfolio_dids); empty when none or the table is
 *  missing. */
export async function portfolioNumberIds(portfolioId: string): Promise<Set<string>> {
  const { data, error } = await db()
    .from("portfolio_dids")
    .select("did_id")
    .eq("portfolio_id", portfolioId);
  if (error) {
    if (!isMissingObject(error))
      throw new Error("Could not load this portfolio's calling numbers — call not placed.");
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ did_id: string }>).map((r) => r.did_id));
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

export type ChosenDid = { id: string; number: string; prefix: string | null } | null;

/** Which number this call goes out on (pickCallerNumber in did-rules.ts): Manual Dial → the
 *  admin's manual numbers, queue calls → the portfolio's chosen numbers, rotating. `requested` (the
 *  Manual Dial picker) is honoured only if it is one of the manual numbers. Throws the
 *  agent-facing reason when the call may not go out. */
export async function chooseDid(args: {
  clientId: string;
  kind: CallKind;
  portfolioId?: string | null;
  requested?: string;
  requirePrefix: boolean;
  defaultDailyCap: number;
}): Promise<ChosenDid> {
  const dids = await loadCompanyDids(args.clientId);
  if (!dids.length) return null;
  const [usedToday, chosen] = await Promise.all([
    callsTodayByDid(dids),
    args.kind === "queue" && args.portfolioId
      ? portfolioNumberIds(args.portfolioId)
      : Promise.resolve(new Set<string>()),
  ]);
  const wanted = args.requested ? normaliseDid(args.requested) : "";
  const pick = pickCallerNumber({
    dids,
    clientId: args.clientId,
    kind: args.kind,
    portfolioId: args.portfolioId,
    portfolioNumberIds: chosen,
    requestedId: wanted ? (dids.find((d) => d.number === wanted)?.id ?? null) : null,
    requirePrefix: args.requirePrefix,
    usedToday,
    defaultDailyCap: args.defaultDailyCap,
    now: new Date(),
  });
  if (!pick.ok) {
    await recordRefusal(args.clientId, "no_number");
    throw new Error(didPickMessage(pick.reason));
  }
  if (!pick.did) return null;
  const did = pick.did as CompanyDid;
  return { id: did.id, number: did.number, prefix: did.prefix };
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
  /** A caller ID picked in the browser (Manual Dial); used only if it's one of the manual numbers. */
  requestedCallerId?: string;
  /** Manual Dial or a Call Queue call — decides which of the company's numbers it may use. */
  kind: CallKind;
  /** Vendor-routed predictive call into this queue. `agent` is only whose extension goes in the
   *  request: the ledger row gets no agent until the vendor's answer names one, and the agent's
   *  other open calls are left alone (they aren't on this call). */
  predictive?: { queue: string };
}): Promise<{
  ledgerId: string;
  agentHandle: string;
  callerId?: string;
  /** The chosen number's prefix — sent to SkyCRM so the borrower sees that number. */
  callerPrefix?: string;
}> {
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
  if (!args.predictive)
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
    kind: args.kind,
    portfolioId: args.portfolioId,
    requested: args.requestedCallerId,
    requirePrefix: args.provider === "skycrm",
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
    return {
      ledgerId: "",
      agentHandle,
      callerId: did?.number,
      callerPrefix: did?.prefix ?? undefined,
    };
  }
  const ledgerId = data as string;
  if (args.predictive) {
    const { error: markError } = await db()
      .from("telephony_calls")
      .update({
        predictive_queue: args.predictive.queue,
        request_extension: agentHandle,
        agent_id: null,
        agent_handle: null,
      })
      .eq("id", ledgerId);
    if (markError) {
      // Unmarked, the vendor's events could never be matched to this call (no agent, no callid).
      await updateLedger(ledgerId, { ended_at: new Date().toISOString(), status: "failed" });
      if (args.provider !== "sim")
        throw new Error("Predictive calling isn't set up in the database yet — call not placed.");
      return {
        ledgerId: "",
        agentHandle,
        callerId: did?.number,
        callerPrefix: did?.prefix ?? undefined,
      };
    }
  }
  return { ledgerId, agentHandle, callerId: did?.number, callerPrefix: did?.prefix ?? undefined };
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
  started_at?: string | null;
  /** Every live event's vendor words, in order (20261105_ledger_vendor_events.sql). */
  vendor_events?: string | null;
  /** Talk time on a completed call, ringing time otherwise — see talk-time.ts. */
  duration_seconds?: number | null;
  /** The caller number the call went out on (telephony_dids), if the company has numbers. */
  did_id?: string | null;
  /** Set on a vendor-routed predictive call: the queue it went into (20261117). */
  predictive_queue?: string | null;
  /** Predictive: the extension sent in the request — what hangup uses before an agent has it. */
  request_extension?: string | null;
}

const LEDGER_BASE_COLS =
  "id, client_id, agent_id, provider_call_id, direction, agent_handle, remote_phone, vendor_callid, status, started_at, answered_at, ended_at, vendor_events, duration_seconds, did_id";
const LEDGER_COLS = `${LEDGER_BASE_COLS}, predictive_queue, request_extension`;

/** Run a ledger read with the predictive columns, or without them before 20261117 is applied. */
async function readLedger<T>(
  query: (
    cols: string,
  ) => PromiseLike<{ data: T; error: { code?: string; message?: string } | null }>,
): Promise<T | null> {
  let { data, error } = await query(LEDGER_COLS);
  if (error && isMissingObject(error)) ({ data, error } = await query(LEDGER_BASE_COLS));
  return error ? null : data;
}

/** The prefix of a caller number, for a hangup that must name the call as SkyCRM dialled it. */
export async function didPrefix(didId: string | null | undefined): Promise<string | null> {
  if (!didId) return null;
  const { data, error } = await db()
    .from("telephony_dids")
    .select("prefix")
    .eq("id", didId)
    .maybeSingle();
  if (error) return null;
  return (data as { prefix: string | null } | null)?.prefix ?? null;
}

/**
 * Open predictive calls of a company, for pacing across runs (sortOpenPredictive). Closes the ones
 * the vendor never acknowledged. `ok: false` when the read failed — the caller then falls back to
 * its own run's legs.
 */
export async function openPredictiveCalls(
  clientId: string,
  handles: string[],
): Promise<{ ok: boolean; waiting: number; busy: string[]; silentRefIds: string[] }> {
  const since = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
  const { data, error } = await db()
    .from("telephony_calls")
    .select("id, ref_id, request_extension, agent_handle, vendor_callid, vendor_events, started_at")
    .eq("client_id", clientId)
    .not("predictive_queue", "is", null)
    .is("ended_at", null)
    .gt("started_at", since)
    .limit(500);
  if (error) {
    console.warn(`[telephony-guard] open predictive read failed: ${error.message}`);
    return { ok: false, waiting: 0, busy: [], silentRefIds: [] };
  }
  const rows = (data ?? []) as (OpenPredictiveRow & { ref_id: string | null })[];
  const { silent, waiting, busy } = sortOpenPredictive(rows, handles, Date.now());
  if (silent.length) {
    const { error: closeErr } = await db()
      .from("telephony_calls")
      .update({
        status: "no_answer",
        ended_at: new Date().toISOString(),
        vendor_events: `no answer: no event within ${SILENT_PREDICTIVE_SECONDS} s`,
      })
      .in(
        "id",
        silent.map((r) => r.id),
      )
      .is("ended_at", null);
    if (closeErr)
      console.warn(`[telephony-guard] closing silent calls failed: ${closeErr.message}`);
    else console.warn(`[telephony-guard] closed ${silent.length} unacknowledged predictive calls`);
  }
  return {
    ok: true,
    waiting,
    busy,
    silentRefIds: silent.map((r) => r.ref_id ?? "").filter(Boolean),
  };
}

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

/** The provider's final event on an answered call nobody pressed End on: the customer hung up.
 *  Only when no one recorded an End press first. Separate from the main ledger update so that a
 *  database without the column (20261110_ledger_ended_by.sql) loses only this. */
export async function markEndedByCustomer(id: string): Promise<void> {
  const { error } = await db()
    .from("telephony_calls")
    .update({ ended_by: "customer" })
    .eq("id", id)
    .is("ended_by", null);
  if (error) console.warn(`[telephony-guard] ended_by update failed: ${error.message}`);
}

export async function ledgerByProviderCallId(providerCallId: string): Promise<LedgerRow | null> {
  return readLedger<LedgerRow | null>((cols) =>
    db()
      .from("telephony_calls")
      .select(cols)
      .eq("provider_call_id", providerCallId)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  );
}

/** Match a webhook event to our call: by SkyCRM's call id once known; else an open predictive
 *  call to that borrower (it has no agent until the answer names one); else the one open call on
 *  that extension (click-to-call means an agent is on at most one call at a time). */
export async function ledgerForWebhook(args: {
  vendorCallId?: string;
  agentHandle?: string;
  remotePhone?: string;
  /** An inbound event never belongs to one of our outbound calls by number alone. */
  direction?: "inbound" | "outbound";
}): Promise<LedgerRow | null> {
  const since = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
  if (args.vendorCallId) {
    const hit = await readLedger<LedgerRow | null>((cols) =>
      db()
        .from("telephony_calls")
        .select(cols)
        .eq("vendor_callid", args.vendorCallId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (hit) return hit;
  }
  const last10 = args.remotePhone ? normalisePhone(args.remotePhone) : "";
  if (last10.length === 10) {
    // Fails quietly (null) before 20261117 is applied: then no predictive call exists to find.
    const { data, error } = await db()
      .from("telephony_calls")
      .select(LEDGER_COLS)
      .not("predictive_queue", "is", null)
      .is("vendor_callid", null)
      .is("ended_at", null)
      .gt("started_at", since)
      .like("remote_phone", `%${last10}`)
      .order("started_at", { ascending: false })
      .limit(5);
    const hit = error ? null : pickPredictiveLedger((data ?? []) as LedgerRow[], args.remotePhone);
    if (hit) return hit;
  }
  if (args.agentHandle && last10.length === 10 && args.direction !== "inbound") {
    // This extension's own call to this number that never got a callid (2026-11-20). SkyCRM's
    // end record often arrives after the agent has ended that call and dialled the next one; it
    // belongs to the earlier call, ended or not.
    const hit = await readLedger<LedgerRow | null>((cols) =>
      db()
        .from("telephony_calls")
        .select(cols)
        .eq("agent_handle", args.agentHandle)
        .eq("direction", "outbound")
        .is("vendor_callid", null)
        .gt("started_at", since)
        .like("remote_phone", `%${last10}`)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    if (hit) return hit;
  }
  if (args.agentHandle) {
    const hit = await readLedger<LedgerRow | null>((cols) =>
      db()
        .from("telephony_calls")
        .select(cols)
        .eq("agent_handle", args.agentHandle)
        .is("ended_at", null)
        .gt("started_at", since)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    );
    // "The open call on this extension" only when the event is about the same number. A late end
    // record for the agent's previous call used to land on the call in progress and end it on
    // screen (Babu Gurava Vaidya, ext 8616, 20 Nov: the 14:28 call's NO ANSWER ended the 14:30
    // call 13 s in, and it took that call's callid and recording).
    if (hit && !differentNumber(hit.remote_phone, last10)) return hit;
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
    db().from("telephony_calls").insert(values).select(LEDGER_BASE_COLS).single();
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
