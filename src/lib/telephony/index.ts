// Single entry point for telephony — call queue UI, server routes, and the dialer engine
// should import from here, not from a specific vendor file, so switching providers later
// (e.g. sim -> kookoo -> exotel) never touches feature code.
import type { TelephonyProvider } from "./types";
import { kookooProvider } from "./kookoo-provider";
import { createSimProvider, type SimProvider } from "./sim-provider";

export * from "./types";
export * from "./call-machine";
export type { SimProvider } from "./sim-provider";

// One shared sim instance so every caller (server tick, subscribers, tests via the factory)
// works against the same scheduler. Tests that need isolation build their own via createSimProvider().
let simSingleton: SimProvider | null = null;
export function getSimProvider(): SimProvider {
  if (!simSingleton) simSingleton = createSimProvider();
  return simSingleton;
}

const PROVIDERS: Record<string, () => TelephonyProvider> = {
  sim: getSimProvider,
  kookoo: () => kookooProvider,
};

/** The active provider. Defaults to the simulated provider until a real SIP vendor is
 * wired via TELEPHONY_PROVIDER (server-side env). Guarded so a stray client import can't
 * throw on a missing `process`. */
export function getTelephonyProvider(): TelephonyProvider {
  const key =
    (typeof process !== "undefined" ? process.env?.TELEPHONY_PROVIDER : undefined) ?? "sim";
  const factory = PROVIDERS[key];
  if (!factory) {
    throw new Error(
      `Unknown TELEPHONY_PROVIDER "${key}" — expected one of: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  return factory();
}
