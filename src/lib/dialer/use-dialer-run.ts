// Client hook that drives a dialer run for a live view. This pass runs in "local" mode:
// the SAME pure engine + simulated provider execute in the browser, progressing legs
// through the real call state machine — replacing the old ad-hoc setTimeout mock.
//
// "server" mode is wired (via a dynamic import of the server functions) for when a real
// SIP provider is integrated: the dialer must then run server-side (keys + always-on), and
// switching is just passing mode: "server" — no other UI change. It is dynamically imported
// so the server module (which reaches vendor code) never enters the eager client bundle.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PortfolioSettings } from "@/lib/portfolio-store";
import * as engine from "@/lib/dialer/engine";
import type { DialTarget, DialerRun } from "@/lib/dialer/engine";
import { createSimProvider, type SimProvider } from "@/lib/telephony/sim-provider";
import type { CallRecord, TelephonyEvent } from "@/lib/telephony/types";
import { toLiveEntries } from "./live-adapter";
import type { LiveCallEntry } from "@/routes/dashboard.call-queue";

const TICK_MS = 1500;

export interface StartArgs {
  settings: PortfolioSettings;
  targets: DialTarget[];
  /** Concurrent lines the run may open (team lines visible in the live view) */
  agentsAvailable?: number;
  mode?: "local" | "server";
}

export interface UseDialerRun {
  running: boolean;
  legs: LiveCallEntry[];
  stats: DialerRun["stats"] | null;
  start: (args: StartArgs) => Promise<void>;
  stop: () => Promise<void>;
}

export function useDialerRun(): UseDialerRun {
  const [, forceRender] = useState(0);
  const runRef = useRef<DialerRun | null>(null);
  const simRef = useRef<SimProvider | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const modeRef = useRef<"local" | "server">("local");
  const runIdRef = useRef<string>("");
  const targetsRef = useRef<DialTarget[]>([]);
  const agentsRef = useRef(1);

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
    async ({ settings, targets, agentsAvailable = 3, mode = "local" }: StartArgs) => {
      clearTimer();
      teardownSim();
      const runId = `run-${Date.now()}`;
      runIdRef.current = runId;
      modeRef.current = mode;
      targetsRef.current = targets;
      agentsRef.current = agentsAvailable;

      if (mode === "server") {
        // Real-provider path — background dialing runs server-side. Dynamically imported so
        // vendor/server code never ships in the eager client bundle.
        const srv = await import("@/lib/telephony/server");
        const started = await srv.startDialerRun({
          data: { runId, settings, targets, agentsAvailable },
        });
        if (started) runRef.current = started;
        render();
        timerRef.current = setInterval(async () => {
          const ticked = await srv.tickDialerRun({ data: { runId, agentsAvailable, targets } });
          if (ticked) runRef.current = ticked;
          render();
        }, TICK_MS);
        return;
      }

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
        agentsAvailable,
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
      const stopped = await srv.stopDialerRun({ data: { runId: runIdRef.current } });
      if (stopped) runRef.current = stopped;
      render();
      return;
    }
    teardownSim();
    if (runRef.current) runRef.current = engine.stopDialerRun(runRef.current);
    render();
  }, [render]);

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
  };
}
