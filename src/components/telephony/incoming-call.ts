// Incoming calls on the browser phone (2026-11-12). Agents didn't hear incoming calls (the card
// made no sound) and didn't know who was calling (it showed only the raw SIP identity), and
// SkyCRM's inbound webhook events never reach us, so the server-side screen pop never fired.
// Everything here works from the ring the browser phone itself receives.
import { useEffect, useState } from "react";
import { resolvePhone, phoneKey, type PhoneMatch } from "@/lib/loan-ref-lookup";
import type { QueueDebtor } from "@/lib/call-queue/types";

/** A two-tone phone ring, looped, made with Web Audio — no sound file to ship. Browsers only let a
 *  page play sound after the person has clicked on it once; every agent has (sign-in, a call). */
export function useRingtone(active: boolean): void {
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    void ctx.resume().catch(() => {});
    let stopped = false;
    const ring = () => {
      if (stopped) return;
      const t0 = ctx.currentTime;
      for (const [start, freq] of [
        [0, 440],
        [0, 480],
        [0.5, 440],
        [0.5, 480],
      ] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t0 + start);
        gain.gain.exponentialRampToValueAtTime(0.12, t0 + start + 0.02);
        gain.gain.setValueAtTime(0.12, t0 + start + 0.38);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + 0.42);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + start);
        osc.stop(t0 + start + 0.45);
      }
    };
    ring();
    const t = setInterval(ring, 3000);

    // The tab may be in the background: flash its title and, when allowed, show a notification.
    const title = document.title;
    let flip = false;
    const flash = setInterval(() => {
      flip = !flip;
      document.title = flip ? "📞 Incoming call" : title;
    }, 900);
    let note: Notification | null = null;
    try {
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        note = new Notification("Incoming call", { body: "Open SamvadX to answer" });
      }
    } catch {
      /* notifications unavailable */
    }
    return () => {
      stopped = true;
      clearInterval(t);
      clearInterval(flash);
      document.title = title;
      note?.close();
      void ctx.close().catch(() => {});
    };
  }, [active]);
}

/** Ask once (on a click) for permission to show the incoming-call notification. */
export function askNotificationPermission(): void {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  } catch {
    /* ignore */
  }
}

export interface CallerInfo {
  phone: string | null;
  /** The borrower's account, when the number belongs to exactly one the agent can see. */
  match: PhoneMatch | null;
  /** How many accounts carry the number (0 = not a borrower we know). */
  count: number;
  loading: boolean;
}

/** Who is calling: the number from the ring, matched to the agent's borrowers (RLS decides). */
export function useCallerInfo(rawRemote: string | null | undefined): CallerInfo {
  const phone = rawRemote ? phoneKey(rawRemote) : null;
  const [info, setInfo] = useState<CallerInfo>({ phone, match: null, count: 0, loading: !!phone });
  useEffect(() => {
    let cancelled = false;
    setInfo({ phone, match: null, count: 0, loading: !!phone });
    if (!phone) return;
    resolvePhone(phone)
      .then((ms) => {
        if (!cancelled) setInfo({ phone, match: ms[0] ?? null, count: ms.length, loading: false });
      })
      .catch(() => {
        if (!cancelled) setInfo({ phone, match: null, count: 0, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [phone]);
  return info;
}

/** The call screen's borrower for an answered incoming call: the matched account, or a stranger
 *  (synthetic id) whose call is logged against no account, like an unmatched Manual Dial. */
export function inboundDebtor(info: CallerInfo, raw: string): QueueDebtor {
  const phone = info.phone ?? raw;
  if (info.match) {
    return {
      ...(info.match.debtor as QueueDebtor),
      phone,
      queueStatus: "fresh",
      scheduledAt: new Date().toISOString(),
      portfolioId: info.match.portfolio.id,
      loanReference: info.match.row.loanReference,
    };
  }
  return {
    id: `manual-${Date.now()}`,
    name: phone,
    phone,
    loanReference: "Incoming call",
    loanAmount: 0,
    dpd: 0,
    aiScore: 0,
    portfolio: "Incoming",
    queueStatus: "fresh",
    scheduledAt: new Date().toISOString(),
    retained: false,
  } as unknown as QueueDebtor;
}
