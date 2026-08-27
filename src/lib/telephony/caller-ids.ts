/** Caller IDs (ExoPhones) assigned to the active telephony account, usable as outbound caller
 * ID on any manual dial — agent or manager. Exotel rejects a caller_id that isn't a DID/ExoPhone
 * assigned to the account, same as every other click-to-call vendor — so this must never be an
 * agent's personal number. Shared so every manual-dial surface offers the same pool instead of
 * each page hardcoding (or omitting) its own copy.
 *
 * Client-safe: read from a VITE_-prefixed var (baked in at build time), comma-separated. Set
 * VITE_TELEPHONY_CALLER_IDS in .env.local to the ExoPhone(s) purchased on the Exotel account. */
const raw: string = import.meta.env.VITE_TELEPHONY_CALLER_IDS ?? "";
export const TELEPHONY_CALLER_IDS: string[] = raw
  .split(",")
  .map((id: string) => id.trim())
  .filter(Boolean);

if (import.meta.env.DEV && TELEPHONY_CALLER_IDS.length === 0) {
  console.warn(
    "[caller-ids] VITE_TELEPHONY_CALLER_IDS is not set — manual-dial caller ID pickers will be empty. Add the account's virtual number(s) to .env.local.",
  );
}
