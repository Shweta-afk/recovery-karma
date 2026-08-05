/** DIDs assigned to the Tata SmartFlo account, usable as outbound caller IDs on any manual
 * dial — agent or manager. Tata rejects any caller_id that isn't one of these with a 422
 * ("DID Selected is either disabled…"). Shared so every manual-dial surface offers the same
 * pool instead of each page hardcoding (or omitting) its own copy. */
export const SMARTFLO_DIDS = [
  "917965810560",
  "917965810601",
  "917965810606",
  "917965810614",
  "917965810618",
] as const;
