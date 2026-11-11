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
  ledgerByProviderCallId,
  loadTelephonySettings,
  prepareCall,
  channelsFor,
  recordRefusal,
  updateLedger,
  updateLedgerIfOpen,
  type DialAgent,
} from "./guard.server";
import { evaluateCall, normalisePhone } from "./guard-rules";

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
};
// A hot-reloaded module can inherit a global created before these fields existed.
g.__recoveryaiTelephony.owners ??= new Map();
g.__recoveryaiTelephony.runTargets ??= new Map();
g.__recoveryaiTelephony.runTouchedAt ??= new Map();

const runs = g.__recoveryaiTelephony.runs;
const owners = g.__recoveryaiTelephony.owners;
const runTargets = g.__recoveryaiTelephony.runTargets;
const runTouchedAt = g.__recoveryaiTelephony.runTouchedAt;

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
    }
  }
}

/** Apply a provider event only to the runs holding that call, and return the ones it changed. */
function applyEventToRuns(event: TelephonyEvent): DialerRun[] {
  const changed: DialerRun[] = [];
  if (event.type === "sms_status") return changed;
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
    agentHandle: ledger?.agent_handle,
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
        requestedCallerId: callerId,
      });
      ledgerId = prepared.ledgerId;
      const { providerCallId } = await prov.startCall({
        agentNumber: prepared.agentHandle,
        debtorNumber: leg.phone,
        callerId: prepared.callerId ?? callerId,
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
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data.accessToken);
    if (!owns(caller, `run:${data.runId}`)) return null;

    ensureSubscribed();
    flushSim(); // advance the simulated carrier; subscription mutates runs in place
    let run = runs.get(data.runId);
    if (!run) return null;

    // Continuous dialing: top up capacity with debtors not yet dialed.
    if (run.running && data.targets?.length) {
      const agentNumbers = await authorizeAgentNumbers(caller, data.agentNumbers ?? [], {
        filter: true,
      });
      const targets = await resolveTargets(caller, data.runId, data.targets);
      const agents = await dialAgentsFor(caller, agentNumbers);
      // Productive needs the full leg history to decide "primary vs next alt number vs next
      // debtor" — it can't be reduced to a per-debtor dialed/not-dialed set the way the other
      // modes can, so it gets the whole target list every tick instead of `remaining`.
      let batch: DialTarget[];
      if (run.settings.dialerMode === "productive") {
        batch = engine.planProductiveBatch(targets, run.legs);
      } else {
        const inFlight = run.legs.filter((l) => !isTerminal(l.state)).length;
        const dialed = new Set(run.legs.map((l) => l.debtorId));
        const remaining = targets.filter((t) => !dialed.has(t.id));
        batch = engine.planDialBatch({
          settings: run.settings,
          queue: remaining,
          agentsAvailable: Math.min(
            data.agentsAvailable,
            agentNumbers.length || data.agentsAvailable,
          ),
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
    }

    await persistLoggableLegs(run); // log any AI/IVR legs that just went terminal
    saveRun(run);
    return run;
  });

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
    const stopped = engine.stopDialerRun(run);
    await persistLoggableLegs(stopped);
    loggedLegs.delete(data.runId);
    runTargets.delete(data.runId);
    saveRun(stopped);
    return stopped;
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
    }) => d,
  )
  .handler(async ({ data }) => {
    const caller = await requireCaller(data?.accessToken);
    // A real call costs money and rings real phones; 30/min per user is well above any human.
    enforceRateLimit(`start-call:${caller.authUserId}`, 30, 60_000);

    const agentNumber = cleanAgentNumber(data.agentNumber);
    const debtorNumber = cleanNumber(data.debtorNumber, "Debtor number");
    if (typeof data.callLogId !== "string" || !data.callLogId) throw new Error("Missing callLogId");
    await authorizeAgentNumbers(caller, [agentNumber]);
    const [agent] = await dialAgentsFor(caller, [agentNumber]);
    const prov = getTelephonyProvider();
    const requestedCallerId = typeof data.callerId === "string" ? data.callerId : undefined;
    const debtor = await debtorForCall(caller.clientId, data.callLogId);
    const { ledgerId, agentHandle, callerId } = await prepareCall({
      clientId: caller.clientId,
      provider: prov.name,
      agent: agent ?? { id: "", phone: agentNumber, extension: null },
      debtorPhone: debtorNumber,
      refId: data.callLogId,
      debtorId: debtor?.id,
      portfolioId: debtor?.portfolio_id,
      requestedCallerId,
    });

    ensureSubscribed();
    let providerCallId: string;
    try {
      ({ providerCallId } = await prov.startCall({
        agentNumber: agentHandle,
        debtorNumber,
        callerId: callerId ?? requestedCallerId,
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
    event = { type: "answer", providerCallId: status.providerCallId, at };
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
