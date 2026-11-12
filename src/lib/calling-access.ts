// Whether the signed-in person may place calls (agents always; managers only where a superadmin
// switched "Managers can call" on for the company). Asked once per page load and shared; the
// server enforces the same rule on every dial, this only hides what it would refuse.
import { useEffect, useState } from "react";
import { getMyCallingAccess } from "@/lib/telephony-actions.server";
import { getAccessToken } from "@/lib/access-token";

let cached: Promise<boolean> | null = null;

function load(): Promise<boolean> {
  cached ??= (async () => {
    try {
      const res = await getMyCallingAccess({ data: { accessToken: await getAccessToken() } });
      return res.canCall;
    } catch {
      cached = null; // try again next time
      return false;
    }
  })();
  return cached;
}

/** null while loading. */
export function useCanCall(): boolean | null {
  const [can, setCan] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    void load().then((v) => live && setCan(v));
    return () => {
      live = false;
    };
  }, []);
  return can;
}

/** Fired by Manager → Call Queue with `detail: true/false` while a call started from its My Queue
 *  tab (its own call state, not the shared one) is up, so the Manual Dial dock can step aside. */
export const MANAGER_LOCAL_CALL_EVENT = "samvadx:manager-local-call";
