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
import type { SimProvider } from "./sim-provider";
import { isTerminal } from "./call-machine";
import type { TelephonyEvent, CallStatusEvent } from "./types";
import { collectLoggableLegs, type LegCallLog } from "@/lib/dialer/leg-disposition";
import { startPollingJob } from "./polling";

// ─── In-memory run registry + event fan-out ─────────────────────────────────────

const runs = new Map<string, DialerRun>();

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

/** Open the planned legs and place each call through the provider, binding provider ids. */
async function dial(run: DialerRun, batch: DialTarget[], idPrefix: string): Promise<DialerRun> {
  const prov = getTelephonyProvider();
  const { run: withLegs, opened } = engine.openLegs(run, batch, { idPrefix });
  let next = withLegs;
  for (const leg of opened) {
    const t = batch.find((x) => x.id === leg.debtorId);
    const { providerCallId } = await prov.startCall({
      agentNumber: "sim-agent",
      debtorNumber: leg.phone,
      callLogId: leg.id,
      hints: {
        aiScore: t?.aiScore,
        bestContactTime: t?.bestContactTime,
        ivr: ivrHint(run.settings),
      },
    });
    next = engine.bindProviderCall(next, leg.id, providerCallId);
  }
  return next;
}

// ─── AI/IVR leg persistence ──────────────────────────────────────────────────────
// AI- and IVR-handled legs (no human agent) should be logged to call_logs — agent legs are
// logged when the agent submits a disposition. Detection is wired below; the durable write is
// a no-op stub for now: a background process has no user session for RLS, so a real write
// needs a service-role Supabase client (Phase 2), and we must never write SIMULATED calls into
// the audit trail. The intended row shape is disposition-store.saveCallLog.
const loggedLegs = new Map<string, Set<string>>(); // runId → leg ids already handled

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
    }) => d,
  )
  .handler(async ({ data }) => {
    ensureSubscribed();
    const base = engine.newDialerRun({ id: data.runId, settings: data.settings });
    const batch = engine.planDialBatch({
      settings: data.settings,
      queue: data.targets,
      agentsAvailable: data.agentsAvailable,
      inFlight: 0,
    });
    const run = await dial(base, batch, data.runId);
    runs.set(run.id, run);
    return run;
  });

export const tickDialerRun = createServerFn({ method: "POST" })
  .inputValidator((d: { runId: string; agentsAvailable: number; targets?: DialTarget[] }) => d)
  .handler(async ({ data }) => {
    ensureSubscribed();
    flushSim(); // advance the simulated carrier; subscription mutates runs in place
    let run = runs.get(data.runId);
    if (!run) return null;

    // Continuous (predictive) dialing: top up capacity with debtors not yet dialed.
    if (run.running && data.targets?.length) {
      const inFlight = run.legs.filter((l) => !isTerminal(l.state)).length;
      const dialed = new Set(run.legs.map((l) => l.debtorId));
      const remaining = data.targets.filter((t) => !dialed.has(t.id));
      const batch = engine.planDialBatch({
        settings: run.settings,
        queue: remaining,
        agentsAvailable: data.agentsAvailable,
        inFlight,
      });
      if (batch.length) run = await dial(run, batch, data.runId);
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
  .inputValidator(
    (d: {
      callLogId: string;
      agentNumber: string;
      debtorNumber: string;
      aiScore?: number;
      ivr?: boolean;
    }) => d,
  )
  .handler(async ({ data }) => {
    ensureSubscribed();
    const { providerCallId } = await getTelephonyProvider().startCall({
      agentNumber: data.agentNumber,
      debtorNumber: data.debtorNumber,
      callLogId: data.callLogId,
      hints: { aiScore: data.aiScore, ivr: data.ivr },
    });
    return { providerCallId };
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

// ─── Webhook ingest ──────────────────────────────────────────────────────────────
// A real provider POSTs status callbacks to a public HTTP endpoint; that endpoint (added
// when the real provider lands — this version of TanStack Start has no stable server-route
// file convention) forwards the raw body here. Parsing + state transition + fan-out are
// identical to the sim path, so nothing downstream changes when SIP is integrated.

// Core logic: convert CallStatusEvent to TelephonyEvent and apply to all runs.
// Used by both webhook handler and polling job.
export async function ingestCallStatusEvent(status: CallStatusEvent): Promise<void> {
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
