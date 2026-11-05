// What SamvadX sends to SkyCRM's disposition_api (API doc "Call disposition", 2026-11-05) — pure,
// so it can be tested and shared. Fields: disposition = "Contacted" | "Non-Contacted" only;
// sub_disposition = free text (we send the outcome's label + the reason the agent picked);
// callback_datetime = "YYYY-MM-DD HH:MM:SS.ffffff".

const LABELS: Record<string, string> = {
  paid: "Paid",
  promised: "Promise to Pay",
  refused: "Refused to Pay",
  no_answer: "No Answer",
  callback: "Callback",
  voicemail: "Voicemail",
  dispute: "Dispute",
  settlement: "Settlement",
  wrong_number: "Wrong Number",
};

/** "No Answer — Switched off", or just the label when no reason was picked. */
export function skycrmSubDisposition(outcome: string, reason?: string | null): string {
  const label = LABELS[outcome] ?? outcome;
  const r = (reason ?? "").trim();
  return (r && r.toLowerCase() !== label.toLowerCase() ? `${label} — ${r}` : label).slice(0, 200);
}

/** "2026-11-06 15:30:00.000000" from an IST date ("YYYY-MM-DD") and optional "HH:MM[:SS]";
 *  undefined when there is no valid date. */
export function skycrmCallbackDatetime(
  date?: string | null,
  time?: string | null,
): string | undefined {
  const d = (date ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = (time ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  const hh = m ? m[1].padStart(2, "0") : "00";
  const mm = m ? m[2] : "00";
  const ss = m?.[3] ?? "00";
  return `${d} ${hh}:${mm}:${ss}.000000`;
}
