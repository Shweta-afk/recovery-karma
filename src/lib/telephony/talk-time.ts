// How long the borrower and agent actually spoke, copied from the call ledger (telephony_calls)
// onto call_logs.duration_seconds, which every older screen reads. Pure apart from the client it
// is handed, so the rule can be tested without a database.
//
// The ledger figure and the agent's disposition arrive in either order, so each side writes its
// own row and then copies: the webhook after updating the ledger, the disposition (through
// syncCallLogTalkTime, because agents have no UPDATE on call_logs) after inserting the log.

/** Talk time in whole seconds, or null when the ledger holds none. Only a completed call counts:
 *  on any other status the figure is ringing time. Zero means nothing was measured. */
export function talkSeconds(
  status: string | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (status !== "completed") return null;
  const seconds = Math.round(Number(durationSeconds));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The part of a Supabase client this needs. */
interface CallLogsWriter {
  from(table: "call_logs"): {
    update(patch: { duration_seconds: number }): {
      eq(
        column: "provider_call_id",
        value: string,
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** Write the call's talk time onto its call log(s). No log yet is fine: the disposition copies it
 *  when it is saved. Never throws, because neither caller should fail over a display figure. */
export async function copyTalkTimeToCallLogs(
  db: CallLogsWriter,
  providerCallId: string | null | undefined,
  status: string | null | undefined,
  durationSeconds: number | null | undefined,
): Promise<void> {
  const seconds = talkSeconds(status, durationSeconds);
  if (!providerCallId || seconds === null) return;
  try {
    const { error } = await db
      .from("call_logs")
      .update({ duration_seconds: seconds })
      .eq("provider_call_id", providerCallId);
    if (error) console.warn(`[talk-time] call log update failed: ${error.message}`);
  } catch (err) {
    console.warn(`[talk-time] call log update failed: ${String(err)}`);
  }
}

// ─── Ringing time (2026-11-11) ────────────────────────────────────────────────────────────────
// How long the agent waited for the borrower to pick up, copied onto call_logs.ring_seconds,
// which the agent dashboard, Team Activity and Reports already show as "Ringing". Nothing filled
// it for SkyCRM calls: the browser only knows the borrower answered if the provider says so, and
// SkyCRM has never sent its "Answered" event (0 ledger rows with answered_at as of 2026-11-11).
//
//  - Answer time known (answered_at): ringing = answered − dialled. Used as soon as SkyCRM sends it.
//  - Not answered, and the agent's disposition says no contact (no_answer / voicemail): the whole
//    call, dialled → ended, was ringing.
//  - A call that connected without an answer time: unknown, left blank — guessing would move talk
//    time into ringing. (SkyCRM's CDR "billsec" counts from the AGENT's leg, so it includes the
//    borrower's ringing and can't split the two.)

/** Outcomes that mean the borrower never came on the line. Same rule as NON_CONTACT_OUTCOMES. */
export const RING_ONLY_OUTCOMES = ["no_answer", "voicemail"] as const;

/** Final ledger statuses for a call that never connected. */
const NOT_CONNECTED = new Set(["no_answer", "busy", "failed", "canceled"]);

/** Longer than this is a row left open (closed later by a sweep), not ringing. */
const MAX_RING_SECONDS = 600;

export interface RingTiming {
  seconds: number;
  /** True when the figure is the whole call, so it may only go on a no-contact call log. */
  wholeCall: boolean;
}

export function ringTiming(ledger: {
  status: string | null | undefined;
  started_at?: string | null;
  answered_at?: string | null;
  ended_at?: string | null;
}): RingTiming | null {
  const start = ledger.started_at ? Date.parse(ledger.started_at) : NaN;
  if (!Number.isFinite(start)) return null;
  const answered = ledger.answered_at ? Date.parse(ledger.answered_at) : NaN;
  const ended = ledger.ended_at ? Date.parse(ledger.ended_at) : NaN;
  let seconds: number;
  let wholeCall = false;
  if (Number.isFinite(answered)) {
    seconds = (answered - start) / 1000;
  } else if (NOT_CONNECTED.has(String(ledger.status)) && Number.isFinite(ended)) {
    seconds = (ended - start) / 1000;
    wholeCall = true;
  } else {
    return null;
  }
  seconds = Math.round(seconds);
  if (!(seconds >= 0) || seconds > MAX_RING_SECONDS) return null;
  return { seconds, wholeCall };
}

/** Write the call's ringing time onto its call log(s) that don't have one yet. Never throws. */
export async function copyRingTimeToCallLogs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ring_seconds isn't in the generated update type
  db: any,
  providerCallId: string | null | undefined,
  ledger: Parameters<typeof ringTiming>[0],
): Promise<void> {
  const ring = ringTiming(ledger);
  if (!providerCallId || !ring) return;
  try {
    let q = db
      .from("call_logs")
      .update({ ring_seconds: ring.seconds })
      .eq("provider_call_id", providerCallId)
      .is("ring_seconds", null);
    if (ring.wholeCall) q = q.in("outcome", [...RING_ONLY_OUTCOMES]);
    const { error } = await q;
    if (error) console.warn(`[ring-time] call log update failed: ${error.message}`);
  } catch (err) {
    console.warn(`[ring-time] call log update failed: ${String(err)}`);
  }
}
