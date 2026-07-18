// Single entry point for telephony — call queue UI and server routes should import
// from here, not from a specific vendor file, so switching providers later (e.g.
// kookoo -> exotel) never touches dashboard.call-queue.tsx.
import type { TelephonyProvider } from "./types";
import { kookooProvider } from "./kookoo-provider";

export * from "./types";

const PROVIDERS: Record<string, TelephonyProvider> = {
  kookoo: kookooProvider,
};

export function getTelephonyProvider(): TelephonyProvider {
  const key = process.env.TELEPHONY_PROVIDER ?? "kookoo";
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new Error(`Unknown TELEPHONY_PROVIDER "${key}" — expected one of: ${Object.keys(PROVIDERS).join(", ")}`);
  }
  return provider;
}
