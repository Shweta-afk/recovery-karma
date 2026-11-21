// Vendor-side predictive dialling (SkyCRM API v1.2 §24): pure rules in predictive-rules.ts, the
// engine's handling of vendor-routed legs, the simulator's borrower-first flow, and the exact
// form fields SkyCRM is sent.
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { PortfolioSettings } from "../src/lib/portfolio-store";
import * as engine from "../src/lib/dialer/engine";
import { createSimProvider } from "../src/lib/telephony/sim-provider";
import type { CallRecord, TelephonyEvent } from "../src/lib/telephony/types";
import {
  SIM_QUEUE,
  freeAgentHandles,
  linesPerAgent,
  parsePredictiveQueue,
  pendingLegs,
  pickPredictiveLedger,
  predictiveAgentFromEvent,
  predictiveBatchSize,
  predictiveMode,
  requestExtension,
  runsSharingAgents,
  sortOpenPredictive,
  stuckConnectedRows,
  SILENT_PREDICTIVE_SECONDS,
} from "../src/lib/telephony/predictive-rules";

process.env.SKYCRM_SECRET = "test-secret";
process.env.SKYCRM_BASE_URL = "https://sky.test";
mock.module("../src/lib/telephony/skycrm-credentials.server", () => ({
  skycrmCredentials: async () => null,
  forgetSkycrmCredentials: () => {},
}));
// Every export of the real module — see module-mocks.test.ts.
mock.module("@/lib/supabase-admin.server", () => ({
  getSupabaseAdmin: () => ({}),
  verifyCaller: async () => null,
  verifySuperadminCaller: async () => null,
  forgetCaller: () => {},
}));

const settings = {
  callMode: "agent_only",
  dialerMode: "predictive",
  callsPerCycle: 10,
  abandonRateTarget: 3,
  rechurnTimeWindow: "00:00-23:59",
} as PortfolioSettings;

function leg(p: Partial<CallRecord>): CallRecord {
  return {
    id: p.id ?? "l",
    debtorId: "d",
    phone: "9876543210",
    direction: "outbound",
    participant: "agent",
    state: "ringing",
    attempt: 1,
    queuedAt: 0,
    ...p,
  };
}

describe("predictive queue setting", () => {
  test("one 3–6 digit queue, blank = none", () => {
    expect(parsePredictiveQueue(" 8601 ")).toEqual({ ok: true, queue: "8601" });
    expect(parsePredictiveQueue("")).toEqual({ ok: true, queue: null });
    expect(parsePredictiveQueue(null)).toEqual({ ok: true, queue: null });
    expect(parsePredictiveQueue("8601,8602").ok).toBe(false);
    expect(parsePredictiveQueue("12").ok).toBe(false);
    expect(parsePredictiveQueue("queue1").ok).toBe(false);
  });

  test("vendor mode only for Productive Dial, a capable provider, and a queue (sim: built in)", () => {
    const base = { dialerMode: "predictive", providerSupportsPredictive: true };
    expect(predictiveMode({ ...base, provider: "skycrm", predictiveQueue: "8601" })).toEqual({
      mode: "vendor",
      queue: "8601",
    });
    expect(predictiveMode({ ...base, provider: "skycrm", predictiveQueue: null }).mode).toBe(
      "click_to_call",
    );
    expect(predictiveMode({ ...base, provider: "skycrm", predictiveQueue: "bad" }).mode).toBe(
      "click_to_call",
    );
    expect(predictiveMode({ ...base, provider: "sim", predictiveQueue: null })).toEqual({
      mode: "vendor",
      queue: SIM_QUEUE,
    });
    // Progressive Dial (internally "productive") never overdials.
    expect(
      predictiveMode({ ...base, dialerMode: "productive", provider: "sim", predictiveQueue: "1" })
        .mode,
    ).toBe("click_to_call");
    expect(
      predictiveMode({
        ...base,
        providerSupportsPredictive: false,
        provider: "kookoo",
        predictiveQueue: "8601",
      }).mode,
    ).toBe("click_to_call");
  });
});

