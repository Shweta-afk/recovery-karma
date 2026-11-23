// Server surface for the dialer — where "background calling" runs and where a real
// provider's API keys stay off the client bundle. These are TanStack Start server
// functions (RPC): the browser calls them, the handlers run server-side against
// getTelephonyProvider() + the pure dialer engine.
//
// Today the active provider is the simulator, so a run advances when tickDialerRun()
// flushes due sim events. Swapping TELEPHONY_PROVIDER to a real vendor changes nothing
// here: real providers deliver events via the authenticated /api/telephony/webhook route
// (webhook-handler.ts) instead of flushDue().
//
// KNOWN LIMITATION (documented in the plan): runs live in module memory. That persists
// across requests in a single dev/Node process but NOT across serverless instances, and
// there is no always-on loop yet — the client polls tickDialerRun while a manager watches.
// A browser-independent background loop needs a worker/cron, which is the SIP-time step.
import { createServerFn } from "@tanstack/react-start";
// Type-only import — erased at compile time, so this server module never pulls the
// supabase client (portfolio-store's runtime dep) into scope.
import type { PortfolioSettings } from "@/lib/portfolio-store";
import * as engine from "@/lib/dialer/engine";
import type { DialerRun, DialTarget } from "@/lib/dialer/engine";
import { getTelephonyProvider } from "./index";
import { getSupabaseAdmin, verifyCaller, type VerifiedCaller } from "@/lib/supabase-admin.server";
import { enforceRateLimit } from "@/lib/rate-limit.server";
import type { SimProvider } from "./sim-provider";
import { isTerminal } from "./call-machine";
import type { TelephonyEvent, CallStatusEvent } from "./types";
import { collectLoggableLegs, type LegCallLog } from "@/lib/dialer/leg-disposition";
import {
  doNotCallSet,
  assertMayDial,
  didPrefix,
  ledgerByProviderCallId,
  loadTelephonySettings,
  openPredictiveCalls,
  prepareCall,
  channelsFor,
  recordRefusal,
  updateLedger,
  updateLedgerIfOpen,
  type DialAgent,
} from "./guard.server";
import { evaluateCall, normalisePhone, STALE_CALL_MINUTES } from "./guard-rules";
import {
  freeAgentHandles,
  linesPerAgent,
  pendingLegs,
  predictiveBatchSize,
  predictiveMode,
  requestExtension,
  runsSharingAgents,
} from "./predictive-rules";

// ─── Process-wide state + event fan-out ─────────────────────────────────────────
//
// These maps are written by one entry point and read by another: the webhook handler
// (mounted on the server fetch entry, reaching this module via `await import`) writes call
// status, while the RPC server functions read it. A bundler can legitimately give those two
// callers SEPARATE instances of this module, in which case the webhook fills one Map and
// getCallStatus reads a different, empty one — the endpoint answers 200 and the UI still
// never learns the call connected. Hanging the state off globalThis makes every instance
// share it within the process.
//
// This is still per-process: it does not survive a restart and is not shared across
// instances. Durable state needs the database (see persistLegLog).
const g = globalThis as typeof globalThis & {
  __recoveryaiTelephony?: {
    runs: Map<string, DialerRun>;
    busyAgents: Map<string, string>;
    loggedLegs: Map<string, Set<string>>;
    latestStatus: Map<string, CallStatusEvent>;
    /** run id / provider call id / call-log id → the client_id that started it. Every server
     *  function below is a public endpoint, so this is what stops one company from hanging up,
     *  polling or hijacking another company's calls even with a valid login of its own. */
    owners: Map<string, string>;
    /** run id → debtor id → the dialable row WE loaded from the database for that debtor. */
    runTargets: Map<string, Map<string, DialTarget>>;
    /** run id → last time a server function or event touched it; drives sweepRuns(). */
    runTouchedAt: Map<string, number>;
    /** run id → its vendor predictive session: the queue and which agents are logged into it. */
    predictiveSessions: Map<string, PredictiveSession>;
    /** Runs a tick is dialling for right now. Ticks arrive every 1.5 s and a SkyCRM request takes
     *  ~3 s, so two used to overlap: both saw the same next borrower and dialled them (one
     *  number 6 times in seconds, 2026-11-21), and the later save wiped the earlier one's legs. */
    tickingRuns: Set<string>;
    /** Events for a run that arrived while a start/tick was dialling for it. That start/tick
     *  works on its own copy of the run and saves it at the end, which used to overwrite (or, on
     *  the first round, drop) a borrower's "answered" event — the call connected but its call
     *  screen never opened (2026-11-21). The copy replays these before it is saved. */
    heldEvents: Map<string, TelephonyEvent[]>;
  };
};

g.__recoveryaiTelephony ??= {
  runs: new Map(),
  busyAgents: new Map(),
  loggedLegs: new Map(),
  latestStatus: new Map(),
  owners: new Map(),
  runTargets: new Map(),
  runTouchedAt: new Map(),
  predictiveSessions: new Map(),
  tickingRuns: new Set(),
  heldEvents: new Map(),
};
// A hot-reloaded module can inherit a global created before these fields existed.
g.__recoveryaiTelephony.owners ??= new Map();
g.__recoveryaiTelephony.runTargets ??= new Map();
g.__recoveryaiTelephony.runTouchedAt ??= new Map();
g.__recoveryaiTelephony.predictiveSessions ??= new Map();
g.__recoveryaiTelephony.tickingRuns ??= new Set();
g.__recoveryaiTelephony.heldEvents ??= new Map();

const runs = g.__recoveryaiTelephony.runs;
const owners = g.__recoveryaiTelephony.owners;
const runTargets = g.__recoveryaiTelephony.runTargets;
const runTouchedAt = g.__recoveryaiTelephony.runTouchedAt;
const predictiveSessions = g.__recoveryaiTelephony.predictiveSessions;
const tickingRuns = g.__recoveryaiTelephony.tickingRuns;
const heldEvents = g.__recoveryaiTelephony.heldEvents;

/** Mark a run as being dialled for: events for it are held until finishDialling replays them. */
function beginDialling(runId: string): void {
  tickingRuns.add(runId);
  heldEvents.set(runId, []);
  diallingSince.set(runId, Date.now());
}

/** When each run's current dialling round began. A round still open after this long is taken as
 *  hung and released, so one stuck request can't stop a run dialling (2026-11-21). */
const diallingSince = new Map<string, number>();
const HUNG_ROUND_MS = 45_000;

/** Whether a dialling round is in progress for this run (releasing one that has hung). */
function isDialling(runId: string, run: DialerRun): boolean {
  if (!tickingRuns.has(runId)) return false;
  const since = diallingSince.get(runId) ?? 0;
  if (Date.now() - since < HUNG_ROUND_MS) return true;
  console.error(`[dialer] dialling round for ${runId} hung > ${HUNG_ROUND_MS / 1000} s; released`);
  finishDialling(runId, run);
  return false;
}

/** The dialling copy of a run with every event that arrived meanwhile applied to it. */
function finishDialling(runId: string, run: DialerRun): DialerRun {
  const held = heldEvents.get(runId) ?? [];
  heldEvents.delete(runId);
  tickingRuns.delete(runId);
  diallingSince.delete(runId);
  let next = run;
  for (const e of held) {
    if (e.type === "sms_status") continue;
    if (next.legs.some((l) => l.providerCallId === e.providerCallId))
      next = engine.applyLegEvent(next, e);
  }
  return next;
}
const pendingPredictiveLogouts = new Set<string>();

