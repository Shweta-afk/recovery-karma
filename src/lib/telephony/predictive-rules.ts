// Pure rules for vendor-side predictive dialling (SkyCRM API v1.2 §24): the borrower is dialled
// FIRST and the vendor connects whoever answers to a free extension logged into a queue. No I/O,
// so scripts/predictive-dial.test.ts covers every branch; telephony/server.ts calls these.
//
// Lifecycle of one batch ("Productive Dial", internally dialerMode "predictive"):
//   1. login_in_queue1(extension, queue) once per agent on the run
//   2. predictive_call(extension, prefix, queue, mobile_no) once per borrower — each still goes
//      through prepareCall (do-not-call, IST window, channel reservation, ledger row)
//   3. logout_queue1(extension, queue) once per agent when the run stops or is evicted
// The agent is unknown until the vendor's Answered event names the extension.

import { isTerminal } from "./call-machine";
import { normalisePhone } from "./guard-rules";
import type { CallRecord } from "./types";

/** A SkyCRM queue number: 3–6 digits (8601, 4003). */
const QUEUE_RE = /^\d{3,6}$/;

/** "8601" → "8601"; blank → null; anything else is refused with the reason. The setting holds ONE
 *  queue: predictive_call takes a single queue, so a list would leave which one ambiguous. */
export function parsePredictiveQueue(
  raw: string | null | undefined,
): { ok: true; queue: string | null } | { ok: false; message: string } {
  const s = (raw ?? "").trim();
  if (!s) return { ok: true, queue: null };
  if (!QUEUE_RE.test(s))
    return {
      ok: false,
      message: "The predictive queue must be one SkyCRM queue number (3–6 digits).",
    };
  return { ok: true, queue: s };
}

/** How a "Productive Dial" run places its calls.
 *  - "vendor": the provider dials borrowers and routes answers to the queue (true predictive).
 *  - "click_to_call": the old way — each line rings an agent first, so at most one line per agent.
 *  Vendor mode needs a provider that offers it and, for a real provider, a queue set on the
 *  company (Superadmin → company → Calling). The simulator gets a stand-in queue so the same flow
 *  runs in development without any setting. */
export function predictiveMode(args: {
  dialerMode: string;
  provider: string;
  providerSupportsPredictive: boolean;
  predictiveQueue: string | null | undefined;
}): { mode: "vendor"; queue: string } | { mode: "click_to_call" } {
  if (args.dialerMode !== "predictive" || !args.providerSupportsPredictive)
    return { mode: "click_to_call" };
  const parsed = parsePredictiveQueue(args.predictiveQueue);
  if (parsed.ok && parsed.queue) return { mode: "vendor", queue: parsed.queue };
  if (args.provider === "sim") return { mode: "vendor", queue: SIM_QUEUE };
  return { mode: "click_to_call" };
}

export const SIM_QUEUE = "9999";

/** Agents on the run who are not on a predictive call right now (their extension isn't on any
 *  connected leg). A leg whose answer named no extension doesn't hold anyone. */
export function freeAgentHandles(handles: string[], legs: CallRecord[]): string[] {
  const busy = new Set(
    legs.filter((l) => !isTerminal(l.state) && l.agentHandle).map((l) => l.agentHandle as string),
  );
  return handles.filter((h) => !busy.has(h));
}

/** Borrower calls that will still need an agent: ringing, or answered and waiting in the queue
 *  for a free extension (answered with no agent named yet). */
export function pendingLegs(legs: CallRecord[]): number {
  return legs.filter(
    (l) =>
      l.state === "queued" ||
      l.state === "dialing" ||
      l.state === "ringing" ||
      (l.vendorRouted && !l.agentHandle && (l.state === "connected" || l.state === "wrapup")),
  ).length;
}

export const DEFAULT_LINES_PER_AGENT = 5;
export const MAX_LINES_PER_AGENT = 10;

/** Borrowers Productive Dial rings at once for each free agent — set per portfolio by its manager
 *  or an admin (PortfolioSettings.linesPerAgent, user 2026-11-20: default 5). Portfolios saved
 *  before the setting existed get the default; anything outside 1–10 is clamped (the value comes
 *  from the browser). */
export function linesPerAgent(settings: { linesPerAgent?: number } | null | undefined): number {
  const n = Math.round(Number(settings?.linesPerAgent ?? DEFAULT_LINES_PER_AGENT));
  if (!Number.isFinite(n)) return DEFAULT_LINES_PER_AGENT;
  return Math.max(1, Math.min(MAX_LINES_PER_AGENT, n));
}

/**
 * How many new borrowers to dial this tick.
 *   target = free agents × lines per agent − calls still waiting for an agent (pendingLegs)
 * capped by the portfolio's calls-per-cycle (how fast lines open, per tick), the company's free
 * lines and what is left to dial. So with 5 lines per agent and one free agent, five borrowers
 * ring at once; as each one ends, another is dialled.
 */