describe("pacing: lines per agent (user, 2026-11-20)", () => {
  const args = {
    freeAgents: 1,
    pending: 0,
    linesPerAgent: 5,
    callsPerCycle: 10,
    lines: 20,
    remaining: 100,
  };

  test("one free agent with 5 lines → five borrowers ring at once", () => {
    expect(predictiveBatchSize(args)).toBe(5);
    expect(predictiveBatchSize({ ...args, freeAgents: 3 })).toBe(10); // 15, capped by cycle
    expect(predictiveBatchSize({ ...args, freeAgents: 3, callsPerCycle: 20 })).toBe(15);
    expect(predictiveBatchSize({ ...args, linesPerAgent: 2 })).toBe(2);
  });

  test("calls still ringing count against it: a line ends → the next one is dialled", () => {
    expect(predictiveBatchSize({ ...args, pending: 5 })).toBe(0);
    expect(predictiveBatchSize({ ...args, pending: 4 })).toBe(1);
  });

  test("no free agent → nothing dialled", () => {
    expect(predictiveBatchSize({ ...args, freeAgents: 0 })).toBe(0);
  });

  test("capped by the company's free lines, calls per cycle and what is left", () => {
    expect(predictiveBatchSize({ ...args, freeAgents: 10, lines: 4 })).toBe(4);
    expect(predictiveBatchSize({ ...args, callsPerCycle: 2 })).toBe(2);
    expect(predictiveBatchSize({ ...args, remaining: 1 })).toBe(1);
    expect(predictiveBatchSize({ ...args, lines: 0 })).toBe(0);
  });

  test("the setting: default 5 for old portfolios, clamped to 1–10", () => {
    expect(linesPerAgent({})).toBe(5);
    expect(linesPerAgent(null)).toBe(5);
    expect(linesPerAgent({ linesPerAgent: 3 })).toBe(3);
    expect(linesPerAgent({ linesPerAgent: 0 })).toBe(1);
    expect(linesPerAgent({ linesPerAgent: 500 })).toBe(10);
    expect(linesPerAgent({ linesPerAgent: Number.NaN })).toBe(5);
  });

  test("free agents = not on a connected predictive leg", () => {
    const legs = [
      leg({ id: "a", state: "connected", agentHandle: "8001" }),
      leg({ id: "b", state: "completed", agentHandle: "8002" }),
      leg({ id: "c", state: "connected", vendorRouted: true }), // answered, waiting in queue
    ];
    expect(freeAgentHandles(["8001", "8002", "8003"], legs)).toEqual(["8002", "8003"]);
    expect(pendingLegs([...legs, leg({ id: "d", state: "ringing" })])).toBe(2);
  });

  test("request extension rotates over free agents, else everyone", () => {
    expect(requestExtension(["8001", "8002"], ["8001", "8002", "8003"], 0)).toBe("8001");
    expect(requestExtension(["8001", "8002"], ["8001", "8002", "8003"], 3)).toBe("8002");
    expect(requestExtension([], ["8003"], 7)).toBe("8003");
    expect(requestExtension([], [], 0)).toBeNull();
  });
});