interface PredictiveSession {
  clientId: string;
  queue: string;
  /** Agent handles (SkyCRM extensions; phones on the sim) logged into `queue` for this run. */
  loggedIn: Set<string>;
  /** Calls placed so far — spreads the request extension round robin. */
  calls: number;
  /** Teammates the agent added to take borrowers waiting in the queue ("Send to a teammate").
   *  Kept apart from `loggedIn` so they never count as this run's agents (pacing, or a teammate's
   *  own run replacing this one); logged out with the rest when the run ends. */
  guests?: Set<string>;
}

// ─── Run retention ───────────────────────────────────────────────────────────────
// Runs used to live in `runs` until the process restarted, and every status event walked all of
// them — so with many companies dialing all day, each webhook got slower and memory only grew.
// A stopped run is kept briefly (a late hangup/recording event, the final poll); a run nobody has
// ticked for hours is one whose manager closed the tab without pressing stop.
const STOPPED_RUN_TTL_MS = 10 * 60_000;
const IDLE_RUN_TTL_MS = 2 * 60 * 60_000;
const SWEEP_EVERY_MS = 60_000;
let lastSweep = 0;

function saveRun(run: DialerRun): void {
  runs.set(run.id, run);
  runTouchedAt.set(run.id, Date.now());
}

function sweepRuns(now = Date.now()): void {
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [id, run] of runs) {
    const idle = now - (runTouchedAt.get(id) ?? run.startedAt);
    if ((!run.running && idle > STOPPED_RUN_TTL_MS) || idle > IDLE_RUN_TTL_MS) {
      runs.delete(id);
      runTouchedAt.delete(id);
      loggedLegs.delete(id);
      runTargets.delete(id);
      // Not endPredictiveSession() here: sweepRuns is reachable from ingestCallStatusEvent, a
      // plain export that ships in the browser bundle, and anything it references (the provider,
      // SkyCRM's API code) would ship with it. Server-function handlers drain this set instead.
      if (predictiveSessions.has(id)) pendingPredictiveLogouts.add(id);
    }
  }
}

/** Log out the queue sessions of runs evicted by sweepRuns. Call only from server-function
 *  handlers (stripped from the client bundle), never from a plain export. */
function drainPredictiveLogouts(): void {
  for (const id of pendingPredictiveLogouts) {
    pendingPredictiveLogouts.delete(id);
    void endPredictiveSession(id);
  }
}

/** Apply a provider event only to the runs holding that call, and return the ones it changed. */
function applyEventToRuns(event: TelephonyEvent): DialerRun[] {
  const changed: DialerRun[] = [];
  if (event.type === "sms_status") return changed;
  // A run being dialled for may not hold this call's leg yet (its copy is saved at the end).
  for (const id of tickingRuns) heldEvents.get(id)?.push(event);
  for (const [id, run] of runs) {
    if (!run.legs.some((l) => l.providerCallId === event.providerCallId)) continue;
    const next = engine.applyLegEvent(run, event);
    runs.set(id, next);
    changed.push(next);
  }
  return changed;
}

// ─── Authorization ───────────────────────────────────────────────────────────────
// TanStack server functions are ordinary HTTP endpoints whose ids ship in the client bundle, so
// "only our UI calls this" is not a defence. Every handler below starts with requireCaller().

const MAX_OWNERS = 20_000;
function rememberOwner(clientId: string, ...keys: Array<string | undefined>): void {
  if (owners.size > MAX_OWNERS) {
    for (const k of Array.from(owners.keys()).slice(0, 2000)) owners.delete(k);
  }
  for (const k of keys) if (k) owners.set(k, clientId);
}

function owns(caller: VerifiedCaller, key: string | undefined): boolean {
  return !!key && owners.get(key) === caller.clientId;
}

async function requireCaller(accessToken: unknown): Promise<VerifiedCaller> {
  if (typeof accessToken !== "string" || !accessToken) throw new Error("Not authenticated");
  const caller = await verifyCaller(accessToken);
  if (!caller) throw new Error("Not authenticated");
  return caller;
}

/** E.164-ish: optional +, 10–15 digits. Nothing else may reach the provider's dial API. */
function cleanNumber(raw: unknown, label: string): string {
  const s = typeof raw === "string" ? raw.replace(/[\s()-]/g, "") : "";
  if (!/^\+?\d{10,15}$/.test(s)) throw new Error(`${label} is not a valid phone number`);
  return s;
}

/** An agent is dialled by phone number, or by SkyCRM extension (3–6 digits) when they have no
 *  phone on file. Either way it must match the database (authorizeAgentNumbers). */
function cleanAgentNumber(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/[\s()-]/g, "") : "";
  if (/^\d{3,6}$/.test(s)) return s;
  return cleanNumber(s, "Agent number");
}

const sameNumber = (a: string, b: string) => a.replace(/\D/g, "") === b.replace(/\D/g, "");

/** Phones of active agents in the caller's own company, straight from the database. An agent
 *  number sent by the browser is only ever accepted if it is on this list. */
async function companyAgentPhones(caller: VerifiedCaller): Promise<DialAgent[]> {
  type Row = {
    id: string;
    agent_phone: string | null;
    agent_extension?: string | null;
    is_active: boolean | null;
  };
  const query = (cols: string) =>
    getSupabaseAdmin()
      .from("agents")
      .select(cols)
      .eq("client_id", caller.clientId) as unknown as Promise<{
      data: Row[] | null;
      error: { message?: string } | null;
    }>;
  let { data, error } = await query("id, agent_phone, agent_extension, is_active");
  // Deployed ahead of 20260926_skycrm_telephony.sql: no extension column yet.
  if (error && /agent_extension/.test(error.message ?? "")) {
    ({ data, error } = await query("id, agent_phone, is_active"));
  }
  if (error || !data) throw new Error("Could not verify the agent's phone number");
  return data
    .filter((a) => a.is_active !== false && (a.agent_phone?.trim() || a.agent_extension?.trim()))
    .map((a) => ({
      id: a.id,
      // No phone on file: the extension stands in, matching what auth.tsx gives the browser.
      phone: a.agent_phone?.trim() || a.agent_extension!.trim(),
      extension: a.agent_extension?.trim() || null,
    }));
}

/** The agent records behind already-authorized agent numbers, in the same order. */
async function dialAgentsFor(caller: VerifiedCaller, numbers: string[]): Promise<DialAgent[]> {
  const pool = await companyAgentPhones(caller);
  return numbers.flatMap((n) => pool.filter((p) => sameNumber(p.phone, n)).slice(0, 1));
}

/** Hang up through the provider with whatever it needs from the ledger, then close the ledger row. */
async function providerHangup(providerCallId: string): Promise<void> {
  const ledger = await ledgerByProviderCallId(providerCallId).catch(() => null);
  // Before the hangup request: the provider's final event can arrive while it is in flight.
  if (ledger && !ledger.ended_at) await updateLedger(ledger.id, { ended_by: "agent" });
  await getTelephonyProvider().hangup(providerCallId, {
    // A predictive call nobody has taken yet: the extension that was in the request.
    agentHandle: ledger?.agent_handle ?? ledger?.request_extension,
    prefix: await didPrefix(ledger?.did_id).catch(() => null),
    remotePhone: ledger?.remote_phone,
    direction: ledger?.direction,
  });
  if (ledger && !ledger.ended_at) {
    // `ledger` was read before the hangup. The provider's final event often lands while that
    // request is in flight, and overwriting it turned finished calls into "canceled".
    await updateLedgerIfOpen(ledger.id, {
      ended_at: new Date().toISOString(),
      status: "canceled",
    });
  }
}

