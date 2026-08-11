// Single source of truth for the SMS text a disposition triggers — shared by the SMS preview
// dialog in the call modal (active-call.tsx, shown before Save & Close) and the actual "send"
// on save (dashboard.call-queue.tsx / manager.queue.tsx), so the two can never drift apart:
// what the agent previews is exactly what goes out. SMS sending itself is still simulated (a
// toast, not a real Interakt API call — see CLAUDE.md's Phase 2), but the copy is real.
import type { CallOutcome, DispositionForm } from "./call-queue/types";
import { formatINR } from "./mock-debtors";

/** null when this outcome doesn't trigger an SMS at all (only PTP/callback do today). */
export function buildDispositionSms(
  outcome: CallOutcome | "",
  debtorName: string,
  disposition: DispositionForm,
): string | null {
  if (outcome === "promised") {
    const amt = disposition.ptpAmount ? formatINR(parseFloat(disposition.ptpAmount)) : "";
    const date = disposition.ptpDate || "the agreed date";
    const time = disposition.ptpTime ? ` at ${disposition.ptpTime}` : "";
    return `Dear ${debtorName}, we've recorded your promise to pay ${amt} by ${date}${time}. Thank you — SamvadX`;
  }
  if (outcome === "callback") {
    const date = disposition.callbackDate || "the agreed date";
    const time = disposition.callbackTime ? ` at ${disposition.callbackTime}` : "";
    return `Dear ${debtorName}, our agent will call you back on ${date}${time}. — SamvadX`;
  }
  return null;
}
