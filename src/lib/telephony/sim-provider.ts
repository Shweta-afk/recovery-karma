// Simulated telephony provider — a deterministic carrier emulator that stands in for a
// real SIP/CPaaS vendor until numbers are integrated. It implements the SAME
// TelephonyProvider contract, so switching to KooKoo/real SIP later is just swapping the
// factory default — no engine, server, or UI change.
//
// It emits the normalized TelephonyEvent stream (ring → answer → dtmf/recording → hangup)
// on a scheduler keyed to absolute timestamps. A driver (server tick, browser interval, or
// test) calls flushDue(now) to release due events to subscribers — the same events a real
// webhook would produce. PURE of app/store deps; safe on server and in tests.
import type {
  TelephonyProvider,
  StartCallRequest,
  StartCallResult,
  SendSmsRequest,
  SendSmsResult,
  CallStatusEvent,
  CallStatus,
  TelephonyEvent,
  TelephonyEventListener,
  TerminalCallState,
  PredictiveCallRequest,
} from "./types";

export interface SimProvider extends TelephonyProvider {
  /** Release every event scheduled at or before `now` to subscribers. Returns how many
   * were emitted. The server tick / browser interval / tests drive the sim through this. */
  flushDue(now: number): number;
  /** Timestamp of the next scheduled event, or null when idle — lets a poller pace itself. */
  nextDueAt(): number | null;
  /** Clear all scheduled events and subscribers (test isolation). */
  reset(): void;
}

// Small seedable PRNG (mulberry32) so simulated outcomes are reproducible in tests.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Timings (ms). Kept realistic so the live view looks like a real dialer.
const RING_DELAY = 700;
const RING_TIMEOUT = 4000; // unanswered → no_answer/busy after this
const MIN_TALK = 15_000;
const MAX_TALK = 70_000;
const DTMF_AFTER_ANSWER = 1_500;
const SMS_SENT_DELAY = 400;
const SMS_DELIVERED_DELAY = 1_800;

interface Scheduled {
  at: number;
  providerCallId: string;
  event: TelephonyEvent;
  /** Predictive: the borrower answers now; pick a free extension in this queue at that moment. */
  routeTo?: string;
}