/** Which of `numbers` the caller may ring. Agents: only their own number. Managers and admins:
 *  any active agent in the company (they run the shared dialer pool).
 *
 *  `filter` is for dialer runs: an agent's pool from the browser is themselves plus their manager
 *  (that is what RLS lets them see), so unauthorised entries are dropped instead of failing the
 *  whole run. Single calls use the default and reject anything that isn't allowed. */
async function authorizeAgentNumbers(
  caller: VerifiedCaller,
  numbers: string[],
  opts: { filter?: boolean } = {},
): Promise<string[]> {
  const pool = await companyAgentPhones(caller);
  const allowed = caller.role === "agent" ? pool.filter((p) => p.id === caller.agentId) : pool;
  const ok = (n: string) => allowed.some((p) => sameNumber(p.phone, n));
  if (opts.filter && caller.role === "agent") {
    const kept = numbers.filter(ok);
    if (numbers.length && !kept.length) throw new Error("Your own phone number is not set up");
    return kept;
  }
  for (const n of numbers) {
    if (!ok(n)) throw new Error("That agent number is not registered to your account");
  }
  return numbers;
}

/** Replace browser-supplied dial targets with what the database holds for those debtors.
 *  Unknown / other-company debtors are dropped, and phones are never taken from the request. */
async function resolveTargets(
  caller: VerifiedCaller,
  runId: string,
  targets: DialTarget[] | undefined,
): Promise<DialTarget[]> {
  if (!targets?.length) return [];
  let known = runTargets.get(runId);
  if (!known) {
    known = new Map();
    runTargets.set(runId, known);
  }
  const unknownIds = [...new Set(targets.map((t) => t.id))].filter(
    (id) => typeof id === "string" && !known!.has(id),
  );
  for (let i = 0; i < unknownIds.length; i += 150) {
    const chunk = unknownIds.slice(i, i + 150);
    const { data, error } = (await getSupabaseAdmin()
      .from("debtors")
      .select("id, phone_primary, alt_phones, portfolio_id")
      .eq("client_id", caller.clientId)
      .in("id", chunk)) as {
      data: Array<{
        id: string;
        phone_primary: string | null;
        alt_phones: string[] | null;
        portfolio_id: string | null;
      }> | null;
      error: unknown;
    };
    if (error) throw new Error("Could not verify the dial list");
    for (const row of data ?? []) {
      const phone = row.phone_primary?.replace(/[\s()-]/g, "") ?? "";
      if (!/^\+?\d{10,15}$/.test(phone)) continue;
      const src = targets.find((t) => t.id === row.id);
      known.set(row.id, {
        ...(src as DialTarget),
        phone,
        // From the database, not the request: it decides which numbers the call may go out on.
        portfolioId: row.portfolio_id ?? undefined,
        altPhones: (row.alt_phones ?? [])
          .map((p) => p.replace(/[\s()-]/g, ""))
          .filter((p) => /^\+?\d{10,15}$/.test(p)),
      });
    }
  }
  const resolved = targets.flatMap((t) => {
    const trusted = known!.get(t.id);
    return trusted
      ? [
          {
            ...t,
            phone: trusted.phone,
            altPhones: trusted.altPhones,
            portfolioId: trusted.portfolioId,
          },
        ]
      : [];
  });
  // Do-not-call numbers never enter the plan, so they can't occupy a slot every tick.
  // prepareCall re-checks each leg, which also catches numbers added mid-run.
  const blocked = await doNotCallSet(
    caller.clientId,
    resolved.flatMap((t) => [t.phone, ...(t.altPhones ?? [])]),
  );
  if (!blocked.size) return resolved;
  const allowed = (p: string) => !blocked.has(normalisePhone(p));
  return resolved.flatMap((t) => {
    const altPhones = (t.altPhones ?? []).filter(allowed);
    if (allowed(t.phone)) return [{ ...t, altPhones }];
    return altPhones.length ? [{ ...t, phone: altPhones[0], altPhones: altPhones.slice(1) }] : [];
  });
}

let subscribed = false;
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  // The provider pushes normalized events; route each to whichever run owns the leg.
  getTelephonyProvider().subscribe?.((event: TelephonyEvent) => {
    applyEventToRuns(event);
    if (event.type === "hangup")
      void closeLedgerFor(event.providerCallId, event.result, event.durationSeconds);
    // Real providers do this in reconcileWithLedger; pushed (sim) events land here instead.
    if (event.type === "answer" && event.agentHandle)
      void assignLedgerAgent(event.providerCallId, event.agentHandle);
  });
}

/** A predictive call was answered by `agentHandle`: put that agent on its ledger row. */
async function assignLedgerAgent(providerCallId: string, agentHandle: string): Promise<void> {
  const ledger = await ledgerByProviderCallId(providerCallId).catch(() => null);
  if (!ledger || !ledger.predictive_queue || ledger.agent_handle) return;
  const col = getTelephonyProvider().name === "skycrm" ? "agent_extension" : "agent_phone";
  const { data } = (await getSupabaseAdmin()
    .from("agents")
    .select("id")
    .eq("client_id", ledger.client_id)
    .eq(col, agentHandle)
    .limit(1)
    .maybeSingle()) as { data: { id: string } | null };
  await updateLedger(ledger.id, {
    agent_handle: agentHandle,
    answered_at: new Date().toISOString(),
    ...(data ? { agent_id: data.id } : {}),
  });
}

async function closeLedgerFor(
  providerCallId: string,
  status: string,
  durationSeconds?: number,
): Promise<void> {
  const ledger = await ledgerByProviderCallId(providerCallId).catch(() => null);
  if (!ledger || ledger.ended_at) return;
  await updateLedger(ledger.id, {
    ended_at: new Date().toISOString(),
    status,
    duration_seconds: durationSeconds ?? null,
  });
}

/** Release due simulated events (real providers push via the /api/telephony/webhook route instead). */
function flushSim(now = Date.now()): void {
  const prov = getTelephonyProvider();
  if ("flushDue" in prov) (prov as SimProvider).flushDue(now);
}

function ivrHint(settings: PortfolioSettings): boolean {
  return settings.callMode === "ivr_agent" || settings.callMode === "hybrid";
}

/** Agent legs currently tied up by a run, so one agent is never dialed twice at once. */
const busyAgents = g.__recoveryaiTelephony.busyAgents; // agentNumber → legId

function releaseAgentsForTerminalLegs(run: DialerRun): void {
  for (const leg of run.legs) {
    if (!isTerminal(leg.state)) continue;
    for (const [num, legId] of busyAgents) if (legId === leg.id) busyAgents.delete(num);
  }
}

/**
 * Open the planned legs and place each call through the provider, binding provider ids.
 *
 * IMPORTANT — why this caps out at one call per free agent, even in "predictive" mode:
 * click_to_call dials the AGENT first and bridges the debtor only once the agent answers,
 * so every open line permanently consumes an agent. Real predictive dialing (overdialing
 * 1.5-2x your agent count and connecting whoever picks up) requires dialing the debtor
 * first, which this endpoint cannot do — it needs the provider's own campaign dialer.
 * Opening more legs than we have free agents would just ring the same agent repeatedly,
 * so we stop when the pool is exhausted and report it via `unassigned`.
 *
 * Since 2026-11-17 "Productive Dial" uses predictiveDial() below instead whenever the provider
 * offers a borrower-first dial and the company has a predictive queue; this stays the fallback.
 */
