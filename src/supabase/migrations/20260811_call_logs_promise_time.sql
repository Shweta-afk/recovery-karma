-- Captures the time-of-day an agent commits to call the debtor back on the PTP date, alongside
-- the existing promise_date. Mirrors callback_datetime's split (date lives on promise_date,
-- time here) — PTP never had a time slot before, so "call back at 3pm on the 25th" silently
-- collapsed to just "the 25th" with no time, which is exactly what let PTP follow-ups slip.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS promise_time TIME;
