// Predictive/background dialer engine — the logic that was missing.
//
// It consumes the EXISTING PortfolioSettings (src/lib/portfolio-store.ts) — callMode,
// dialerMode, callsPerCycle, abandonRateTarget, the rechurn* rules, ptpFollowupHours,
// callbackBufferMins — and turns them into concrete dialing decisions and a DialerRun
// state that the server orchestrator advances.
//
// PURE + server-runnable: no browser globals, no Supabase/network. PortfolioSettings and
// CallMode are TYPE-ONLY imports (erased at compile time), so this never pulls the
// supabase client into the bundle — same technique as src/lib/call-session.tsx.
import type { PortfolioSettings, CallMode } from "@/lib/portfolio-store";
import type { CallRecord, TerminalCallState, TelephonyEvent } from "@/lib/telephony/types";
import { applyEvent, isTerminal } from "@/lib/telephony/call-machine";

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** Minimal debtor shape the engine needs. The UI adapter maps a QueueDebtor onto this,
 * keeping the engine decoupled from the (browser-heavy) route module. */
export interface DialTarget {
  id: string;
  name: string;
  phone: string;
  portfolioId?: string;
  /** 1-10; biases answer probability in the simulated provider */
  aiScore?: number;
  bestContactTime?: "morning" | "afternoon" | "evening" | "any";
  /** Numbers to fall back to (in order) if `phone` doesn't connect — CSV alt_phones plus any
   * an agent added by hand. Only consulted by planProductiveBatch below. */
  altPhones?: string[];
}

export type RouteTarget = "agent" | "ai" | "ivr";

/** IVR keypress that means "connect me to a human" — bridges an ivr leg to an agent. */
export const IVR_CONNECT_DIGIT = "1";

// ─── Mode routing ──────────────────────────────────────────────────────────────

/** Which handler an answered call goes to, per the portfolio's call mode. */
export function routeAnsweredCall(callMode: CallMode): RouteTarget {
  switch (callMode) {
    case "agent_only":
      return "agent";
    case "ai_only":
      return "ai";
    case "ivr_agent":
      return "ivr"; // IVR plays a menu; bridges to an agent on IVR_CONNECT_DIGIT
    case "hybrid":
      return "ai"; // AI handles first; transfers to an agent on escalation
  }
}

// ─── Pacing ─────────────────────────────────────────────────────────────────────

/** Predictive overdial multiplier. A higher allowed abandon rate lets the dialer place
 * more lines per free agent to keep them busy. abandonRateTarget of 3% → ~1.6x. */
export function predictivePacing(abandonRateTarget: number): number {
  const clamped = Math.max(0, Math.min(abandonRateTarget, 10));
  return 1 + clamped * 0.2;
}

/** Lines the dialer may open given the mode and how many agents are free right now. */
export function dialCapacity(settings: PortfolioSettings, agentsAvailable: number): number {
  switch (settings.dialerMode) {
    case "predictive":
      return Math.round(agentsAvailable * predictivePacing(settings.abandonRateTarget));
    case "power":
      return agentsAvailable; // one line per agent, no overdial
    case "productive":
      // Exactly one line, always — regardless of agent pool size. planDialBatch subtracts
      // inFlight from this, so the next debtor only opens once the current leg goes terminal:
      // dial, wait for ringing/no-answer/connected, then move to the next. No overdial, no
      // parallel lines — the opposite tradeoff from predictive.
      return 1;
    case "preview":
    case "manual":
      return 0; // agent launches each call manually — nothing auto-dialed
  }
}