async function dial(
  run: DialerRun,
  batch: DialTarget[],
  idPrefix: string,
  agentNumbers: string[],
  clientId: string,
  callerId: string | undefined,
  agents: DialAgent[],
): Promise<{ run: DialerRun; unassigned: number; blocked?: string }> {
  const prov = getTelephonyProvider();
  releaseAgentsForTerminalLegs(run);
  if (!batch.length) return { run, unassigned: 0 };

  const settings = await loadTelephonySettings(clientId);
  // Company-wide rules (enabled, calling window) are checked once, so a closed window doesn't
  // turn every planned debtor into a "failed" attempt.
  const pre = evaluateCall({
    settings,
    provider: prov.name,
    agentExtension: "-",
    onDoNotCall: false,
    now: new Date(),
  });
  if (!pre.ok) return { run, unassigned: batch.length, blocked: pre.message };

  const agentFor = (n: string) => agents.find((a) => sameNumber(a.phone, n));
  const free = agentNumbers.filter(
    (n) => !busyAgents.has(n) && (prov.name !== "skycrm" || !!agentFor(n)?.extension),
  );
  const { lines, atCompanyCeiling } = await channelsFor(clientId, settings);
  const assignable = batch.slice(0, Math.min(free.length, lines));
  if (lines < Math.min(free.length, batch.length)) {
    // Agents are free but there is no line for them: the number that says the share is too small.
    void recordRefusal(clientId, atCompanyCeiling ? "company_limit" : "platform_busy");
  }
  const unassigned = batch.length - assignable.length;
  if (!assignable.length) {
    return {
      run,
      unassigned,
      blocked: lines === 0 ? "All calling lines for your company are busy." : undefined,
    };
  }

  const { run: withLegs, opened } = engine.openLegs(run, assignable, { idPrefix });
  let next = withLegs;

  for (const [i, leg] of opened.entries()) {
    const agentNumber = free[i];
    const t = assignable.find((x) => x.id === leg.debtorId);
    let ledgerId = "";
    try {
      const agent = agentFor(agentNumber) ?? { id: "", phone: agentNumber, extension: null };
      const prepared = await prepareCall({
        clientId,
        provider: prov.name,
        agent,
        debtorPhone: leg.phone,
        refId: leg.id,
        settings,
        debtorId: leg.debtorId,
        portfolioId: t?.portfolioId,
        kind: "queue",
      });
      ledgerId = prepared.ledgerId;
      const { providerCallId } = await prov.startCall({
        agentNumber: prepared.agentHandle,
        debtorNumber: leg.phone,
        callerId: prepared.callerId,
        callerPrefix: prepared.callerPrefix,
        callLogId: leg.id,
        requestId: ledgerId || undefined,
        hints: {
          aiScore: t?.aiScore,
          bestContactTime: t?.bestContactTime,
          ivr: ivrHint(run.settings),
        },
      });
      busyAgents.set(agentNumber, leg.id);
      rememberOwner(clientId, providerCallId, leg.id);
      await updateLedger(ledgerId, { provider_call_id: providerCallId });
      next = engine.bindProviderCall(next, leg.id, providerCallId);
    } catch (err) {
      await updateLedger(ledgerId, {
        ended_at: new Date().toISOString(),
        status: "failed",
        vendor_events: `start refused: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          500,
        ),
      });
      // One debtor's number being unreachable must not abort the whole batch.
      console.error(
        `[dialer] startCall failed for leg ${leg.id}:`,
        err instanceof Error ? err.message : String(err),
      );
      next = engine.applyLegEvent(next, {
        type: "hangup",
        providerCallId: leg.id,
        at: Date.now(),
        result: "failed",
        durationSeconds: 0,
      });
    }
  }
  return { run: next, unassigned };
}

/** The handle the provider knows an agent by: SkyCRM extension, else phone (sim). Same rule as
 *  prepareCall's agentHandle. */
function agentHandleFor(provider: string, a: DialAgent): string | null {
  return provider === "skycrm" ? a.extension?.trim() || null : a.phone;
}

/** Log the run's agents into the predictive queue (only those not already in it). */
async function loginPredictiveAgents(
  session: PredictiveSession,
  agents: DialAgent[],
): Promise<string[]> {
  const prov = getTelephonyProvider();
  const handles = agents.map((a) => agentHandleFor(prov.name, a)).filter((h): h is string => !!h);
  for (const h of handles) {
    if (session.loggedIn.has(h)) continue;
    try {
      await prov.predictive!.loginQueue(h, session.queue);
      session.loggedIn.add(h);
    } catch (err) {
      console.warn(
        `[dialer] queue login failed for ${h}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return handles.filter((h) => session.loggedIn.has(h));
}

/** Take the run's agents back out of the predictive queue. Best-effort: a failure is logged. */
async function endPredictiveSession(runId: string): Promise<void> {
  const session = predictiveSessions.get(runId);
  if (!session) return;
  predictiveSessions.delete(runId);
  await logoutSession(session);
}

async function logoutSession(session: PredictiveSession): Promise<void> {
  const pd = getTelephonyProvider().predictive;
  if (!pd) return;
  for (const h of new Set([...session.loggedIn, ...(session.guests ?? [])])) {
    await pd
      .logoutQueue(h, session.queue)
      .catch((err: unknown) =>
        console.warn(
          `[dialer] queue logout failed for ${h}:`,
          err instanceof Error ? err.message : String(err),
        ),
      );
  }
}

/**
 * Vendor-side predictive dialling (SkyCRM §24): the provider dials the BORROWER first and puts
 * whoever answers through to a free extension in the queue, so lines are paced off free agents ×
 * pacing (predictiveBatchSize), not capped at one per agent like click-to-call (see dial()).
 * Every number still goes through prepareCall: do-not-call, IST window, channel reservation and a
 * ledger row before the vendor is called. The ledger row has no agent until the answer names one.
 */
async function predictiveDial(
  run: DialerRun,
  targets: DialTarget[],
  idPrefix: string,
  session: PredictiveSession,
  callerId: string | undefined,
  agents: DialAgent[],
  /** From the caller's own browser: seconds its phone has been out of a call (null = no phone). */
  idle?: { agentId: string | null; phoneIdleSeconds?: number | null },
): Promise<{ run: DialerRun; blocked?: string }> {
  const prov = getTelephonyProvider();
  const pd = prov.predictive;
  if (!pd) return { run, blocked: "Predictive calling isn't available on this calling service." };
  const now = new Date();
  if (!engine.withinTimeWindow(run.settings.rechurnTimeWindow, now)) return { run };

  const settings = await loadTelephonySettings(session.clientId);
  const pre = evaluateCall({
    settings,
    provider: prov.name,
    agentExtension: "-",
    onDoNotCall: false,
    now,
  });
  if (!pre.ok) return { run, blocked: pre.message };

  const inQueue = await loginPredictiveAgents(session, agents);
  if (!inQueue.length)
    return { run, blocked: "No agent with an extension could join the calling queue." };

  // Pace from the ledger, across every run on these agents — not this run's legs alone
  // (2026-11-21: five runs on one extension opened ~25 lines). Calls the vendor never
  // acknowledged are closed there and ended here.
  // The caller's own extension: only their own browser can say their phone is idle.
  const me = idle?.agentId ? agents.find((a) => a.id === idle.agentId) : undefined;
  const open = await openPredictiveCalls(session.clientId, inQueue, {
    handle: me ? agentHandleFor(prov.name, me) : null,
    phoneIdleSeconds: idle?.phoneIdleSeconds,
  });
  const endLegs = (refIds: string[], result: "no_answer" | "completed") => {
    const ids = new Set(refIds);
    for (const leg of run.legs) {
      if (!ids.has(leg.id) || isTerminal(leg.state)) continue;
      run = engine.applyLegEvent(
        leg.providerCallId ? run : engine.bindProviderCall(run, leg.id, leg.id),
        {
          type: "hangup",
          providerCallId: leg.providerCallId ?? leg.id,
          at: Date.now(),
          result,
          durationSeconds: 0,
        },
      );
    }
  };
  if (open.silentRefIds.length) endLegs(open.silentRefIds, "no_answer");
  if (open.endedConnectedRefIds.length) endLegs(open.endedConnectedRefIds, "completed");
  // Borrowers who picked up and wait in SkyCRM's queue: shown to the agent as "Waiting for you".
  if (open.queuedRefIds.length) {
    const queued = new Set(open.queuedRefIds);
    const at = Date.now();
    run = {
      ...run,
      legs: run.legs.map((l) =>
        queued.has(l.id) && !l.waitingSince && !l.agentHandle && !isTerminal(l.state)
          ? { ...l, waitingSince: at }
          : l,
      ),
    };
  }
  const busy = new Set(open.busy);
  const free = freeAgentHandles(inQueue, run.legs).filter((h) => !busy.has(h));
  const dialed = new Set(run.legs.map((l) => l.debtorId));
  const remaining = targets.filter((t) => !dialed.has(t.id));
  const { lines, atCompanyCeiling } = await channelsFor(session.clientId, settings);
  const n = predictiveBatchSize({
    freeAgents: free.length,
    pending: open.ok ? Math.max(open.waiting, pendingLegs(run.legs)) : pendingLegs(run.legs),
    linesPerAgent: linesPerAgent(run.settings),
    callsPerCycle: run.settings.callsPerCycle,
    lines,
    remaining: remaining.length,
  });
  if (lines === 0 && free.length && remaining.length) {
    void recordRefusal(session.clientId, atCompanyCeiling ? "company_limit" : "platform_busy");
    return { run, blocked: "All calling lines for your company are busy." };
  }
  if (!n) return { run };

  const batch = remaining.slice(0, n);
  const { run: withLegs, opened } = engine.openLegs(run, batch, { idPrefix, vendorRouted: true });
  // All of a round's calls are placed AT ONCE (2026-11-21). One after another, each SkyCRM
  // request taking ~3 s, a round of 5 took ~15 s: the borrowers rang 3 s apart and nothing new
  // reached the agent's screen until the round was done. The channel reservation is still
  // serialised by the database (advisory lock), so lines can't be over-booked.
  const placed = await Promise.all(
    opened.map(async (leg) => {
      const t = batch.find((x) => x.id === leg.debtorId);
      const handle = requestExtension(free, inQueue, session.calls++) as string;
      const agent = agents.find((a) => agentHandleFor(prov.name, a) === handle) ?? {
        id: "",
        phone: handle,
        extension: prov.name === "skycrm" ? handle : null,
      };
      let ledgerId = "";
      try {
        const prepared = await prepareCall({
          clientId: session.clientId,
          provider: prov.name,
          agent,
          debtorPhone: leg.phone,
          refId: leg.id,
          settings,
          debtorId: leg.debtorId,
          portfolioId: t?.portfolioId,
          kind: "queue",
          predictive: { queue: session.queue },
        });
        ledgerId = prepared.ledgerId;
        const { providerCallId } = await pd.startCall({
          extension: prepared.agentHandle,
          queue: session.queue,
          debtorNumber: leg.phone,
          requestId: ledgerId,
          callerId: prepared.callerId,
          callerPrefix: prepared.callerPrefix,
          hints: { aiScore: t?.aiScore, bestContactTime: t?.bestContactTime },
        });
        rememberOwner(session.clientId, providerCallId, leg.id);
        await updateLedger(ledgerId, { provider_call_id: providerCallId });
        return { legId: leg.id, providerCallId };
      } catch (err) {
        await updateLedger(ledgerId, {
          ended_at: new Date().toISOString(),
          status: "failed",
          vendor_events: `start refused: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            500,
          ),
        });
        console.error(
          `[dialer] predictive_call failed for leg ${leg.id}:`,
          err instanceof Error ? err.message : String(err),
        );
        return { legId: leg.id, providerCallId: null };
      }
    }),
  );
  let next = withLegs;
  for (const p of placed) {
    if (p.providerCallId) {
      next = engine.bindProviderCall(next, p.legId, p.providerCallId);
      continue;
    }
    next = engine.applyLegEvent(engine.bindProviderCall(next, p.legId, p.legId), {
      type: "hangup",
      providerCallId: p.legId,
      at: Date.now(),
      result: "failed",
      durationSeconds: 0,
    });
  }
  return { run: next };
}

// ─── AI/IVR leg persistence ──────────────────────────────────────────────────────
// AI- and IVR-handled legs (no human agent) should be logged to call_logs — agent legs are
// logged when the agent submits a disposition. Detection is wired below; the durable write is
// a no-op stub for now: a background process has no user session for RLS, so a real write
// needs a service-role Supabase client (Phase 2), and we must never write SIMULATED calls into
// the audit trail. The intended row shape is disposition-store.saveCallLog.
const loggedLegs = g.__recoveryaiTelephony.loggedLegs; // runId → leg ids already handled

async function persistLegLog(log: LegCallLog): Promise<void> {
  // TODO(phase-2): insert via a service-role client — see disposition-store.saveCallLog.
  void log;
}

async function persistLoggableLegs(run: DialerRun): Promise<void> {
  let seen = loggedLegs.get(run.id);
  if (!seen) {
    seen = new Set();
    loggedLegs.set(run.id, seen);
  }
  for (const { leg, log } of collectLoggableLegs(run.legs, seen)) {
    seen.add(leg.id);
    await persistLegLog(log);
  }
}

// ─── Dialer run lifecycle ────────────────────────────────────────────────────────

export const startDialerRun = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      accessToken: string;
      runId: string;
      settings: PortfolioSettings;
      targets: DialTarget[];
      agentsAvailable: number;
      /** Phone numbers of the agents on shift. With click_to_call these are the legs the
       * provider rings first, so the pool size is the real concurrency ceiling. */
      agentNumbers?: string[];
      /** DID shown to the debtor. Must be a caller ID assigned to the provider account. */
      callerId?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    enforceRateLimit(`dialer-run:${caller.authUserId}`, 10, 60_000);
    await assertMayDial(caller);
    if (typeof data.runId !== "string" || !data.runId) throw new Error("Missing runId");
    // A run id another company already owns must never be overwritten by a guessed one.
    if (owners.has(`run:${data.runId}`) && !owns(caller, `run:${data.runId}`)) {
      throw new Error("That dialer run belongs to another organisation");
    }

    ensureSubscribed();
    const agentNumbers = await authorizeAgentNumbers(caller, data.agentNumbers ?? [], {
      filter: true,
    });
    const targets = await resolveTargets(caller, data.runId, data.targets);
    const agents = await dialAgentsFor(caller, agentNumbers);
    rememberOwner(caller.clientId, `run:${data.runId}`);

    const base = engine.newDialerRun({ id: data.runId, settings: data.settings });

    // "Productive Dial" (dialerMode "predictive") uses the provider's own predictive dial when it
    // has one and the company has a queue for it; otherwise click-to-call as before.
    const prov = getTelephonyProvider();
    const routing = predictiveMode({
      dialerMode: data.settings.dialerMode,
      provider: prov.name,
      providerSupportsPredictive: !!prov.predictive,
      predictiveQueue: (await loadTelephonySettings(caller.clientId))?.predictive_queue,
    });
    if (routing.mode === "vendor") {
      await endPredictiveSession(data.runId);
      // One run per agent: a second Start on the same agents replaces the earlier run instead of
      // dialling beside it (2026-11-21, five runs on ext 8603). Its open calls still count in the
      // new run's pacing through the ledger.
      const handles = agents
        .map((a) => agentHandleFor(prov.name, a))
        .filter((h): h is string => !!h);
      const older = runsSharingAgents(
        [...predictiveSessions].map(([runId, s]) => ({
          runId,
          clientId: s.clientId,
          handles: [...s.loggedIn],
        })),
        { runId: data.runId, clientId: caller.clientId, handles },
      );
      for (const id of older) {
        const other = runs.get(id);
        const s = predictiveSessions.get(id);
        predictiveSessions.delete(id);
        // Agents the new run also has stay in the queue (it logs them in again); the rest leave.
        const leaving = [...(s?.loggedIn ?? [])].filter((h) => !handles.includes(h));
        if (s && leaving.length) await logoutSession({ ...s, loggedIn: new Set(leaving) });
        if (other?.running) {
          const stopped = engine.stopDialerRun(other);
          await persistLoggableLegs(stopped);
          saveRun(stopped);
        }
      }
      const session: PredictiveSession = {
        clientId: caller.clientId,
        queue: routing.queue,
        loggedIn: new Set(),
        calls: 0,
      };
      predictiveSessions.set(data.runId, session);
      beginDialling(data.runId);
      let res: Awaited<ReturnType<typeof predictiveDial>>;
      try {
        res = await predictiveDial(base, targets, data.runId, session, data.callerId, agents, {
          agentId: caller.agentId,
        });
      } catch (err) {
        finishDialling(data.runId, base);
        throw err;
      }
      const started = finishDialling(data.runId, res.run);
      if (res.blocked && !started.legs.length) {
        await endPredictiveSession(data.runId);
        throw new Error(res.blocked);
      }
      sweepRuns();
      drainPredictiveLogouts();
      saveRun(started);
      return started;
    }

    const batch =
      data.settings.dialerMode === "productive"
        ? engine.planProductiveBatch(targets, [])
        : engine.planDialBatch({
            settings: data.settings,
            queue: targets,
            agentsAvailable: Math.min(
              data.agentsAvailable,
              agentNumbers.length || data.agentsAvailable,
            ),
            inFlight: 0,
          });
    const { run, unassigned, blocked } = await dial(
      base,
      batch,
      data.runId,
      agentNumbers,
      caller.clientId,
      data.callerId,
      agents,
    );
    if (blocked && !run.legs.length) throw new Error(blocked);
    if (unassigned > 0) {
      console.warn(`[dialer] ${unassigned} target(s) not dialed — no free agent leg available`);
    }
    sweepRuns();
    drainPredictiveLogouts();
    saveRun(run);
    return run;
  });

export const tickDialerRun = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      accessToken: string;
      runId: string;
      agentsAvailable: number;
      targets?: DialTarget[];
      agentNumbers?: string[];
      callerId?: string;
      /** Seconds the caller's browser phone has been out of a call; absent without one. */
      phoneIdleSeconds?: number | null;
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!owns(caller, `run:${data.runId}`)) return null;

    ensureSubscribed();
    flushSim(); // advance the simulated carrier; subscription mutates runs in place
    const run = runs.get(data.runId);
    if (!run) return null;

    // The tick only REPORTS the run; any dialling runs in the background (2026-11-21). It used
    // to answer only after placing the round's calls, so the agent's screen learned of an
    // answered call 5–15 s late, or after the borrower had already hung up. One dialling round
    // per run at a time (tickingRuns); events meanwhile are held and replayed (heldEvents).
    if (!isDialling(data.runId, run) && run.running && data.targets?.length) {
      beginDialling(data.runId);
      void topUpRun(caller, data, run).catch((err: unknown) => {
        console.error(
          `[dialer] top-up failed for ${data.runId}:`,
          err instanceof Error ? err.message : String(err),
        );
        finishDialling(data.runId, run);
      });
    }
    await persistLoggableLegs(run); // log any AI/IVR legs that just went terminal
    return run;
  });

/** One dialling round for a run, in the background of a tick. Saves the run when done. */
async function topUpRun(
  caller: VerifiedCaller,
  data: {
    runId: string;
    agentsAvailable: number;
    targets?: DialTarget[];
    agentNumbers?: string[];
    callerId?: string;
    phoneIdleSeconds?: number | null;
  },
  start: DialerRun,
): Promise<void> {
  let run = start;
  const agentNumbers = await authorizeAgentNumbers(caller, data.agentNumbers ?? [], {
    filter: true,
  });
  const targets = await resolveTargets(caller, data.runId, data.targets ?? []);
  const agents = await dialAgentsFor(caller, agentNumbers);
  // Productive needs the full leg history to decide "primary vs next alt number vs next
  // debtor" — it can't be reduced to a per-debtor dialed/not-dialed set the way the other
  // modes can, so it gets the whole target list every tick instead of `remaining`.
  const session = predictiveSessions.get(data.runId);
  let batch: DialTarget[];
  if (session) {
    run = (
      await predictiveDial(run, targets, data.runId, session, data.callerId, agents, {
        agentId: caller.agentId,
        phoneIdleSeconds: data.phoneIdleSeconds,
      })
    ).run;
    batch = [];
  } else if (run.settings.dialerMode === "productive") {
    batch = engine.planProductiveBatch(targets, run.legs);
  } else {
    const inFlight = run.legs.filter((l) => !isTerminal(l.state)).length;
    const dialed = new Set(run.legs.map((l) => l.debtorId));
    const remaining = targets.filter((t) => !dialed.has(t.id));
    batch = engine.planDialBatch({
      settings: run.settings,
      queue: remaining,
      agentsAvailable: Math.min(data.agentsAvailable, agentNumbers.length || data.agentsAvailable),
      inFlight,
    });
  }
  if (batch.length) {
    const res = await dial(
      run,
      batch,
      data.runId,
      agentNumbers,
      caller.clientId,
      data.callerId,
      agents,
    );
    run = res.run;
  }
  run = finishDialling(data.runId, run);
  // Stopped (or replaced by a newer run) while this round was dialling: don't bring it back.
  const latest = runs.get(data.runId);
  if (latest && !latest.running && run.running) return;
  await persistLoggableLegs(run);
  saveRun(run);
}

export const stopDialerRun = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; runId: string }) => d)
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!owns(caller, `run:${data.runId}`)) return null;
    const run = runs.get(data.runId);
    if (!run) return null;
    const prov = getTelephonyProvider();
    for (const leg of run.legs) {
      if (!isTerminal(leg.state) && leg.providerCallId) await providerHangup(leg.providerCallId);
    }
    await endPredictiveSession(data.runId);
    const stopped = engine.stopDialerRun(run);
    await persistLoggableLegs(stopped);
    loggedLegs.delete(data.runId);
    runTargets.delete(data.runId);
    saveRun(stopped);
    return stopped;
  });

// ─── Borrowers waiting in the queue: send them to a teammate (2026-11-21) ────────────────────
// SkyCRM gives a borrower who picked up to the next free extension in the queue; it cannot be
// told to give a particular borrower to a particular person. "Send to a teammate" therefore adds
// the teammate's extension to this run's queue: SkyCRM then puts the longest-waiting borrower
// through to them. Only the caller's own team (teams they are on, or manage).

export interface QueueTeammate {
  id: string;
  name: string;
  extension: string;
  /** Latest presence from agent_status_log (available, break, …); null if never set. */
  status: string | null;
  /** On a call right now (an open ledger row on their extension). */
  onCall: boolean;
}

async function teammatesOf(caller: VerifiedCaller): Promise<QueueTeammate[]> {
  if (!caller.agentId) return [];
  // Tables read here aren't all in the generated types' join shapes; plain reads only.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = getSupabaseAdmin() as any;
  const [{ data: onTeams }, { data: managed }] = await Promise.all([
    sb.from("team_agents").select("team_id").eq("agent_id", caller.agentId),
    sb.from("teams").select("id").eq("manager_id", caller.agentId),
  ]);
  const teamIds = [
    ...new Set([
      ...((onTeams ?? []) as { team_id: string }[]).map((r) => r.team_id),
      ...((managed ?? []) as { id: string }[]).map((r) => r.id),
    ]),
  ];
  if (!teamIds.length) return [];
  const { data: members } = await sb.from("team_agents").select("agent_id").in("team_id", teamIds);
  const ids = [
    ...new Set(((members ?? []) as { agent_id: string }[]).map((r) => r.agent_id)),
  ].filter((id) => id !== caller.agentId);
  if (!ids.length) return [];
  const { data: agents } = await sb
    .from("agents")
    .select("id, name, agent_extension")
    .eq("client_id", caller.clientId)
    .eq("is_active", true)
    .not("agent_extension", "is", null)
    .in("id", ids);
  const rows = (agents ?? []) as { id: string; name: string; agent_extension: string }[];
  if (!rows.length) return [];
  const since = new Date(Date.now() - STALE_CALL_MINUTES * 60_000).toISOString();
  const [{ data: statuses }, { data: open }] = await Promise.all([
    sb
      .from("agent_status_log")
      .select("agent_id, status")
      .in(
        "agent_id",
        rows.map((r) => r.id),
      )
      .is("ended_at", null),
    sb
      .from("telephony_calls")
      .select("agent_handle")
      .eq("client_id", caller.clientId)
      .is("ended_at", null)
      .gt("started_at", since)
      .in(
        "agent_handle",
        rows.map((r) => r.agent_extension),
      ),
  ]);
  const statusOf = new Map(
    ((statuses ?? []) as { agent_id: string; status: string }[]).map((s) => [s.agent_id, s.status]),
  );
  const busy = new Set(((open ?? []) as { agent_handle: string }[]).map((r) => r.agent_handle));
  return rows
    .map((r) => ({
      id: r.id,
      name: r.name,
      extension: r.agent_extension,
      status: statusOf.get(r.id) ?? null,
      onCall: busy.has(r.agent_extension),
    }))
    .sort((a, b) => Number(a.onCall) - Number(b.onCall) || a.name.localeCompare(b.name));
}

export const listQueueTeammates = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string }) => d)
  .handler(async ({ data }) => teammatesOf(await requireCaller(data.accessToken)));

export const sendWaitingToTeammate = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; runId: string; agentId: string }) => d)
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!owns(caller, `run:${data.runId}`)) throw new Error("This dialer run isn't yours.");
    const session = predictiveSessions.get(data.runId);
    const pd = getTelephonyProvider().predictive;
    if (!session || !pd) throw new Error("Only works while Productive Dial is running.");
    const mate = (await teammatesOf(caller)).find((t) => t.id === data.agentId);
    if (!mate) throw new Error("That person isn't on your team or has no calling extension.");
    await pd.loginQueue(mate.extension, session.queue);
    (session.guests ??= new Set()).add(mate.extension);
    return { name: mate.name, extension: mate.extension };
  });

// Ends one connected/ringing leg without touching the rest of the run — stopDialerRun above
// only ever stops everything. The Live Calls panel had no way to hang up a single predictively-
// dialed connected call before this: LiveCallsPanel's Take/Forward buttons are gated on
// `incoming`, which real dialer legs never set (only the synthetic AI-handoff demo does), so a
// connected leg from an actual predictive dialer run just sat there with no end-call control at
// all. Synthesizes the same "hangup" TelephonyEvent a real provider webhook would send, so this
// leg advances through the exact same state machine (and gets logged via persistLoggableLegs)
// a natural hangup would.
export const hangupDialerLeg = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; runId: string; legId: string }) => d)
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!owns(caller, `run:${data.runId}`)) return null;
    const run = runs.get(data.runId);
    if (!run) return null;
    const leg = run.legs.find((l) => l.id === data.legId);
    if (!leg || isTerminal(leg.state) || !leg.providerCallId) return run;

    await providerHangup(leg.providerCallId);

    const now = Date.now();
    const durationSeconds = leg.connectedAt ? Math.round((now - leg.connectedAt) / 1000) : 0;
    const updated = engine.applyLegEvent(run, {
      type: "hangup",
      providerCallId: leg.providerCallId,
      at: now,
      // call-machine.ts always resolves a connected/wrapup leg to "completed" regardless of
      // this value — it only matters for a leg ended before it ever connected (still ringing).
      result: leg.connectedAt ? "completed" : "canceled",
      durationSeconds,
    });
    await persistLoggableLegs(updated);
    saveRun(updated);
    return updated;
  });

// ─── Single-call + SMS wrappers ──────────────────────────────────────────────────

/** For a single call, callLogId is the debtor's id (manual dials off-queue send something else).
 *  Only a debtor of the caller's own company counts. */
async function debtorForCall(
  clientId: string,
  callLogId: string,
): Promise<{ id: string; portfolio_id: string | null } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(callLogId)) return null;
  const { data } = (await getSupabaseAdmin()
    .from("debtors")
    .select("id, portfolio_id")
    .eq("client_id", clientId)
    .eq("id", callLogId)
    .maybeSingle()) as { data: { id: string; portfolio_id: string | null } | null };
  return data ?? null;
}

export const startCall = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      accessToken: string;
      callLogId: string;
      agentNumber: string;
      debtorNumber: string;
      callerId?: string;
      aiScore?: number;
      ivr?: boolean;
      /** Placed from the Manual Dial dock: goes out on the admin's Manual Dial numbers, even when
       *  a loan ID ties it to an account. Otherwise an account's call uses its portfolio's numbers. */
      manual?: boolean;
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data?.accessToken);
    // A real call costs money and rings real phones; 30/min per user is well above any human.
    enforceRateLimit(`start-call:${caller.authUserId}`, 30, 60_000);
    await assertMayDial(caller);

    const agentNumber = cleanAgentNumber(data.agentNumber);
    const debtorNumber = cleanNumber(data.debtorNumber, "Debtor number");
    if (typeof data.callLogId !== "string" || !data.callLogId) throw new Error("Missing callLogId");
    await authorizeAgentNumbers(caller, [agentNumber]);
    const [agent] = await dialAgentsFor(caller, [agentNumber]);
    const prov = getTelephonyProvider();
    const requestedCallerId = typeof data.callerId === "string" ? data.callerId : undefined;
    const debtor = await debtorForCall(caller.clientId, data.callLogId);
    // A call with no account behind it can only be a Manual Dial call.
    const kind = data.manual === true || !debtor ? "manual" : "queue";
    const { ledgerId, agentHandle, callerId, callerPrefix } = await prepareCall({
      clientId: caller.clientId,
      provider: prov.name,
      agent: agent ?? { id: "", phone: agentNumber, extension: null },
      debtorPhone: debtorNumber,
      refId: data.callLogId,
      debtorId: debtor?.id,
      portfolioId: debtor?.portfolio_id,
      // Only Manual Dial lets the caller pick a number; queue calls rotate.
      requestedCallerId: kind === "manual" ? requestedCallerId : undefined,
      kind,
    });

    ensureSubscribed();
    let providerCallId: string;
    try {
      ({ providerCallId } = await prov.startCall({
        agentNumber: agentHandle,
        debtorNumber,
        callerId,
        callerPrefix,
        callLogId: data.callLogId,
        requestId: ledgerId || undefined,
        hints: { aiScore: data.aiScore, ivr: data.ivr },
      }));
    } catch (err) {
      // Keep SkyCRM's own reason: without it a refused dial is just "failed" in the ledger.
      await updateLedger(ledgerId, {
        ended_at: new Date().toISOString(),
        status: "failed",
        vendor_events: `start refused: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          500,
        ),
      });
      throw err;
    }
    await updateLedger(ledgerId, { provider_call_id: providerCallId });
    rememberOwner(caller.clientId, providerCallId, data.callLogId);
    return { providerCallId };
  });

/**
 * Recordings SamvadX has already imported for calls the caller's company logged, as
 * providerCallId → marker ("samvadx-recording:<ledger id>", played via getRecordingPlayUrl).
 * The importer (recordings.server.ts) links call logs that exist when the file arrives; this
 * catches call logs saved AFTER that. Only this company's ledger rows are ever returned.
 */
export const fetchRecordings = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; providerCallIds: string[] }) => d)
  .handler(async ({ data }) => {
    const caller = await requireCaller(data?.accessToken);
    const ids = Array.isArray(data.providerCallIds)
      ? data.providerCallIds.filter((x) => typeof x === "string" && x.length <= 100).slice(0, 500)
      : [];
    const out: Record<string, string> = {};
    if (!ids.length) return out;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ledger columns not in generated types
    const { data: rows } = await (getSupabaseAdmin() as any)
      .from("telephony_calls")
      .select("id, provider_call_id")
      .eq("client_id", caller.clientId)
      .eq("recording_status", "stored")
      .in("provider_call_id", ids);
    for (const r of (rows ?? []) as { id: string; provider_call_id: string }[]) {
      out[r.provider_call_id] = `samvadx-recording:${r.id}`;
    }
    return out;
  });

export const hangupCall = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; providerCallId: string }) => d)
  .handler(async ({ data }) => {
    const caller = await requireCaller(data?.accessToken);
    // Only the company that placed a call may end it.
    if (!owns(caller, data.providerCallId)) throw new Error("Call not found");
    await providerHangup(data.providerCallId);
    return { ok: true };
  });

