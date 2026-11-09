// How long the borrower and agent actually spoke, copied from the call ledger (telephony_calls)
// onto call_logs.duration_seconds, which every older screen reads. Pure apart from the client it
// is handed, so the rule can be tested without a database.
//
// The ledger figure and the agent's disposition arrive in either order, so each side writes its
// own row and then copies: the webhook after updating the ledger, the disposition (through
// syncCallLogTalkTime, because agents have no UPDATE on call_logs) after inserting the log.

/** Talk time in whole seconds, or null when the ledger holds none. Only a completed call counts:
 *  on any other status the figure is ringing time. Zero means nothing was measured. */
export function talkSeconds(
  status: string | null | undefined,
  durationSeconds: number | null | undefined,
): number | null {
  if (status !== "completed") return null;
  const seconds = Math.round(Number(durationSeconds));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** The part of a Supabase client this needs. */
interface CallLogsWriter {
  from(table: "call_logs"): {
    update(patch: { duration_seconds: number }): {
      eq(
        column: "provider_call_id",
        value: string,
      ): PromiseLike<{ error: { message: string } | null }>;
    };
  };
}

/** Write the call's talk time onto its call log(s). No log yet is fine: the disposition copies it
 *  when it is saved. Never throws, because neither caller should fail over a display figure. */
export async function copyTalkTimeToCallLogs(
  db: CallLogsWriter,
  providerCallId: string | null | undefined,
  status: string | null | undefined,
  durationSeconds: number | null | undefined,
): Promise<void> {
  const seconds = talkSeconds(status, durationSeconds);
  if (!providerCallId || seconds === null) return;
  try {
    const { error } = await db
      .from("call_logs")
      .update({ duration_seconds: seconds })
      .eq("provider_call_id", providerCallId);
    if (error) console.warn(`[talk-time] call log update failed: ${error.message}`);
  } catch (err) {
    console.warn(`[talk-time] call log update failed: ${String(err)}`);
  }
}
