// Server surface for the dialer — where "background calling" runs and where a real
// provider's API keys stay off the client bundle. These are TanStack Start server
// functions (RPC): the browser calls them, the handlers run server-side against
// getTelephonyProvider() + the pure dialer engine.
//
// Today the active provider is the simulator, so a run advances when tickDialerRun()
// flushes due sim events. Swapping TELEPHONY_PROVIDER to a real vendor changes nothing
// here: real providers deliver events via ingestProviderWebhook() instead of flushDue().
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
import { sendWhatsApp as sendWhatsAppExotel } from "./exotel-provider";
import type { SimProvider } from "./sim-provider";
import { isTerminal } from "./call-machine";
import type { TelephonyEvent, CallStatusEvent } from "./types";
import { collectLoggableLegs, type LegCallLog } from "@/lib/dialer/leg-disposition";
import { startPollingJob, fetchRecentCallRecords } from "./polling";

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
  };
};

g.__recoveryaiTelephony ??= {
  runs: new Map(),
  busyAgents: new Map(),
  loggedLegs: new Map(),
  latestStatus: new Map(),
};

const runs = g.__recoveryaiTelephony.runs;

let subscribed = false;
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  // The provider pushes normalized events; route each to whichever run owns the leg.
  getTelephonyProvider().subscribe?.((event: TelephonyEvent) => {
    for (const [id, run] of runs) runs.set(id, engine.applyLegEvent(run, event));
  });
}

// ─── Polling Job Initialization ───────────────────────────────────────────

// Start the background polling job on module load.
// Polling periodically fetches call records from Tata as a fallback if webhooks fail.
// This runs server-side and is automatically started when this module is imported.
if (typeof process !== "undefined") {
  startPollingJob();
}