export const sendSms = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { accessToken: string; to: string; templateId: string; templateParams: string[] }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data?.accessToken);
    enforceRateLimit(`send-sms:${caller.authUserId}`, 20, 60_000);
    const to = cleanNumber(data.to, "Recipient number");
    if (typeof data.templateId !== "string" || !data.templateId)
      throw new Error("Missing templateId");
    if (!Array.isArray(data.templateParams) || data.templateParams.length > 20) {
      throw new Error("Invalid template parameters");
    }
    return getTelephonyProvider().sendSms({
      to,
      templateId: data.templateId,
      templateParams: data.templateParams.map((p) => String(p).slice(0, 1000)),
    });
  });

// ─── Webhook ingest ──────────────────────────────────────────────────────────────
// A real provider POSTs status callbacks to a public HTTP endpoint; that endpoint (added
// when the real provider lands — this version of TanStack Start has no stable server-route
// file convention) forwards the raw body here. Parsing + state transition + fan-out are
// identical to the sim path, so nothing downstream changes when SIP is integrated.

// Core logic: convert CallStatusEvent to TelephonyEvent and apply to all runs.
// Used by both webhook handler and polling job.
// Latest status per call, keyed by BOTH the provider's call id and our own custom identifier
// (they differ — Tata hands back a ref_id at dial time but reports a uuid on the webhook).
// A single agent-initiated call has no DialerRun to live in, so this is how the browser
// polling `getCallStatus` learns the call was answered or dropped.
const latestStatus = g.__recoveryaiTelephony.latestStatus;
const MAX_TRACKED_STATUSES = 1000;

