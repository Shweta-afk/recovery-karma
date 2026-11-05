-- 'no_call': a disposition changed from the debtor profile WITHOUT ringing the borrower
-- (e.g. a call that dropped was saved as Callback, and the agent then learns it is a PTP).
-- It is a new call_logs row, never an edit of the old one: agents have no UPDATE on
-- call_logs, and the earlier disposition stays in the history as it was saved. Being the
-- latest row, it becomes the account's current disposition everywhere that reads "latest"
-- (queue status, PTP / callback follow-ups, escalations).
ALTER TABLE call_logs DROP CONSTRAINT IF EXISTS call_logs_dial_mode_check;
ALTER TABLE call_logs ADD CONSTRAINT call_logs_dial_mode_check
  CHECK (dial_mode IS NULL OR dial_mode IN ('manual', 'single', 'multi_line', 'sequential', 'no_call'));
