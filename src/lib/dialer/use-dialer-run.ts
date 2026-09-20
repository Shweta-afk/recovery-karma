// Client hook that drives a dialer run for a live view. Default "server" mode:
// the dialer runs server-side through the real SIP provider (keys + always-on).
// The client polls for updates, which get mapped through the call state machine.
//
// "local" mode (for development/testing) runs the engine + simulated provider in the browser,
// progressing legs through the real call state machine — replacing the old ad-hoc setTimeout mock.
//
// Server mode is wired via dynamic import of the server functions so the server module
// (which reaches vendor code) never enters the eager client bundle.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PortfolioSettings } from "@/lib/portfolio-store";
import * as engine from "@/lib/dialer/engine";
import type { DialTarget, DialerRun } from "@/lib/dialer/engine";
import { createSimProvider, type SimProvider } from "@/lib/telephony/sim-provider";
import type { CallRecord, TelephonyEvent } from "@/lib/telephony/types";
import { toLiveEntries } from "./live-adapter";
import { getAccessToken } from "@/lib/access-token";
import type { LiveCallEntry } from "@/routes/dashboard.call-queue";

const TICK_MS = 1500;

export interface StartArgs {
  settings: PortfolioSettings;
  targets: DialTarget[];
  /** Concurrent lines the run may open (team lines visible in the live view) */
  agentsAvailable?: number;
  /** Phone numbers of the agents on shift. In server mode these are the legs the provider
   * rings first, so the pool size is the real concurrency ceiling — see dial() in
   * telephony/server.ts for why this cannot overdial. */
  agentNumbers?: string[];
  /** DID shown to the debtor; must be a caller ID assigned to the provider account. */
  callerId?: string;
  mode?: "local" | "server";
}

export interface UseDialerRun {
  running: boolean;
  legs: LiveCallEntry[];
  stats: DialerRun["stats"] | null;
  start: (args: StartArgs) => Promise<void>;
  stop: () => Promise<void>;
  /** Ends one leg (agent's End Call on a connected — or ringing — predictive-dialer call)
   * without touching the rest of the run. stop() above always ends every leg; this is the
   * per-leg equivalent the Live Calls panel needs. */
  endLeg: (legId: string) => Promise<void>;
}

export function useDialerRun(): UseDialerRun {
  const [, forceRender] = useState(0);
  const runRef = useRef<DialerRun | null>(null);
  const simRef = useRef<SimProvider | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modeRef = useRef<"local" | "server">("server");
  const runIdRef = useRef<string>("");
  const targetsRef = useRef<DialTarget[]>([]);
  const agentsRef = useRef(1);
  const agentNumbersRef = useRef<string[]>([]);
  const callerIdRef = useRef<string | undefined>(undefined);

  const render = useCallback(() => forceRender((n) => n + 1), []);
  const clearTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  };
  const teardownSim = () => {
    unsubRef.current?.();
    unsubRef.current = null;
    simRef.current = null;
  };

  const placeCalls = useCallback(
    async (run: DialerRun, opened: CallRecord[]): Promise<DialerRun> => {
      const sim = simRef.current;
      if (!sim) return run;
      let next = run;
      for (const leg of opened) {
        const t = targetsRef.current.find((x) => x.id === leg.debtorId);
        const { providerCallId } = await sim.startCall({
          agentNumber: "sim-agent",
          debtorNumber: leg.phone,
          callLogId: leg.id,
          hints: {
            aiScore: t?.aiScore,
            bestContactTime: t?.bestContactTime,
            ivr: run.settings.callMode === "ivr_agent" || run.settings.callMode === "hybrid",
          },
        });
        next = engine.bindProviderCall(next, leg.id, providerCallId);
      }
      return next;
    },
    [],
  );

  const start = useCallback(
    async ({
      settings,
      targets,
      agentsAvailable,
      agentNumbers = [],
      callerId,
      mode = "server",
    }: StartArgs) => {
      clearTimer();
      teardownSim();
      const runId = `run-${Date.now()}`;
      runIdRef.current = runId;
      modeRef.current = mode;
      targetsRef.current = targets;
      // Default the line count to the agent pool: one click-to-call leg per agent.
      const lines = agentsAvailable ?? (agentNumbers.length || 3);
      agentsRef.current = lines;
      agentNumbersRef.current = agentNumbers;
      callerIdRef.current = callerId;

      if (mode === "server") {
        // Real-provider path — background dialing runs server-side. Dynamically imported so
        // vendor/server code never ships in the eager client bundle.
        const srv = await import("@/lib/telephony/server");
        const started = await srv.startDialerRun({
          data: {
            accessToken: await getAccessToken(),
            runId,
            settings,
            targets,
            agentsAvailable: lines,
            agentNumbers,
            callerId,
          },
        });
        if (started) runRef.current = started;
        render();
        timerRef.current = setInterval(async () => {
          const ticked = await srv.tickDialerRun({
            data: {
              accessToken: await getAccessToken(),
              runId,
              agentsAvailable: lines,
              targets,
              agentNumbers,
              callerId,
            },
          });
          if (ticked) runRef.current = ticked;
          render();
        }, TICK_MS);
        return;
      }
      const agentsAvailableLocal = lines;

      // Local mode: engine + simulated provider, in-browser.
      const sim = createSimProvider();
      simRef.current = sim;
      unsubRef.current =
        sim.subscribe?.((e: TelephonyEvent) => {
          if (runRef.current) runRef.current = engine.applyLegEvent(runRef.current, e);
        }) ?? null;

      let run = engine.newDialerRun({ id: runId, settings });
      const batch = engine.planDialBatch({
        settings,
        queue: targets,
        agentsAvailable: agentsAvailableLocal,
        inFlight: 0,
      });
      const opened = engine.openLegs(run, batch, { idPrefix: runId });
      run = await placeCalls(opened.run, opened.opened);
      runRef.current = run;
      render();

      timerRef.current = setInterval(() => {
        simRef.current?.flushDue(Date.now());
        render(); // re-map legs + tick live durations
      }, TICK_MS);
    },
    [placeCalls, render],
  );

  const stop = useCallback(async () => {
    clearTimer();
    if (modeRef.current === "server") {
      const srv = await import("@/lib/telephony/server");
      const stopped = await srv.stopDialerRun({
        data: { accessToken: await getAccessToken(), runId: runIdRef.current },
      });
      if (stopped) runRef.current = stopped;
      render();
      return;
    }
    teardownSim();
    if (runRef.current) runRef.current = engine.stopDialerRun(runRef.current);
    render();
  }, [render]);

  const endLeg = useCallback(
    async (legId: string) => {
      const run = runRef.current;
      if (!run) return;
      if (modeRef.current === "server") {
        const srv = await import("@/lib/telephony/server");
        const updated = await srv.hangupDialerLeg({
          data: { accessToken: await getAccessToken(), runId: runIdRef.current, legId },
        });
        if (updated) runRef.current = updated;
        render();
        return;
      }
      // Local mode: schedule the hangup through the sim — it flows through the same
      // subscribe -> applyLegEvent pipeline as any other event on the next flushDue tick.
      const leg = run.legs.find((l) => l.id === legId);
      if (leg?.providerCallId) await simRef.current?.hangup(leg.providerCallId);
    },
    [render],
  );

  useEffect(
    () => () => {
      clearTimer();
      teardownSim();
    },
    [],
  );

  const run = runRef.current;
  return {
    running: run?.running ?? false,
    legs: run ? toLiveEntries(run.legs) : [],
    stats: run?.stats ?? null,
    start,
    stop,
    endLeg,
  };
}