function rememberStatus(status: CallStatusEvent): void {
  if (latestStatus.size > MAX_TRACKED_STATUSES) {
    for (const k of Array.from(latestStatus.keys()).slice(0, 100)) latestStatus.delete(k);
  }
  latestStatus.set(status.providerCallId, status);
  if (status.customIdentifier) latestStatus.set(status.customIdentifier, status);
}

export const getCallStatus = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; keys: string[] }) => d)
  .handler(async ({ data }) => {
    const caller = await requireCaller(data?.accessToken);
    if (!Array.isArray(data.keys) || data.keys.length > 10) throw new Error("Invalid keys");
    for (const key of data.keys) {
      // Only statuses for calls this company started — call ids alone must not be a password.
      if (!owns(caller, key)) continue;
      const hit = latestStatus.get(key);
      if (hit) {
        console.log(`[telephony] getCallStatus hit ${key} -> ${hit.status}`);
        return hit;
      }
    }
    // Logged so a "stuck on ringing" report can be told apart at a glance: an empty store
    // means no webhook ever landed in THIS process, whereas a populated one means the keys
    // simply don't match. Sizes only — call ids are not written to logs.
    console.log(`[telephony] getCallStatus miss — store holds ${latestStatus.size} entries`);
    return null;
  });

/** `status` must already be keyed by our providerCallId (webhook-reconcile.server.ts does that for
 *  SkyCRM). Keep this function free of provider/database imports: it is exported from a module
 *  the browser also imports, and anything it references ships in the client bundle. */