export function createSimProvider(opts?: { seed?: number }): SimProvider {
  const rng = mulberry32(opts?.seed ?? 0xc0ffee);
  let callSeq = 0;
  let smsSeq = 0;
  let scheduled: Scheduled[] = [];
  const listeners = new Set<TelephonyEventListener>();

  // Predictive: queue → extensions logged in; extension → the call it is on.
  const queues = new Map<string, Set<string>>();
  const busy = new Map<string, string>();
  const releaseCall = (providerCallId: string) => {
    for (const [ext, id] of busy) if (id === providerCallId) busy.delete(ext);
  };

  const emit = (event: TelephonyEvent) => {
    if (event.type === "hangup") releaseCall(event.providerCallId);
    listeners.forEach((l) => l(event));
  };

  /** The borrower picked up: connect a free queued extension like the vendor's ACD would, or,
   *  with nobody free, end the call (the dialer counts that as an abandon). */
  const route = (s: Scheduled) => {
    const free = [...(queues.get(s.routeTo as string) ?? [])].find((ext) => !busy.has(ext));
    const id = s.providerCallId;
    if (!free) {
      emit({
        type: "hangup",
        providerCallId: id,
        at: s.at,
        result: "completed",
        durationSeconds: 0,
      });
      return;
    }
    busy.set(free, id);
    emit({ type: "answer", providerCallId: id, at: s.at, agentHandle: free });
    const endAt = s.at + MIN_TALK + Math.floor(rng() * (MAX_TALK - MIN_TALK));
    schedule(endAt, id, {
      type: "hangup",
      providerCallId: id,
      at: endAt,
      result: "completed",
      durationSeconds: Math.round((endAt - s.at) / 1000),
    });
  };

  const schedule = (at: number, providerCallId: string, event: TelephonyEvent) => {
    scheduled.push({ at, providerCallId, event });
  };

  /** Answer probability biased by AI score (1-10, 5 = neutral) and contact-time fit. */
  const answerProbability = (hints?: StartCallRequest["hints"]): number => {
    const score = hints?.aiScore ?? 5;
    let p = 0.35 + (score - 5) * 0.05; // score 10 → 0.60, score 1 → 0.15
    if (hints?.bestContactTime && hints.bestContactTime !== "any") p += 0.05;
    return Math.max(0.1, Math.min(0.9, p));
  };

  return {
    name: "sim",

    predictive: {
      async loginQueue(extension: string, queue: string): Promise<void> {
        if (!queues.has(queue)) queues.set(queue, new Set());
        queues.get(queue)!.add(extension);
      },
      async logoutQueue(extension: string, queue: string): Promise<void> {
        queues.get(queue)?.delete(extension);
      },
      async startCall(req: PredictiveCallRequest): Promise<StartCallResult> {
        const providerCallId = req.requestId || `sim-pcall-${++callSeq}`;
        const ringAt = Date.now() + RING_DELAY;
        schedule(ringAt, providerCallId, { type: "ring", providerCallId, at: ringAt });
        if (rng() >= answerProbability(req.hints)) {
          const endAt = ringAt + RING_TIMEOUT;
          schedule(endAt, providerCallId, {
            type: "hangup",
            providerCallId,
            at: endAt,
            result: rng() < 0.25 ? "busy" : "no_answer",
            durationSeconds: 0,
          });
          return { providerCallId };
        }
        const answerAt = ringAt + 1500 + Math.floor(rng() * 2000);
        // Placeholder event; flushDue swaps it for an answer or an abandon via route().
        scheduled.push({
          at: answerAt,
          providerCallId,
          routeTo: req.queue,
          event: { type: "answer", providerCallId, at: answerAt },
        });
        return { providerCallId };
      },
    },

    async startCall(req: StartCallRequest): Promise<StartCallResult> {
      const providerCallId = `sim-call-${++callSeq}`;
      const now = Date.now();
      const ringAt = now + RING_DELAY;
      schedule(ringAt, providerCallId, { type: "ring", providerCallId, at: ringAt });

      // Agent-initiated manual dials always connect; predictive dials roll the dice.
      const answered = req.hints?.manual ? true : rng() < answerProbability(req.hints);
      if (!answered) {
        const result: TerminalCallState = rng() < 0.25 ? "busy" : "no_answer";
        const endAt = ringAt + RING_TIMEOUT;
        schedule(endAt, providerCallId, {
          type: "hangup",
          providerCallId,
          at: endAt,
          result,
          durationSeconds: 0,
        });
        return { providerCallId };
      }

      const answerAt = ringAt + 1500 + Math.floor(rng() * 2000);
      schedule(answerAt, providerCallId, { type: "answer", providerCallId, at: answerAt });

      // IVR portfolios play a menu; the debtor presses a key ("1" = connect to agent).
      if (req.hints?.ivr) {
        const dtmfAt = answerAt + DTMF_AFTER_ANSWER;
        const digit = rng() < 0.7 ? "1" : "9";
        schedule(dtmfAt, providerCallId, { type: "dtmf", providerCallId, at: dtmfAt, digit });
      }

      // Manual dials stay connected until the agent hangs up — no auto-hangup/recording.
      if (req.hints?.manual) return { providerCallId };

      const talkMs = MIN_TALK + Math.floor(rng() * (MAX_TALK - MIN_TALK));
      const endAt = answerAt + talkMs;
      const durationSeconds = Math.round((endAt - answerAt) / 1000);
      schedule(endAt, providerCallId, {
        type: "recording",
        providerCallId,
        at: endAt,
        recordingUrl: `sim://recording/${providerCallId}.mp3`,
      });
      schedule(endAt, providerCallId, {
        type: "hangup",
        providerCallId,
        at: endAt,
        result: "completed",
        durationSeconds,
      });
      return { providerCallId };
    },

    async hangup(providerCallId: string): Promise<void> {
      // Drop any pending events for this leg and end it immediately (agent hangup / abandon).
      const hadPending = scheduled.some((s) => s.providerCallId === providerCallId);
      scheduled = scheduled.filter((s) => s.providerCallId !== providerCallId);
      if (hadPending) {
        const at = Date.now();
        // Immediate manual hangup: schedule so it flows through flushDue like any other event.
        schedule(at, providerCallId, {
          type: "hangup",
          providerCallId,
          at,
          result: "completed",
          durationSeconds: 0,
        });
      }
    },

    async sendSms(req: SendSmsRequest): Promise<SendSmsResult> {
      const providerMessageId = `sim-sms-${++smsSeq}`;
      const now = Date.now();
      schedule(now + SMS_SENT_DELAY, providerMessageId, {
        type: "sms_status",
        providerMessageId,
        at: now + SMS_SENT_DELAY,
        status: "sent",
      });
      schedule(now + SMS_DELIVERED_DELAY, providerMessageId, {
        type: "sms_status",
        providerMessageId,
        at: now + SMS_DELIVERED_DELAY,
        status: "delivered",
      });
      void req;
      return { providerMessageId };
    },

    parseStatusWebhook(payload: unknown): CallStatusEvent {
      // The sim delivers events via subscribe()/flushDue(), not HTTP webhooks, but implement a
      // parser for the shared shape so the webhook route can be exercised against the sim too.
      const p = (payload ?? {}) as {
        providerCallId?: string;
        call_id?: string;
        status?: string;
        duration?: number;
        recording_url?: string;
      };
      const status = (
        ["ringing", "connected", "no_answer", "failed", "completed"] as CallStatus[]
      ).includes(p.status as CallStatus)
        ? (p.status as CallStatus)
        : "failed";
      return {
        providerCallId: p.providerCallId ?? p.call_id ?? "",
        status,
        durationSeconds: p.duration,
        recordingUrl: p.recording_url,
      };
    },

    subscribe(listener: TelephonyEventListener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    flushDue(now: number): number {
      const due = scheduled.filter((s) => s.at <= now).sort((a, b) => a.at - b.at);
      if (!due.length) return 0;
      scheduled = scheduled.filter((s) => s.at > now);
      due.forEach((s) => (s.routeTo ? route(s) : emit(s.event)));
      return due.length;
    },

    nextDueAt(): number | null {
      if (!scheduled.length) return null;
      return scheduled.reduce((min, s) => Math.min(min, s.at), Infinity);
    },

    reset(): void {
      scheduled = [];
      listeners.clear();
      queues.clear();
      busy.clear();
      callSeq = 0;
      smsSeq = 0;
    },
  };
}
