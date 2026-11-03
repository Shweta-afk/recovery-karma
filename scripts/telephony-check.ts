/* Standalone assertion harness for the telephony logic layer.
 * No test framework: run with `bun run scripts/telephony-check.ts`.
 * Exercises the PURE core (call-machine + dialer engine) and a simulated end-to-end
 * dialer run. Imports PortfolioSettings as a type only + defines its own fixtures, so it
 * never loads the supabase-backed portfolio-store at runtime. */
import type { PortfolioSettings } from "@/lib/portfolio-store";
import {
  isTerminal,
  canTransition,
  transition,
  applyEvent,
  stateFromStatus,
} from "@/lib/telephony/call-machine";
import * as engine from "@/lib/dialer/engine";
import type { DialTarget } from "@/lib/dialer/engine";
import { createSimProvider } from "@/lib/telephony/sim-provider";
import type { CallRecord, TelephonyEvent } from "@/lib/telephony/types";
import { legToCallLog, collectLoggableLegs } from "@/lib/dialer/leg-disposition";
import {
  channelAllocationError,
  channelLimitMessage,
  evaluateCall,
  istMinutes,
  normalisePhone,
  withinCallWindow,
  type TelephonySettingsRow,
} from "@/lib/telephony/guard-rules";
import { skycrmDispositionFor, skycrmNumber, skycrmProvider } from "@/lib/telephony/skycrm-provider";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}
function throws(label: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.error(`  ✗ ${label} (expected throw)`);
  } catch {
    passed++;
  }
}

const baseSettings: PortfolioSettings = {
  callMode: "agent_only",
  dialerMode: "predictive",
  callsPerCycle: 5,
  autoRechurn: true,
  rechurnAfterDays: 1,
  rechurnOnNoAnswer: true,
  rechurnOnBusy: true,
  rechurnOnVoicemail: false,
  rechurnMaxCycles: 3,
  rechurnTimeWindow: "00:00-23:59",
  ptpFollowupHours: 24,
  callbackBufferMins: 10,
  abandonRateTarget: 3,
};
const s = (o: Partial<PortfolioSettings> = {}): PortfolioSettings => ({ ...baseSettings, ...o });

// ── call-machine ────────────────────────────────────────────────────────────
console.log("call-machine");
ok("completed is terminal", isTerminal("completed"));
ok("ringing not terminal", !isTerminal("ringing"));
ok("queued→dialing legal", canTransition("queued", "dialing"));
ok("connected→ringing illegal", !canTransition("connected", "ringing"));
ok("transition returns target", transition("ringing", "connected") === "connected");
throws("illegal transition throws", () => transition("completed", "ringing"));
ok(
  "ring: dialing→ringing",
  applyEvent("dialing", { type: "ring", providerCallId: "x", at: 0 }) === "ringing",
);
ok(
  "answer: ringing→connected",
  applyEvent("ringing", { type: "answer", providerCallId: "x", at: 0 }) === "connected",
);
ok(
  "hangup connected→completed",
  applyEvent("connected", {
    type: "hangup",
    providerCallId: "x",
    at: 0,
    result: "no_answer",
    durationSeconds: 5,
  }) === "completed",
);
ok(
  "hangup dialing→no_answer",
  applyEvent("dialing", {
    type: "hangup",
    providerCallId: "x",
    at: 0,
    result: "no_answer",
    durationSeconds: 0,
  }) === "no_answer",
);
ok(
  "dtmf no state change",
  applyEvent("connected", { type: "dtmf", providerCallId: "x", at: 0, digit: "1" }) === "connected",
);
ok("stateFromStatus completed", stateFromStatus("completed") === "completed");

// ── engine: pacing + capacity + planning ─────────────────────────────────────
console.log("engine: pacing/capacity/planning");
ok("predictivePacing(3)=1.6", Math.abs(engine.predictivePacing(3) - 1.6) < 1e-9);
ok("predictivePacing clamps at 10", engine.predictivePacing(50) === engine.predictivePacing(10));
ok("predictive capacity 5 agents,target3 = 8", engine.dialCapacity(s(), 5) === 8);
ok("power capacity = agents", engine.dialCapacity(s({ dialerMode: "power" }), 5) === 5);
ok("preview capacity 0", engine.dialCapacity(s({ dialerMode: "preview" }), 5) === 0);
ok("manual capacity 0", engine.dialCapacity(s({ dialerMode: "manual" }), 5) === 0);

