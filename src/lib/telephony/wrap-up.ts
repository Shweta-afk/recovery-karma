// Wrap-up: the time between a Productive Dial call ending and the agent saving its disposition
// (2026-11-25). SkyCRM counts the agent free the moment the call ends and puts the next borrower
// waiting in the queue straight through, which replaced the disposition form before it was
// saved. During wrap-up the agent's extension is paused in SkyCRM (telephony-actions.server.ts,
// setWrapUp) and Productive Dial treats them as busy (predictiveDial in server.ts), so no
// borrower is rung for an agent who can't take them.
//
// Pure state, no provider or database imports: server.ts is imported by browser code. Kept on
// globalThis so every module instance of the one server process shares it (see server.ts).

/** A wrap-up longer than this ends by itself: a form left open, or a browser closed mid-form,
 *  must not keep the agent out of every queue (inbound included) for good. */
export const MAX_WRAP_UP_MS = 5 * 60_000;

const g = globalThis as typeof globalThis & {
  __samvadxWrapUp?: Map<string, number>; // extension → wrap-up ends at (ms)
};
const wrapUps = (g.__samvadxWrapUp ??= new Map());

/** Start (or restart) wrap-up for an extension; returns when it ends by itself. */
export function startWrapUp(extension: string, nowMs = Date.now()): number {
  const until = nowMs + MAX_WRAP_UP_MS;
  wrapUps.set(extension, until);
  return until;
}

export function endWrapUp(extension: string): void {
  wrapUps.delete(extension);
}

/** Whether an extension is in wrap-up right now (an expired one counts as ended). */
export function inWrapUp(extension: string, nowMs = Date.now()): boolean {
  const until = wrapUps.get(extension);
  if (until === undefined) return false;
  if (nowMs >= until) {
    wrapUps.delete(extension);
    return false;
  }
  return true;
}

/** The handles of `handles` not in wrap-up. */
export function notInWrapUp(handles: string[], nowMs = Date.now()): string[] {
  return handles.filter((h) => !inWrapUp(h, nowMs));
}
