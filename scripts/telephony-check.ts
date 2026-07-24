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

// ── sim end-to-end ────────────────────────────────────────────────────────────
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

await simE2E();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
