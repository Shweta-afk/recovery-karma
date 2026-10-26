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
}

export type CallBlockCode =
  | "telephony_disabled"
  | "no_extension"
  | "outside_window"
  | "do_not_call";

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
