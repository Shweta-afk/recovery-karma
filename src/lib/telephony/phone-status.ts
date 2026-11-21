// Whether the agent's browser phone is connected to SkyCRM, shared so a dial can wait for it
// (2026-11-12). SkyCRM rings the agent's phone first; when it isn't registered SkyCRM refuses the
// call with "Unavailable" (SX-3106) — 19 times on 12 Nov, mostly agents dialling right after a
// reload, before the phone had connected.
//
// "none": no browser phone on this page (another provider, or no extension) — never block.
export type PhoneState = "none" | "connecting" | "ready";

let state: PhoneState = "none";
const listeners = new Set<() => void>();

export function setPhoneState(next: PhoneState): void {
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function getPhoneState(): PhoneState {
  return state;
}

/** Ask the browser phone to reconnect (SkyCRM said it isn't registered although it looked ready).
 *  The phone reports its own state as it reconnects, so waitForPhone then waits for it. */
export const PHONE_REREGISTER_EVENT = "samvadx:phone-reregister";
export function requestPhoneReconnect(): void {
  if (state === "none") return;
  window.dispatchEvent(new CustomEvent(PHONE_REREGISTER_EVENT));
}

/** Resolves true once the phone is ready (or there is no browser phone), false after `ms`. */
export function waitForPhone(ms: number): Promise<boolean> {
  if (state !== "connecting") return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      listeners.delete(check);
      resolve(ok);
    };
    const check = () => {
      if (state !== "connecting") done(true);
    };
    const timer = setTimeout(() => done(false), ms);
    listeners.add(check);
  });
}

/** Whether the browser phone is in a connected call right now (2026-11-20). SkyCRM sometimes sends
 *  a "no answer" end-of-call record seconds into a call that then carries on (Babu Gurava Vaidya,
 *  ext 8616, 20 Nov: "no answer" at 13 s, then a 5-minute conversation). The call screen closed
 *  and the agent had no End button while still talking. While this phone is still connected, the
 *  call is not over, whatever the server says; the phone's own end closes the screen
 *  (PHONE_CALL_ENDED_EVENT in call-session.tsx). */
let inCall = false;
let idleSince = Date.now();
export function setPhoneInCall(next: boolean): void {
  if (inCall && !next) idleSince = Date.now();
  inCall = next;
}
export function isPhoneInCall(): boolean {
  return inCall;
}

/** Seconds the browser phone has been out of a call, or null when there is no ready phone on
 *  this page (then nothing can be said about it). Productive Dial sends this so a call SkyCRM
 *  never ends doesn't keep the agent "busy" (2026-11-21). */
export function phoneIdleSeconds(): number | null {
  if (state !== "ready") return null;
  if (inCall) return 0;
  return Math.floor((Date.now() - idleSince) / 1000);
}