const queue10: DialTarget[] = Array.from({ length: 10 }, (_, i) => ({
  id: `d${i}`,
  name: `Debtor ${i}`,
  phone: `+9190000000${i}`,
}));
ok(
  "planDialBatch capped by callsPerCycle(5)",
  engine.planDialBatch({ settings: s(), queue: queue10, agentsAvailable: 5, inFlight: 0 })
    .length === 5,
);
ok(
  "planDialBatch subtracts inFlight",
  engine.planDialBatch({
    settings: s({ callsPerCycle: 100 }),
    queue: queue10,
    agentsAvailable: 5,
    inFlight: 6,
  }).length === 2,
); // cap 8-6=2
ok(
  "planDialBatch empty outside window",
  engine.planDialBatch({
    settings: s({ rechurnTimeWindow: "23:00-23:01" }),
    queue: queue10,
    agentsAvailable: 5,
    inFlight: 0,
    now: new Date(2026, 0, 1, 12, 0),
  }).length === 0,
);
ok(
  "withinTimeWindow noon in 09-19",
  engine.withinTimeWindow("09:00-19:00", new Date(2026, 0, 1, 12, 0)),
);
ok(
  "withinTimeWindow 20:00 not in 09-19",
  !engine.withinTimeWindow("09:00-19:00", new Date(2026, 0, 1, 20, 0)),
);
ok(
  "withinTimeWindow overnight 23:00 in 22-06",
  engine.withinTimeWindow("22:00-06:00", new Date(2026, 0, 1, 23, 0)),
);

// ── engine: routing ──────────────────────────────────────────────────────────
console.log("engine: mode routing");
ok("agent_only→agent", engine.routeAnsweredCall("agent_only") === "agent");
ok("ai_only→ai", engine.routeAnsweredCall("ai_only") === "ai");
ok("ivr_agent→ivr", engine.routeAnsweredCall("ivr_agent") === "ivr");
ok("hybrid→ai", engine.routeAnsweredCall("hybrid") === "ai");

// ── engine: rechurn ──────────────────────────────────────────────────────────
console.log("engine: rechurn");
ok(
  "rechurn no_answer within max reschedules",
  engine.applyRechurn({ settings: s(), terminalState: "no_answer", attempt: 1 }).reschedule ===
    true,
);
ok(
  "rechurn at max does not reschedule",
  engine.applyRechurn({ settings: s(), terminalState: "no_answer", attempt: 3 }).reschedule ===
    false,
);
ok(
  "rechurn off does not reschedule",
  engine.applyRechurn({
    settings: s({ autoRechurn: false }),
    terminalState: "no_answer",
    attempt: 1,
  }).reschedule === false,
);
ok(
  "voicemail respects rechurnOnVoicemail=false",
  engine.applyRechurn({ settings: s(), terminalState: "no_answer", voicemail: true, attempt: 1 })
    .reschedule === false,
);
ok(
  "busy reschedules when rechurnOnBusy",
  engine.applyRechurn({ settings: s(), terminalState: "busy", attempt: 1 }).reschedule === true,
);

// ── leg → call_log mapping (AI/IVR persistence) ────────────────────────────────
console.log("leg-disposition: AI/IVR call logging");
const leg = (o: Partial<CallRecord>): CallRecord => ({
  id: "l",
  debtorId: "d",
  phone: "+910000000000",
  direction: "outbound",
  participant: "ai",
  state: "completed",
  attempt: 1,
  queuedAt: 0,
  ...o,
});
ok("agent leg not logged here", legToCallLog(leg({ participant: "agent" })) === null);
ok("non-terminal not logged", legToCallLog(leg({ state: "connected" })) === null);
ok("ai completed → call_type ai", legToCallLog(leg({ participant: "ai" }))?.callType === "ai");
ok("ai completed → callback", legToCallLog(leg({ participant: "ai" }))?.outcome === "callback");
ok(
  "ai no_answer → no_answer",
  legToCallLog(leg({ participant: "ai", state: "no_answer" }))?.outcome === "no_answer",
);
ok(
  "ivr keypress 2 → promised",
  legToCallLog(leg({ participant: "ivr", dtmf: ["2"] }))?.outcome === "promised",
);
ok(
  "ivr keypress 3 → callback",
  legToCallLog(leg({ participant: "ivr", dtmf: ["3"] }))?.outcome === "callback",
);
ok(
  "ivr no keypress → no_answer",
  legToCallLog(leg({ participant: "ivr", dtmf: [] }))?.outcome === "no_answer",
);
ok("failed not logged", legToCallLog(leg({ state: "failed" })) === null);
{
  const legs = [
    leg({ id: "a", participant: "ai", state: "completed" }),
    leg({ id: "b", participant: "agent", state: "completed" }),
    leg({ id: "c", participant: "ivr", state: "no_answer" }),
    leg({ id: "e", participant: "ai", state: "connected" }),
  ];
  ok(
    "collect → 2 loggable (ai done + ivr no_answer)",
    collectLoggableLegs(legs, new Set()).length === 2,
  );
  ok("collect skips already-logged", collectLoggableLegs(legs, new Set(["a"])).length === 1);
}


