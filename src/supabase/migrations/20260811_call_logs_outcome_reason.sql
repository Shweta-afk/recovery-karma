-- Sub-reason for a disposition's outcome, e.g. "Switched off" under no_answer or "Wants
-- lump-sum discount" under settlement — see OUTCOME_REASONS in active-call.tsx, which now
-- shows a reason dropdown once an outcome is picked. Free text (a fixed CHECK per outcome
-- would need updating every time the reason list changes, and the list is UI-owned, not
-- schema-owned) — the frontend is the source of truth for which reasons are offered.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS outcome_reason TEXT;

-- 'settlement' has been a valid CallOutcome/disposition button in the app since the very
-- first version of the Call Queue (dashboard.call-queue.tsx's PRODUCTIVE_OUTCOMES has always
-- included it), but the original schema.sql CHECK constraint never listed it as an allowed
-- outcome value — every "Settlement" disposition an agent has ever logged has been silently
-- rejected by the database (saveDisposition's insert throws, caught by a toast.error the agent
-- may not have noticed). Fixing that here since it's the exact same column this migration is
-- already touching.
ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_outcome_check;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_outcome_check CHECK (outcome IN (
  'paid', 'promised', 'refused', 'no_answer', 'voicemail',
  'dispute', 'callback', 'wrong_number', 'deceased', 'escalated', 'settlement'
));