/** Parse "HH:MM-HH:MM" and test whether `now` falls inside it (local time). */
export function withinTimeWindow(window: string, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(window.trim());
  if (!m) return true; // malformed window → don't block dialing
  const [, sh, sm, eh, em] = m;
  const start = Number(sh) * 60 + Number(sm);
  const end = Number(eh) * 60 + Number(em);
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

export interface DialPlanInput {
  settings: PortfolioSettings;
  /** Eligible debtors (already filtered: not terminal today, PTP/callback not pending) */
  queue: DialTarget[];
  /** Agents free to take a connected call right now */
  agentsAvailable: number;
  /** Currently live/ringing legs already occupying capacity */
  inFlight: number;
  now?: Date;
}

/** Decide which debtors to dial this cycle. Honors the time window, the mode's pacing,
 * the per-cycle cap, and current in-flight load. Returns [] when nothing should dial. */
export function planDialBatch(input: DialPlanInput): DialTarget[] {
  const { settings, queue, agentsAvailable, inFlight } = input;
  const now = input.now ?? new Date();
  if (!withinTimeWindow(settings.rechurnTimeWindow, now)) return [];
  const capacity = dialCapacity(settings, agentsAvailable) - inFlight;
  const n = Math.max(0, Math.min(capacity, settings.callsPerCycle, queue.length));
  return queue.slice(0, n);
}

/** Productive dialing's own scheduler — walks `queue` in order and, for whichever debtor is
 * "current", tries their primary number, then each altPhones entry in turn, before moving on
 * to the next debtor. A debtor is skipped entirely once any of its legs connects. Unlike
 * planDialBatch this needs the full leg history (not just a count), since "next" depends on
 * which numbers have already been tried — so it always returns 0 or 1 targets (productive
 * dialing forces capacity to exactly one line; see dialCapacity above). */
export function planProductiveBatch(queue: DialTarget[], legs: CallRecord[]): DialTarget[] {
  for (const target of queue) {
    const legsForDebtor = legs.filter((l) => l.debtorId === target.id);
    if (legsForDebtor.some((l) => connected(l))) continue; // reached a human — next debtor
    if (legsForDebtor.some((l) => !isTerminal(l.state))) return []; // still ringing — wait
    const tried = new Set(legsForDebtor.map((l) => l.phone));
    const candidates = [target.phone, ...(target.altPhones ?? [])];
    const nextPhone = candidates.find((p) => p && !tried.has(p));
    if (nextPhone) return [{ ...target, phone: nextPhone }];
    // every number tried, none connected — fall through to the next debtor
  }
  return [];
}

// ─── Re-churn / follow-up scheduling ─────────────────────────────────────────────

export interface RechurnInput {
  settings: PortfolioSettings;
  /** How the just-ended attempt terminated */
  terminalState: TerminalCallState;
  /** Provider signalled the no-answer was actually a voicemail pickup */
  voicemail?: boolean;
  /** 1-based attempt number that just ended */
  attempt: number;
  now?: Date;
}

export interface RechurnDecision {
  reschedule: boolean;
  nextAttemptAt?: number; // epoch ms
  reason?: string;
}

/** Whether (and when) to re-dial a debtor after a failed attempt, per the portfolio's
 * autoRechurn rules and max-cycles cap. */
export function applyRechurn(input: RechurnInput): RechurnDecision {
  const { settings, terminalState, voicemail, attempt } = input;
  const now = input.now ?? new Date();

  if (!settings.autoRechurn) return { reschedule: false, reason: "auto-rechurn off" };
  if (attempt >= settings.rechurnMaxCycles)
    return { reschedule: false, reason: "max cycles reached" };

  const eligible = voicemail
    ? settings.rechurnOnVoicemail
    : (terminalState === "no_answer" && settings.rechurnOnNoAnswer) ||
      (terminalState === "busy" && settings.rechurnOnBusy);
  if (!eligible)
    return {
      reschedule: false,
      reason: `no rechurn rule for ${voicemail ? "voicemail" : terminalState}`,
    };

  const nextAttemptAt = now.getTime() + settings.rechurnAfterDays * 24 * 60 * 60 * 1000;
  return {
    reschedule: true,
    nextAttemptAt,
    reason: `rechurn after ${voicemail ? "voicemail" : terminalState}`,
  };
}

/** When to follow up on a promise-to-pay, from ptpFollowupHours. */
export function ptpFollowUpAt(settings: PortfolioSettings, ptpMadeAt: Date): number {
  return ptpMadeAt.getTime() + settings.ptpFollowupHours * 60 * 60 * 1000;
}

/** When a requested callback should surface, offset by callbackBufferMins. */
export function callbackSlotAt(settings: PortfolioSettings, requestedAt: Date): number {
  return requestedAt.getTime() + settings.callbackBufferMins * 60 * 1000;
}

// ─── DialerRun state ─────────────────────────────────────────────────────────────

export interface DialerRunStats {
  attempts: number;
  connects: number;
  abandons: number;
  noAnswers: number;
  completed: number;
  /** Abandoned / (abandoned + connected), as a percentage — compare to abandonRateTarget */
  liveAbandonRate: number;
}

export interface DialerRun {
  id: string;
  portfolioId?: string;
  settings: PortfolioSettings;
  startedAt: number;
  running: boolean;
  /** Active + recently-ended legs (caller may prune terminals) */
  legs: CallRecord[];
  stats: DialerRunStats;
}

function connected(leg: CallRecord): boolean {
  return leg.state === "connected" || leg.state === "wrapup" || leg.state === "completed";
}

export function recomputeStats(legs: CallRecord[]): DialerRunStats {
  const attempts = legs.length;
  const connects = legs.filter(connected).length;
  const abandons = legs.filter((l) => l.state === "abandoned").length;
  const noAnswers = legs.filter((l) => l.state === "no_answer").length;
  const completed = legs.filter((l) => l.state === "completed").length;
  const denom = connects + abandons;
  const liveAbandonRate = denom > 0 ? Math.round((abandons / denom) * 1000) / 10 : 0;
  return { attempts, connects, abandons, noAnswers, completed, liveAbandonRate };
}

export function newDialerRun(args: {
  id: string;
  settings: PortfolioSettings;
  portfolioId?: string;
  now?: Date;
}): DialerRun {
  return {
    id: args.id,
    portfolioId: args.portfolioId,
    settings: args.settings,
    startedAt: (args.now ?? new Date()).getTime(),
    running: true,
    legs: [],
    stats: recomputeStats([]),
  };
}

/** Open new outbound legs for the planned targets. Participant is set from the portfolio
 * call mode now; ivr/hybrid legs may later bridge to an agent (see applyLegEvent). Returns
 * the updated run and the newly-created legs (so the caller can startCall each via the provider). */
export function openLegs(
  run: DialerRun,
  targets: DialTarget[],
  opts?: { idPrefix?: string; now?: number },
): { run: DialerRun; opened: CallRecord[] } {
  const now = opts?.now ?? Date.now();
  const prefix = opts?.idPrefix ?? "leg";
  const participant = routeAnsweredCall(run.settings.callMode);
  const opened: CallRecord[] = targets.map((t, i) => ({
    id: `${prefix}-${run.legs.length + i}`,
    debtorId: t.id,
    debtorName: t.name,
    phone: t.phone,
    portfolioId: t.portfolioId ?? run.portfolioId,
    direction: "outbound",
    participant,
    state: "dialing",
    attempt: 1,
    queuedAt: now,
  }));
  const legs = [...run.legs, ...opened];
  return { run: { ...run, legs, stats: recomputeStats(legs) }, opened };
}

/** Correlate a provider's call id back to a leg once startCall resolves. */
export function bindProviderCall(run: DialerRun, legId: string, providerCallId: string): DialerRun {
  const legs = run.legs.map((l) => (l.id === legId ? { ...l, providerCallId } : l));
  return { ...run, legs };
}

/** Apply a normalized provider event to whichever leg it targets. Advances the call state
 * via the shared state machine, stamps lifecycle timestamps, records DTMF, and bridges an
 * IVR leg to an agent on the connect digit. */
export function applyLegEvent(run: DialerRun, event: TelephonyEvent): DialerRun {
  if (event.type === "sms_status") return run; // not a call leg
  const legs = run.legs.map((leg) => {
    if (leg.providerCallId !== event.providerCallId) return leg;
    const nextState = applyEvent(leg.state, event);
    const updated: CallRecord = { ...leg, state: nextState };
    if (event.type === "ring" && !updated.ringingAt) updated.ringingAt = event.at;
    if (event.type === "answer" && !updated.connectedAt) updated.connectedAt = event.at;
    if (event.type === "dtmf") {
      updated.dtmf = [...(updated.dtmf ?? []), event.digit];
      // IVR menu bridges to a human when the debtor presses the connect digit.
      if (leg.participant === "ivr" && event.digit === IVR_CONNECT_DIGIT)
        updated.participant = "agent";
    }
    if (event.type === "recording") updated.recordingUrl = event.recordingUrl;
    if (event.type === "hangup") {
      updated.endedAt = event.at;
      updated.durationSeconds = event.durationSeconds;
    }
    return updated;
  });
  return { ...run, legs, stats: recomputeStats(legs) };
}

/** Stop a run: mark it not-running and abandon any leg still live (a predictive abandon). */
export function stopDialerRun(run: DialerRun, now = Date.now()): DialerRun {
  const legs = run.legs.map((leg) =>
    isTerminal(leg.state) ? leg : { ...leg, state: "abandoned" as const, endedAt: now },
  );
  return { ...run, running: false, legs, stats: recomputeStats(legs) };
}