describe("one agent, one set of lines across runs (2026-11-21)", () => {
  const now = Date.parse("2026-11-21T10:50:00Z");
  const row = (over: Partial<Parameters<typeof sortOpenPredictive>[0][number]>) => ({
    id: "r",
    request_extension: "8603",
    agent_handle: null,
    vendor_callid: null,
    vendor_events: null,
    started_at: new Date(now - 10_000).toISOString(),
    ...over,
  });

  test("five runs' calls on one extension all count as waiting", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: `r${i}` }));
    const { waiting } = sortOpenPredictive(rows, ["8603"], now);
    expect(waiting).toBe(25);
    const n = predictiveBatchSize({
      freeAgents: 1,
      pending: waiting,
      linesPerAgent: 5,
      callsPerCycle: 10,
      lines: 20,
      remaining: 100,
    });
    expect(n).toBe(0);
  });

  test("calls the vendor never acknowledged are closed after the limit", () => {
    // SkyCRM sends nothing for an unanswered predictive call (2026-11-21).
    expect(SILENT_PREDICTIVE_SECONDS).toBe(45);
    const old = new Date(now - (SILENT_PREDICTIVE_SECONDS + 1) * 1000).toISOString();
    const out = sortOpenPredictive(
      [
        row({ id: "silent", started_at: old }),
        row({ id: "young" }),
        row({ id: "heard", started_at: old, vendor_callid: "abc" }),
        row({ id: "event", started_at: old, vendor_events: "Ringing" }),
      ],
      ["8603"],
      now,
    );
    expect(out.silent.map((r) => r.id)).toEqual(["silent"]);
    expect(out.waiting).toBe(3);
  });

  test("an agent on a call is busy; other agents' calls don't count", () => {
    const out = sortOpenPredictive(
      [
        row({ id: "a", agent_handle: "8603", vendor_callid: "x" }),
        row({ id: "b", request_extension: "8604" }),
        row({ id: "c", agent_handle: "8604", vendor_callid: "y" }),
      ],
      ["8603"],
      now,
    );
    expect(out.busy).toEqual(["8603"]);
    expect(out.waiting).toBe(0);
  });

  test("a connected call SkyCRM never ended stops blocking an idle agent", () => {
    const answered = new Date(now - 40_000).toISOString();
    const rows = [
      row({ id: "stuck", agent_handle: "8603", vendor_callid: "x", answered_at: answered }),
      row({
        id: "fresh",
        agent_handle: "8603",
        vendor_callid: "y",
        answered_at: new Date(now - 5_000).toISOString(),
      }),
      row({ id: "other", agent_handle: "8604", vendor_callid: "z", answered_at: answered }),
    ];
    // phone idle long enough: only the agent's own call answered ≥ 30 s ago
    expect(stuckConnectedRows(rows, "8603", 25, now).map((r) => r.id)).toEqual(["stuck"]);
    // phone in a call, or barely idle, or no phone on the page: nothing is closed
    expect(stuckConnectedRows(rows, "8603", 0, now)).toEqual([]);
    expect(stuckConnectedRows(rows, "8603", 10, now)).toEqual([]);
    expect(stuckConnectedRows(rows, "8603", null, now)).toEqual([]);
    expect(stuckConnectedRows(rows, null, 60, now)).toEqual([]);
  });

  test("a borrower who picked up but has no agent yet is waiting in the queue", () => {
    const out = sortOpenPredictive(
      [
        row({ id: "ringing" }), // SkyCRM sends nothing while it rings
        row({ id: "waiting", vendor_callid: "c1", vendor_events: "Incomming Call" }),
        row({ id: "taken", vendor_callid: "c2", vendor_events: "Answered", agent_handle: "8603" }),
        row({ id: "other", request_extension: "8604", vendor_events: "Incomming Call" }),
      ],
      ["8603"],
      now,
    );
    expect(out.queued.map((r) => r.id)).toEqual(["waiting"]);
    expect(out.waiting).toBe(2); // ringing + waiting still hold this agent's lines
    expect(out.busy).toEqual(["8603"]);
  });

  test("a new run replaces older runs sharing an agent in the same company", () => {
    const sessions = [
      { runId: "old", clientId: "c1", handles: ["8603"] },
      { runId: "other-agent", clientId: "c1", handles: ["8604"] },
      { runId: "other-company", clientId: "c2", handles: ["8603"] },
      { runId: "new", clientId: "c1", handles: ["8603"] },
    ];
    expect(
      runsSharingAgents(sessions, { runId: "new", clientId: "c1", handles: ["8603"] }),
    ).toEqual(["old"]);
  });
});