console.log("guard: call rules");
{
  const at = (iso: string) => new Date(iso);
  ok("IST offset: 03:00Z is 08:30 IST", istMinutes(at("2026-09-26T03:00:00Z")) === 8 * 60 + 30);
  ok("IST wraps past midnight", istMinutes(at("2026-09-26T20:00:00Z")) === 60 + 30);
  ok("08:30 IST inside 08:00–19:00", withinCallWindow("08:00", "19:00", at("2026-09-26T03:00:00Z")));
  ok("07:59 IST outside", !withinCallWindow("08:00", "19:00", at("2026-09-26T02:29:00Z")));
  ok("19:00 IST outside (end exclusive)", !withinCallWindow("08:00", "19:00:00", at("2026-09-26T13:30:00Z")));
  ok("normalise +91 form", normalisePhone("+91 98765-43210") === "9876543210");
  ok("normalise 0-prefixed", normalisePhone("09876543210") === "9876543210");

  const settings: TelephonySettingsRow = {
    enabled: true,
    seat_limit: 5,
    channel_limit: 10,
    inbound_did: null,
    inbound_queue: null,
    call_window_start: "08:00:00",
    call_window_end: "19:00:00",
  };
  const noon = at("2026-09-26T06:30:00Z"); // 12:00 IST
  const base = { settings, provider: "skycrm", agentExtension: "8006", onDoNotCall: false, now: noon };
  const code = (d: ReturnType<typeof evaluateCall>) => (d.ok ? "ok" : d.code);
  ok("allowed call passes", code(evaluateCall(base)) === "ok");
  ok("do-not-call blocks", code(evaluateCall({ ...base, onDoNotCall: true })) === "do_not_call");
  ok("do-not-call blocks even on sim with no row",
    code(evaluateCall({ ...base, settings: null, provider: "sim", onDoNotCall: true })) === "do_not_call");
  ok("disabled company blocks", code(evaluateCall({ ...base, settings: { ...settings, enabled: false } })) === "telephony_disabled");
  ok("real provider with no settings row blocks", code(evaluateCall({ ...base, settings: null })) === "telephony_disabled");
  ok("sim with no settings row keeps working", code(evaluateCall({ ...base, settings: null, provider: "sim" })) === "ok");
  ok("outside window blocks", code(evaluateCall({ ...base, now: at("2026-09-26T14:00:00Z") })) === "outside_window");
  ok("skycrm needs an extension", code(evaluateCall({ ...base, agentExtension: null })) === "no_extension");
  ok("sim doesn't need an extension", code(evaluateCall({ ...base, provider: "sim", agentExtension: null })) === "ok");
  ok("company channel limit message", !!channelLimitMessage("ERROR: CHANNEL_LIMIT_COMPANY")?.includes("company"));
  ok("global channel limit message", !!channelLimitMessage("CHANNEL_LIMIT_GLOBAL")?.includes("platform"));
  ok("unrelated DB error is not a channel message", channelLimitMessage("timeout") === null);
  ok("allocation within 60 ok", channelAllocationError(40, 20) === null);
  ok("allocation over 60 rejected", channelAllocationError(45, 20) !== null);
}