export function predictiveBatchSize(args: {
  freeAgents: number;
  pending: number;
  linesPerAgent: number;
  callsPerCycle: number;
  lines: number;
  remaining: number;
}): number {
  if (args.freeAgents <= 0) return 0;
  const target = args.freeAgents * args.linesPerAgent - args.pending;
  return Math.max(0, Math.min(target, args.callsPerCycle, args.lines, args.remaining));
}

/** A predictive call the vendor never acknowledged (no callid, no event) after this long is taken
 *  as never dialled and closed, so it stops holding a line and the agent's pacing (2026-11-21:
 *  19 such calls held Axiotta's lines for up to 2 h and every dial got "lines busy"). */
export const SILENT_PREDICTIVE_SECONDS = 120;

export interface OpenPredictiveRow {
  id: string;
  request_extension: string | null;
  agent_handle: string | null;
  vendor_callid: string | null;
  vendor_events: string | null;
  started_at: string;
}

/**
 * The company's open predictive ledger rows, read for one batch. Pacing must count calls across
 * EVERY run on these agents, not just this run's legs: on 2026-11-21 one agent pressed Start five
 * times in 24 s, each run paced itself to 5 and ext 8603 had ~25 lines open.
 *   silent  — rows to close (never acknowledged by the vendor, older than SILENT_PREDICTIVE_SECONDS)
 *   waiting — rows requested for these agents still waiting for someone to take them
 *   busy    — these agents already on a predictive call (the answer named them)
 */
export function sortOpenPredictive<T extends OpenPredictiveRow>(
  rows: T[],
  handles: string[],
  nowMs: number,
): { silent: T[]; waiting: number; busy: string[] } {
  const mine = new Set(handles);
  const silent: T[] = [];
  const busy = new Set<string>();
  let waiting = 0;
  for (const r of rows) {
    const ageS = (nowMs - Date.parse(r.started_at)) / 1000;
    const heard = !!r.vendor_callid || !!(r.vendor_events ?? "").trim();
    if (!heard && ageS > SILENT_PREDICTIVE_SECONDS) {
      silent.push(r);
      continue;
    }
    if (r.agent_handle) {
      if (mine.has(r.agent_handle)) busy.add(r.agent_handle);
      continue;
    }
    if (r.request_extension && mine.has(r.request_extension)) waiting++;
  }
  return { silent, waiting, busy: [...busy] };
}

/** Other predictive runs of this company that share an agent with a run being started. The new
 *  run replaces them, so one agent never has two runs dialling for them at once. */
export function runsSharingAgents(
  sessions: { runId: string; clientId: string; handles: string[] }[],
  args: { runId: string; clientId: string; handles: string[] },
): string[] {
  const want = new Set(args.handles);
  return sessions
    .filter(
      (s) =>
        s.runId !== args.runId &&
        s.clientId === args.clientId &&
        s.handles.some((h) => want.has(h)),
    )
    .map((s) => s.runId);
}

/** Which agent's extension goes in predictive_call's `extension` field. The vendor connects the
 *  answer to any free extension in the queue, so this only spreads requests (and the token's
 *  extension) across the run's agents; free agents first, round robin by call number. */
export function requestExtension(free: string[], all: string[], callNumber: number): string | null {
  const pool = free.length ? free : all;
  if (!pool.length) return null;
  return pool[callNumber % pool.length];
}

export interface PredictiveLedgerCandidate {
  id: string;
  remote_phone: string | null;
  predictive_queue?: string | null;
  ended_at: string | null;
  started_at?: string | null;
}

/** The open predictive call a webhook event belongs to, by the borrower's number. The ledger row
 *  has no agent until the Answered event names one, so the extension can't find it; the number
 *  can, because one company never has two open predictive calls to the same borrower (the dialer
 *  dials each borrower once per tick and the same number is not re-dialled while a call is open).
 *  Most recent first if that ever fails. */
export function pickPredictiveLedger<T extends PredictiveLedgerCandidate>(
  rows: T[],
  remotePhone: string | undefined,
): T | null {
  const want = remotePhone ? normalisePhone(remotePhone) : "";
  if (want.length !== 10) return null;
  const hits = rows
    .filter(
      (r) =>
        !!r.predictive_queue &&
        !r.ended_at &&
        r.remote_phone != null &&
        normalisePhone(r.remote_phone) === want,
    )
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  return hits[0] ?? null;
}

/** Whether an event on a predictive call tells us which agent took it. A ringing event may carry
 *  the extension WE sent in the request, which is not who answers; only an answer (or a final
 *  event after one) names the agent. */
export function predictiveAgentFromEvent(args: {
  status: string;
  agentHandle?: string;
  alreadyAssigned: boolean;
}): string | null {
  if (args.alreadyAssigned || !args.agentHandle) return null;
  return args.status === "connected" ? args.agentHandle : null;
}
