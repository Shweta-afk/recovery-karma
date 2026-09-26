-- Withdraws the hand-rated lookup feedback added (and applied live) earlier on 2026-09-27.
-- The product decision was to CALCULATE whether a lookup was useful — from dispositions after it
-- and from the bank's paid file — rather than ask people to rate it; see
-- 20260927_insights_outcome_report.sql and src/lib/profilex/outcome.ts. No rating was ever
-- saved, so nothing is lost. IF EXISTS keeps a replay (where these columns never existed) a no-op.

ALTER TABLE debtor_traces DROP COLUMN IF EXISTS feedback;
ALTER TABLE debtor_traces DROP COLUMN IF EXISTS feedback_note;
ALTER TABLE debtor_traces DROP COLUMN IF EXISTS feedback_by;
ALTER TABLE debtor_traces DROP COLUMN IF EXISTS feedback_at;