console.log("skycrm: webhook parsing + disposition mapping");
{
  const outbound = skycrmProvider.parseStatusWebhook({
    status: "Outbound Call", phone: "9146918685", direction: "Outbound",
    callid: "1756471568.293338", extension: "8006",
  });
  ok("outbound event → ringing", outbound.status === "ringing");
  ok("outbound carries extension + vendor id", outbound.agentHandle === "8006" && outbound.vendorCallId === "1756471568.293338");
  const answered = skycrmProvider.parseStatusWebhook({
    status: "Answered", phone: "+9191XXXXXXXX", direction: "Inbound", callid: "1.2", extension: "8594",
  });
  ok("answered → connected, inbound", answered.status === "connected" && answered.direction === "inbound");
  const incoming = skycrmProvider.parseStatusWebhook({
    status: "Incomming Call", phone: "+919876543210", direction: "Inbound", callid: "1.3", extension: "",
  });
  ok("unanswered inbound has no agent yet", incoming.status === "ringing" && incoming.agentHandle === undefined);
  const cdr = skycrmProvider.parseStatusWebhook({
    callid: "1755844832.234718", src: "1234567890", dst: "8006", billsec: "6",
    disposition: "ANSWERED", direction: "Inbound", recordfile: "10.128.11.67/Recording/x.wav",
  });
  ok("CDR answered → completed", cdr.status === "completed");
  ok("CDR finds extension in dst", cdr.agentHandle === "8006" && cdr.remotePhone === "1234567890");
  ok("CDR duration", cdr.durationSeconds === 6);
  ok("recordfile is a path, not a URL", cdr.recordingPath === "10.128.11.67/Recording/x.wav" && cdr.recordingUrl === undefined);
  const busy = skycrmProvider.parseStatusWebhook({ callid: "9", src: "8006", dst: "9876543210", billsec: "0", disposition: "BUSY", direction: "Outbound" });
  ok("CDR busy → busy, extension from src", busy.status === "busy" && busy.agentHandle === "8006");
  const outCdr = skycrmProvider.parseStatusWebhook({ callid: "10", src: "8601", dst: "86019876543210", billsec: "33", disposition: "ANSWERED", direction: "Outbound" });
  ok("outbound CDR drops the extension prefix from the number", outCdr.agentHandle === "8601" && outCdr.remotePhone === "9876543210");
  ok("SkyCRM gets 10 digits from +91/91/0 forms", ["+91 98765 43210", "919876543210", "09876543210", "9876543210"].every((n) => skycrmNumber(n) === "9876543210"));
  throws("webhook without callid rejected", () => skycrmProvider.parseStatusWebhook({ status: "Answered" }));
  ok("no answer → Non-Contacted", skycrmDispositionFor("no_answer") === "Non-Contacted");
  ok("wrong number → Non-Contacted", skycrmDispositionFor("wrong_number") === "Non-Contacted");
  ok("promised → Contacted", skycrmDispositionFor("promised") === "Contacted");
}

async function simE2E() {
  console.log("sim: end-to-end dialer run");
  const sim = createSimProvider({ seed: 7 });
  let run = engine.newDialerRun({ id: "run1", settings: s() });
  const targets: DialTarget[] = queue10.slice(0, 3).map((t, i) => ({ ...t, aiScore: 3 + i * 3 }));

  const batch = engine.planDialBatch({
    settings: run.settings,
    queue: targets,
    agentsAvailable: 5,
    inFlight: 0,
  });
  ok("plans 3 (queue=3 < caps)", batch.length === 3);

  const opened = engine.openLegs(run, batch, { idPrefix: "run1" });
  run = opened.run;
  ok(
    "legs participant=agent (agent_only)",
    run.legs.every((l: CallRecord) => l.participant === "agent"),
  );

  for (const leg of opened.opened) {
    const t = targets.find((x) => x.id === leg.debtorId);
    const { providerCallId } = await sim.startCall({
      agentNumber: "sim-agent",
      debtorNumber: leg.phone,
      callLogId: leg.id,
      hints: { aiScore: t?.aiScore },
    });
    run = engine.bindProviderCall(run, leg.id, providerCallId);
  }
  ok(
    "all legs bound to providerCallId",
    run.legs.every((l) => !!l.providerCallId),
  );

  sim.subscribe?.((event: TelephonyEvent) => {
    run = engine.applyLegEvent(run, event);
  });
  // Release every scheduled event at once by flushing far into the future.
  const emitted = sim.flushDue(Date.now() + 10_000_000);
  ok("sim emitted events", emitted > 0);
  ok(
    "all legs terminal after flush",
    run.legs.every((l) => isTerminal(l.state)),
  );
  ok("stats.attempts = 3", run.stats.attempts === 3);
  ok(
    "connects+noAnswers+abandons ≤ attempts",
    run.stats.connects + run.stats.noAnswers + run.stats.abandons <= 3,
  );

  const stopped = engine.stopDialerRun(run);
  ok("stopped run not running", stopped.running === false);
}

// ── sim: manual single dial ────────────────────────────────────────────────────
async function simManualCall() {
  console.log("sim: manual single dial");
  const sim = createSimProvider({ seed: 3 });
  const types: TelephonyEvent["type"][] = [];
  sim.subscribe?.((e: TelephonyEvent) => types.push(e.type));
  // Low aiScore would usually mean no-answer, but manual must always connect.
  await sim.startCall({
    agentNumber: "agent-self",
    debtorNumber: "+910000000000",
    callLogId: "d0",
    hints: { manual: true, aiScore: 1 },
  });
  sim.flushDue(Date.now() + 10_000_000);
  ok("manual call rings", types.includes("ring"));
  ok("manual call always answers", types.includes("answer"));
  ok("manual call does not auto-hangup", !types.includes("hangup"));
}

await simE2E();
await simManualCall();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
