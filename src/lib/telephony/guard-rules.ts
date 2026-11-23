// Pure rules for whether a call may be placed. No I/O, so scripts/telephony-check.ts can test
// every branch; guard.server.ts loads the inputs from the database and calls evaluateCall.

/** Hard platform limit: channels on the shared SkyCRM trunk. */
export const GLOBAL_CHANNEL_LIMIT = 60;
/** An open call older than this is assumed dead (lost hangup webhook) and stops holding a channel. */
export const STALE_CALL_MINUTES = 120;

export interface TelephonySettingsRow {
  enabled: boolean;
  seat_limit: number | null;
  channel_limit: number;
  inbound_did: string | null;
  inbound_queue: string | null;
  /** "HH:MM" or "HH:MM:SS" (Postgres TIME) */
  call_window_start: string;
  call_window_end: string;
  /** Managers in this company may place calls themselves (20261112_managers_can_call.sql). */
  managers_can_call?: boolean;
  /** SkyCRM queue for predictive dialling (20261117_predictive_dialing.sql). Blank = Productive
   *  Dial falls back to click-to-call, one line per agent. */
  predictive_queue?: string | null;
}

export type CallBlockCode =
  "telephony_disabled" | "no_extension" | "outside_window" | "do_not_call";

export type CallDecision = { ok: true } | { ok: false; code: CallBlockCode; message: string };

/** Last 10 digits — the key do_not_call is unique on, so +91 / 0 / spaced forms collide. */
export function normalisePhone(raw: string): string {
  return raw.replace(/\D/g, "").slice(-10);
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** Minutes past midnight in IST (UTC+5:30, no DST) — never the server's local zone. */
export function istMinutes(now: Date): number {
  const utc = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utc + 330) % 1440;
}

export function withinCallWindow(start: string, end: string, now: Date): boolean {
  const cur = istMinutes(now);
  return cur >= toMinutes(start) && cur < toMinutes(end);
}

const fmt = (t: string) => t.slice(0, 5);

export function evaluateCall(input: {
  /** null when the company has no telephony_settings row */
  settings: TelephonySettingsRow | null;
  /** "sim" | "skycrm" | … */
  provider: string;
  agentExtension: string | null;
  onDoNotCall: boolean;
  now: Date;
}): CallDecision {
  const { settings, provider, agentExtension, onDoNotCall, now } = input;
  const real = provider !== "sim";

  if (onDoNotCall) {
    return {
      ok: false,
      code: "do_not_call",
      message: "This number is on your company's do-not-call list.",
    };
  }
  // No row: the simulator keeps working as before; a real provider needs explicit enablement.
  if (!settings) {
    return real
      ? {
          ok: false,
          code: "telephony_disabled",
          message: "Calling is not enabled for your company yet. Contact your platform admin.",
        }
      : { ok: true };
  }
  if (!settings.enabled) {
    return {
      ok: false,
      code: "telephony_disabled",
      message: "Calling is not enabled for your company yet. Contact your platform admin.",
    };
  }
  if (!withinCallWindow(settings.call_window_start, settings.call_window_end, now)) {
    return {
      ok: false,
      code: "outside_window",
      message: `Calls are only allowed between ${fmt(settings.call_window_start)} and ${fmt(settings.call_window_end)} IST.`,
    };
  }
  if (provider === "skycrm" && !agentExtension?.trim()) {
    return {
      ok: false,
      code: "no_extension",
      message: "No calling extension is assigned to this agent yet.",
    };
  }
  return { ok: true };
}

/** Map telephony_reserve_channel's RAISE codes to what an agent should read. */
export function channelLimitMessage(dbMessage: string): string | null {
  if (dbMessage.includes("CHANNEL_LIMIT_COMPANY")) {
    return "All of your company's calling lines are busy. Try again when a call ends.";
  }
  if (dbMessage.includes("CHANNEL_LIMIT_GLOBAL")) {
    return "All calling lines on the platform are busy. Try again in a moment.";
  }
  return null;
}

/** Total channel_limit across companies may not exceed the trunk. */
export function channelAllocationError(
  otherCompaniesTotal: number,
  requested: number,
): string | null {
  const total = otherCompaniesTotal + requested;
  return total > GLOBAL_CHANNEL_LIMIT
    ? `That would allocate ${total} channels in total; the trunk has ${GLOBAL_CHANNEL_LIMIT}. Other companies already hold ${otherCompaniesTotal}.`
    : null;
}

/** True when a webhook event names a number (10 digits) and the ledger row is a call to a
 *  different one, so the event must not be applied to that row (2026-11-20). */
export function differentNumber(rowPhone: string | null | undefined, eventLast10: string): boolean {
  if (eventLast10.length !== 10 || !rowPhone) return false;
  return normalisePhone(rowPhone) !== eventLast10;
}

/**
 * SkyCRM's callid is "<unix second the call started on THEIR switch>.<seq>" (it matches the
 * timestamp in the recording file name). Their clock runs ~30 s behind ours: across 18,000 calls
 * (16–23 Nov 2026) 98% sat between −32 and −28 s of our `started_at`. A callid from minutes before
 * our row was dialled, or after it, belongs to another call — usually the agent's previous one,
 * whose late event carries no number, so `differentNumber` can't catch it. Applying it gave
 * calls the previous call's callid, status and recording (17 calls on 23 Nov; ~1% of calls).
 */
export const CALLID_EARLIEST_SECONDS = -90;
export const CALLID_LATEST_SECONDS = 120;

export function callidStartSeconds(vendorCallId: string | null | undefined): number | null {
  const m = /^(\d{10})\.\d+$/.exec(vendorCallId?.trim() ?? "");
  return m ? Number(m[1]) : null;
}

/** False only when the callid's own start time rules out this ledger row. Unknown → true. */
export function callidFitsCall(
  vendorCallId: string | null | undefined,
  rowStartedAt: string | null | undefined,
): boolean {
  const callidAt = callidStartSeconds(vendorCallId);
  const startedMs = rowStartedAt ? Date.parse(rowStartedAt) : NaN;
  if (callidAt === null || !Number.isFinite(startedMs)) return true;
  const d = callidAt - startedMs / 1000;
  return d >= CALLID_EARLIEST_SECONDS && d <= CALLID_LATEST_SECONDS;
}