export async function ingestCallStatusEvent(
  status: CallStatusEvent,
  ownerClientId?: string,
): Promise<void> {
  if (ownerClientId) rememberOwner(ownerClientId, status.providerCallId);
  rememberStatus(status);
  const at = Date.now();
  let event: TelephonyEvent;
  if (status.status === "ringing") {
    event = { type: "ring", providerCallId: status.providerCallId, at };
  } else if (status.status === "connected") {
    event = {
      type: "answer",
      providerCallId: status.providerCallId,
      at,
      ...(status.agentHandle ? { agentHandle: status.agentHandle } : {}),
    };
  } else {
    event = {
      type: "hangup",
      providerCallId: status.providerCallId,
      at,
      result:
        status.status === "completed"
          ? "completed"
          : status.status === "failed"
            ? "failed"
            : status.status === "busy"
              ? "busy"
              : "no_answer",
      durationSeconds: status.durationSeconds ?? 0,
    };
  }
  sweepRuns();
  // Only the runs holding this call can change, so only they need re-checking for loggable legs.
  const touched = new Map(applyEventToRuns(event).map((r) => [r.id, r]));
  if (status.recordingUrl) {
    const rec: TelephonyEvent = {
      type: "recording",
      providerCallId: status.providerCallId,
      at,
      recordingUrl: status.recordingUrl,
    };
    for (const r of applyEventToRuns(rec)) touched.set(r.id, r);
  }
  for (const run of touched.values()) await persistLoggableLegs(run);
}
