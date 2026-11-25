// Keeps the signed-in agent's or manager's status interval open and heartbeated on every page
// (2026-11-25) — see ensurePresence in agent-presence-store.ts. Mounted once by the agent and
// manager layouts. No close on pagehide: a reload must keep a break a break; a person who
// really leaves stops heartbeating and drops to "Not signed in" after PRESENCE_STALE_MS.
import { useEffect } from "react";
import { ensurePresence, touchPresence } from "./agent-presence-store";

const HEARTBEAT_MS = 60_000;

export function usePresenceHeartbeat(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void ensurePresence();
    const beat = () => void touchPresence().catch(() => {});
    const t = setInterval(beat, HEARTBEAT_MS);
    // Background tabs get their timers slowed; beat as soon as the tab is looked at again.
    const onVisible = () => {
      if (document.visibilityState === "visible") beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled]);
}