/** Release due simulated events (real providers push via ingestProviderWebhook instead). */
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
  callerId?: string,
): Promise<{ run: DialerRun; unassigned: number }> {
  const prov = getTelephonyProvider();
  releaseAgentsForTerminalLegs(run);

  const free = agentNumbers.filter((n) => !busyAgents.has(n));
  const assignable = batch.slice(0, free.length);
  const unassigned = batch.length - assignable.length;

  const { run: withLegs, opened } = engine.openLegs(run, assignable, { idPrefix });
  let next = withLegs;

  for (const [i, leg] of opened.entries()) {
    const agentNumber = free[i];
    const t = assignable.find((x) => x.id === leg.debtorId);
    try {
      const { providerCallId } = await prov.startCall({
        agentNumber,
        debtorNumber: leg.phone,
        callerId,
        callLogId: leg.id,
        hints: {
          aiScore: t?.aiScore,
          bestContactTime: t?.bestContactTime,
          ivr: ivrHint(run.settings),
        },
      });
      busyAgents.set(agentNumber, leg.id);
      next = engine.bindProviderCall(next, leg.id, providerCallId);
    } catch (err) {
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
    ensureSubscribed();
    const agentNumbers = data.agentNumbers ?? [];
    const base = engine.newDialerRun({ id: data.runId, settings: data.settings });
    const batch = engine.planDialBatch({
      settings: data.settings,
      queue: data.targets,
      agentsAvailable: Math.min(data.agentsAvailable, agentNumbers.length || data.agentsAvailable),
      inFlight: 0,
    });
    const { run, unassigned } = await dial(base, batch, data.runId, agentNumbers, data.callerId);
    if (unassigned > 0) {
      console.warn(`[dialer] ${unassigned} target(s) not dialed — no free agent leg available`);
    }
    runs.set(run.id, run);
    return run;
  });

export const tickDialerRun = createServerFn({ method: "POST" })
  .inputValidator(
    (d: {
      runId: string;
      agentsAvailable: number;
      targets?: DialTarget[];
      agentNumbers?: string[];
      callerId?: string;
    }) => d,
  )
  .handler(async ({ data }) => {
    ensureSubscribed();
    flushSim(); // advance the simulated carrier; subscription mutates runs in place
    let run = runs.get(data.runId);
    if (!run) return null;

    // Continuous dialing: top up capacity with debtors not yet dialed.
    if (run.running && data.targets?.length) {
      const agentNumbers = data.agentNumbers ?? [];
      const inFlight = run.legs.filter((l) => !isTerminal(l.state)).length;
      const dialed = new Set(run.legs.map((l) => l.debtorId));
      const remaining = data.targets.filter((t) => !dialed.has(t.id));
      const batch = engine.planDialBatch({
        settings: run.settings,
        queue: remaining,
        agentsAvailable: Math.min(
          data.agentsAvailable,
          agentNumbers.length || data.agentsAvailable,
        ),
        inFlight,
      });
      if (batch.length) {
        const res = await dial(run, batch, data.runId, agentNumbers, data.callerId);
        run = res.run;
      }
    }

    await persistLoggableLegs(run); // log any AI/IVR legs that just went terminal
    runs.set(run.id, run);
    return run;
  });

export const stopDialerRun = createServerFn({ method: "POST" })
  .inputValidator((d: { runId: string }) => d)
  .handler(async ({ data }) => {
    const run = runs.get(data.runId);
    if (!run) return null;
    const prov = getTelephonyProvider();
    for (const leg of run.legs) {
      if (!isTerminal(leg.state) && leg.providerCallId) await prov.hangup(leg.providerCallId);
    }
    const stopped = engine.stopDialerRun(run);
    await persistLoggableLegs(stopped);
    loggedLegs.delete(data.runId);
    runs.set(stopped.id, stopped);
    return stopped;
  });

// ─── Single-call + SMS wrappers ──────────────────────────────────────────────────

export const startCall = createServerFn({ method: "POST" })
  .inputValidator((d: any) => {
    console.log("[telephony:server] inputValidator received:", {
      callLogId: d?.callLogId,
      agentNumber: d?.agentNumber,
      debtorNumber: d?.debtorNumber,
    });
    return d;
  })
  .handler(async ({ data }) => {
    ensureSubscribed();
    console.log("[telephony:server] startCall - agentNumber:", data?.agentNumber, "debtorNumber:", data?.debtorNumber);
    if (!data?.agentNumber) {
      throw new Error(`Missing agentNumber in request`);
    }
    const { providerCallId } = await getTelephonyProvider().startCall({
      agentNumber: data.agentNumber,
      debtorNumber: data.debtorNumber,
      callerId: data.callerId,
      callLogId: data.callLogId,
      hints: { aiScore: data.aiScore, ivr: data.ivr },
    });
    return { providerCallId };
  });

/**
 * Look up recordings for calls we already logged.
 *
 * Providers publish recordings asynchronously — Tata's hangup webhook arrives with
 * `"recording_url": ""` — so a call dispositioned promptly is saved with no recording and
 * nothing would ever fill it in. The browser asks for the missing ones by provider call id;
 * the CDR lookup happens here because it needs the API token, and the caller writes the
 * result to its own row under its own session (no service-role key needed).
 *
 * Returns only the ids that now have a recording.
 */
export const fetchRecordings = createServerFn({ method: "POST" })
  .inputValidator((d: { providerCallIds: string[] }) => d)
  .handler(async ({ data }) => {
    const wanted = new Set(data.providerCallIds.filter(Boolean));
    if (!wanted.size) return {} as Record<string, string>;

    const records = await fetchRecentCallRecords();
    const found: Record<string, string> = {};
    for (const r of records) {
      const rec = r.recording_url;
      if (!rec || typeof rec !== "string") continue;
      for (const key of [r.ref_id, r.call_id, r.uuid]) {
        if (typeof key === "string" && wanted.has(key)) {
          found[key] = rec;
          break;
        }
      }
    }
    return found;
  });

export const hangupCall = createServerFn({ method: "POST" })
  .inputValidator((d: { providerCallId: string }) => d)
  .handler(async ({ data }) => {
    await getTelephonyProvider().hangup(data.providerCallId);
    return { ok: true };
  });

export const sendSms = createServerFn({ method: "POST" })
  .inputValidator((d: { to: string; templateId: string; templateParams: string[] }) => d)
  .handler(async ({ data }) => {
    const res = await getTelephonyProvider().sendSms({
      to: data.to,
      templateId: data.templateId,
      templateParams: data.templateParams,
    });
    return res;
  });

// WhatsApp isn't part of TelephonyProvider (voice + SMS only — see ./types.ts), so this
// calls the Exotel sender directly rather than going through getTelephonyProvider(). Only
// works when EXOTEL_* credentials are set, regardless of TELEPHONY_PROVIDER.
export const sendWhatsAppMessage = createServerFn({ method: "POST" })
  .inputValidator(
    (d: { to: string; templateName: string; templateParams: string[] }) => d,
  )
  .handler(async ({ data }) => {
    return sendWhatsAppExotel({
      to: data.to,
      templateName: data.templateName,
      templateParams: data.templateParams,
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
  .inputValidator((d: { keys: string[] }) => d)
  .handler(async ({ data }) => {
    for (const key of data.keys) {
      const hit = latestStatus.get(key);
      if (hit) {
        console.log(`[telephony] getCallStatus hit ${key} -> ${hit.status}`);
        return hit;
      }
    }
    // Logged so a "stuck on ringing" report can be told apart at a glance: an empty store
    // means no webhook ever landed in THIS process, whereas a populated one means the keys
    // simply don't match.
    console.log(
      `[telephony] getCallStatus miss for [${data.keys.join(", ")}] — store holds ${latestStatus.size} entr${latestStatus.size === 1 ? "y" : "ies"}: [${[...latestStatus.keys()].slice(0, 6).join(", ")}]`,
    );
    return null;
  });

export async function ingestCallStatusEvent(status: CallStatusEvent): Promise<void> {
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
            : "no_answer",
      durationSeconds: status.durationSeconds ?? 0,
    };
  }
  for (const [id, run] of runs) runs.set(id, engine.applyLegEvent(run, event));
  if (status.recordingUrl) {
    const rec: TelephonyEvent = {
      type: "recording",
      providerCallId: status.providerCallId,
      at,
      recordingUrl: status.recordingUrl,
    };
    for (const [id, run] of runs) runs.set(id, engine.applyLegEvent(run, rec));
  }
  for (const run of runs.values()) await persistLoggableLegs(run);
}

export const ingestProviderWebhook = createServerFn({ method: "POST" })
  .inputValidator((payload: unknown) => payload)
  .handler(async ({ data }) => {
    const status = getTelephonyProvider().parseStatusWebhook(data);
    await ingestCallStatusEvent(status);
    return { ok: true };
  });