describe("webhook matching", () => {
  const rows = [
    {
      id: "old",
      remote_phone: "+919876543210",
      predictive_queue: "8601",
      ended_at: null,
      started_at: "2026-11-17T05:00:00Z",
    },
    {
      id: "new",
      remote_phone: "9876543210",
      predictive_queue: "8601",
      ended_at: null,
      started_at: "2026-11-17T06:00:00Z",
    },
    {
      id: "ended",
      remote_phone: "9876543210",
      predictive_queue: "8601",
      ended_at: "2026-11-17T06:10:00Z",
      started_at: "2026-11-17T06:05:00Z",
    },
    {
      id: "c2c",
      remote_phone: "9876543210",
      predictive_queue: null,
      ended_at: null,
      started_at: "2026-11-17T06:20:00Z",
    },
  ];

  test("open predictive call to that borrower, most recent first, any number format", () => {
    expect(pickPredictiveLedger(rows, "09876543210")?.id).toBe("new");
    expect(pickPredictiveLedger(rows.slice(0, 1), "919876543210")?.id).toBe("old");
  });

  test("never a click-to-call row, an ended row, or a short number", () => {
    expect(pickPredictiveLedger([rows[2], rows[3]], "9876543210")).toBeNull();
    expect(pickPredictiveLedger(rows, "8601")).toBeNull();
    expect(pickPredictiveLedger(rows, undefined)).toBeNull();
  });

  test("only an answer names the agent; a ringing event's extension is our own request", () => {
    expect(
      predictiveAgentFromEvent({ status: "ringing", agentHandle: "8001", alreadyAssigned: false }),
    ).toBeNull();
    expect(
      predictiveAgentFromEvent({
        status: "connected",
        agentHandle: "8002",
        alreadyAssigned: false,
      }),
    ).toBe("8002");
    expect(
      predictiveAgentFromEvent({ status: "connected", agentHandle: "8002", alreadyAssigned: true }),
    ).toBeNull();
    expect(predictiveAgentFromEvent({ status: "connected", alreadyAssigned: false })).toBeNull();
  });
});

describe("engine: vendor-routed legs", () => {
  const target = { id: "d1", name: "A", phone: "9876543210" };

  test("the answer's extension becomes the leg's agent", () => {
    let run = engine.newDialerRun({ id: "r", settings });
    const opened = engine.openLegs(run, [target], { idPrefix: "r", vendorRouted: true });
    run = engine.bindProviderCall(opened.run, opened.opened[0].id, "p1");
    expect(run.legs[0].vendorRouted).toBe(true);
    run = engine.applyLegEvent(run, { type: "ring", providerCallId: "p1", at: 1 });
    run = engine.applyLegEvent(run, {
      type: "answer",
      providerCallId: "p1",
      at: 2,
      agentHandle: "8001",
    });
    expect(run.legs[0]).toMatchObject({ state: "connected", agentHandle: "8001" });
    run = engine.applyLegEvent(run, {
      type: "hangup",
      providerCallId: "p1",
      at: 3,
      result: "completed",
      durationSeconds: 40,
    });
    expect(run.legs[0].state).toBe("completed");
    expect(run.stats.abandons).toBe(0);
  });

  test("answered but never put through to an agent → abandoned", () => {
    let run = engine.newDialerRun({ id: "r", settings });
    const opened = engine.openLegs(run, [target], { idPrefix: "r", vendorRouted: true });
    run = engine.bindProviderCall(opened.run, opened.opened[0].id, "p1");
    run = engine.applyLegEvent(run, { type: "ring", providerCallId: "p1", at: 1 });
    run = engine.applyLegEvent(run, { type: "answer", providerCallId: "p1", at: 2 });
    run = engine.applyLegEvent(run, {
      type: "hangup",
      providerCallId: "p1",
      at: 3,
      result: "completed",
      durationSeconds: 5,
    });
    expect(run.legs[0].state).toBe("abandoned");
    expect(run.stats.abandons).toBe(1);
  });

  test("click-to-call legs are unchanged (no agent on the answer, still completed)", () => {
    let run = engine.newDialerRun({ id: "r", settings });
    const opened = engine.openLegs(run, [target], { idPrefix: "r" });
    run = engine.bindProviderCall(opened.run, opened.opened[0].id, "p1");
    run = engine.applyLegEvent(run, { type: "ring", providerCallId: "p1", at: 1 });
    run = engine.applyLegEvent(run, { type: "answer", providerCallId: "p1", at: 2 });
    run = engine.applyLegEvent(run, {
      type: "hangup",
      providerCallId: "p1",
      at: 3,
      result: "completed",
      durationSeconds: 5,
    });
    expect(run.legs[0].state).toBe("completed");
  });
});

