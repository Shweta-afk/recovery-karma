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
