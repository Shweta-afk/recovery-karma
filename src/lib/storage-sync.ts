import { useEffect } from "react";

// The app's various stores dispatch same-tab CustomEvents (e.g. "assignments-updated") on write,
// which only reach listeners mounted in the SAME browser tab. The native `storage` event, by
// contrast, fires in OTHER tabs of the same browser origin when localStorage changes. Listening
// to both means a manager view stays live whether the write happened in this tab or another one
// (same browser) — e.g. an agent logging a disposition in one tab updates a manager's Reports
// tab open in another, without a manual refresh.
export function useStorageSync(handler: () => void): void {
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      // e.key is null when localStorage.clear() is called; otherwise only react to our own keys
      if (e.key === null || e.key.startsWith("recoveryai_")) handler();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [handler]);
}