describe("simulator runs the same borrower-first flow", () => {
  test("answers go to free queued extensions; extra answers are abandoned; logout stops it", async () => {
    const sim = createSimProvider({ seed: 7 });
    const events: TelephonyEvent[] = [];
    sim.subscribe!((e) => events.push(e));
    await sim.predictive!.loginQueue("8001", "9999");

    // Dial plenty of borrowers on one agent so several answer at once.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const { providerCallId } = await sim.predictive!.startCall({
        extension: "8001",
        queue: "9999",
        debtorNumber: `98765432${String(i).padStart(2, "0")}`,
        requestId: `ledger-${i}`,
        hints: { aiScore: 10 },
      });
      ids.push(providerCallId);
    }
    expect(ids[0]).toBe("ledger-0"); // our ledger id is the handle
    sim.flushDue(Date.now() + 10_000); // everyone has rung, answered or not

    const answers = events.filter((e) => e.type === "answer");
    const abandoned = events.filter(
      (e) => e.type === "hangup" && e.result === "completed" && e.durationSeconds === 0,
    );
    // One agent: exactly one answer is put through, every other pickup is abandoned.
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ agentHandle: "8001" });
    expect(abandoned.length).toBeGreaterThan(0);

    // After the talk ends the agent is free again; after logout nobody is.
    sim.flushDue(Date.now() + 200_000);
    await sim.predictive!.logoutQueue("8001", "9999");
    events.length = 0;
    for (let i = 0; i < 8; i++)
      await sim.predictive!.startCall({
        extension: "8001",
        queue: "9999",
        debtorNumber: "9000000000",
        requestId: `after-${i}`,
        hints: { aiScore: 10 },
      });
    sim.flushDue(Date.now() + 300_000);
    expect(events.filter((e) => e.type === "answer")).toHaveLength(0);
  });

  test("engine + sim end to end: no agent is ever on two calls", async () => {
    const sim = createSimProvider({ seed: 3 });
    let run = engine.newDialerRun({ id: "run", settings });
    sim.subscribe!((e) => {
      run = engine.applyLegEvent(run, e);
    });
    const agents = ["8001", "8002"];
    for (const a of agents) await sim.predictive!.loginQueue(a, "9999");
    const targets = Array.from({ length: 30 }, (_, i) => ({
      id: `d${i}`,
      name: `D${i}`,
      phone: `98765432${String(i).padStart(2, "0")}`,
      aiScore: 8,
    }));

    let now = Date.now();
    let calls = 0;
    for (let tick = 0; tick < 40; tick++) {
      const free = freeAgentHandles(agents, run.legs);
      const dialed = new Set(run.legs.map((l) => l.debtorId));
      const remaining = targets.filter((t) => !dialed.has(t.id));
      const n = predictiveBatchSize({
        freeAgents: free.length,
        pending: pendingLegs(run.legs),
        linesPerAgent: 3,
        callsPerCycle: settings.callsPerCycle,
        lines: 10,
        remaining: remaining.length,
      });
      const opened = engine.openLegs(run, remaining.slice(0, n), {
        idPrefix: "run",
        vendorRouted: true,
      });
      run = opened.run;
      for (const l of opened.opened) {
        const { providerCallId } = await sim.predictive!.startCall({
          extension: requestExtension(free, agents, calls++) as string,
          queue: "9999",
          debtorNumber: l.phone,
          requestId: l.id,
        });
        run = engine.bindProviderCall(run, l.id, providerCallId);
      }
      now += 5_000;
      sim.flushDue(now);
      const live = run.legs.filter((l) => l.state === "connected" && l.agentHandle);
      const perAgent = new Set(live.map((l) => l.agentHandle));
      expect(perAgent.size).toBe(live.length);
    }
    expect(run.stats.attempts).toBeGreaterThan(agents.length); // it did overdial
    expect(run.legs.some((l) => l.agentHandle)).toBe(true);
  });
});

describe("SkyCRM predictive API (§24)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("login, predictive_call, logout: form-encoded with the spec's field names", async () => {
    const { skycrmProvider } =
      await import("../src/lib/telephony/skycrm-provider.ts?predictive-dial");
    const seen: Array<{ url: string; body: Record<string, string>; type: string | null }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      seen.push({
        url: String(url),
        body: Object.fromEntries(body.entries()),
        type: body instanceof URLSearchParams ? "form" : null,
      });
      return new Response('{"status":200}');
    }) as typeof fetch;

    const pd = skycrmProvider.predictive!;
    await pd.loginQueue("8480", "8601");
    const res = await pd.startCall({
      extension: "8480",
      queue: "8601",
      debtorNumber: "+91 98765 43210",
      requestId: "ledger-1",
    });
    await pd.logoutQueue("8480", "8601");

    expect(res.providerCallId).toBe("ledger-1");
    expect(seen.map((s) => s.url)).toEqual([
      "https://sky.test/login_in_queue1",
      "https://sky.test/predictive_call",
      "https://sky.test/logout_queue1",
    ]);
    expect(seen.every((s) => s.type === "form")).toBe(true);
    expect(seen[0].body).toEqual({ extension: "8480", queue: "8601" });
    expect(seen[1].body).toEqual({
      extension: "8480",
      prefix: "8480",
      queue: "8601",
      mobile_no: "9876543210",
    });
    expect(seen[2].body).toEqual({ extension: "8480", queue: "8601" });
  });

  test("a refusal (status 300) throws, so the dialer closes that ledger row", async () => {
    const { skycrmProvider } =
      await import("../src/lib/telephony/skycrm-provider.ts?predictive-dial");
    globalThis.fetch = (async () =>
      new Response('{"status":300,"error":"queue not found"}')) as unknown as typeof fetch;
    await expect(
      skycrmProvider.predictive!.startCall({
        extension: "8480",
        queue: "1",
        debtorNumber: "9876543210",
        requestId: "x",
      }),
    ).rejects.toThrow();
  });
});

describe("caller-number prefix (2026-11-20)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function capture() {
    const seen: Array<{ path: string; body: Record<string, string> }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({
        path: String(url).replace("https://sky.test/", ""),
        body: Object.fromEntries((init?.body as URLSearchParams).entries()),
      });
      return new Response('{"status":200}');
    }) as typeof fetch;
    return seen;
  }

  test("click-to-call, predictive and hangup send the chosen number's prefix", async () => {
    const { skycrmProvider } =
      await import("../src/lib/telephony/skycrm-provider.ts?predictive-dial");
    const seen = capture();
    await skycrmProvider.startCall({
      agentNumber: "8480",
      debtorNumber: "9876543210",
      callLogId: "c1",
      requestId: "l1",
      callerPrefix: "3701",
    });
    await skycrmProvider.predictive!.startCall({
      extension: "8480",
      queue: "3101",
      debtorNumber: "9876543210",
      requestId: "l2",
      callerPrefix: "3703",
    });
    await skycrmProvider.hangup("l1", {
      agentHandle: "8480",
      remotePhone: "9876543210",
      prefix: "3701",
    });
    expect(seen.find((s) => s.path === "dialing_phone")?.body.prefix).toBe("3701");
    expect(seen.find((s) => s.path === "predictive_call")?.body.prefix).toBe("3703");
    expect(seen.find((s) => s.path === "hangup_phone")?.body.prefix).toBe("3701");
  });

  test("no number chosen (company has none) → the extension, as before", async () => {
    const { skycrmProvider } =
      await import("../src/lib/telephony/skycrm-provider.ts?predictive-dial");
    const seen = capture();
    await skycrmProvider.startCall({
      agentNumber: "8480",
      debtorNumber: "9876543210",
      callLogId: "c1",
      requestId: "l1",
    });
    expect(seen.find((s) => s.path === "dialing_phone")?.body.prefix).toBe("8480");
  });

  test("an outbound CDR's prefix + number keeps only the borrower's number", async () => {
    const { skycrmProvider } =
      await import("../src/lib/telephony/skycrm-provider.ts?predictive-dial");
    for (const dst of ["37019876543210", "84809876543210"]) {
      const e = skycrmProvider.parseStatusWebhook({
        callid: "1.2",
        src: "8480",
        dst,
        disposition: "ANSWERED",
        billsec: "30",
        direction: "Outbound",
      });
      expect(e.remotePhone).toBe("9876543210");
      expect(e.agentHandle).toBe("8480");
    }
  });
});

describe("browser bundle guard", () => {
  test("sweepRuns (reachable from ingestCallStatusEvent) never touches the provider", async () => {
    const src = await Bun.file("src/lib/telephony/server.ts").text();
    const body = src.slice(
      src.indexOf("function sweepRuns"),
      src.indexOf("/** Log out the queue sessions"),
    );
    expect(body.length).toBeGreaterThan(100);
    const code = body.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/getTelephonyProvider|endPredictiveSession|logoutSession|prov\./);
  });
});
