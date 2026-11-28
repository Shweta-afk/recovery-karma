-- Scheduled Feedback File emails (user, 2026-11-28): the same schedules table, a second kind.
-- A feedback schedule emails, for EACH team, that team's open portfolios' Feedback Files (one
-- Excel per portfolio) to the chosen list. Needs only the report_emails feature.

ALTER TABLE report_email_schedules
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'mis' CHECK (kind IN ('mis', 'feedback')),
  ADD COLUMN IF NOT EXISTS period TEXT NOT NULL DEFAULT 'day' CHECK (period IN ('day', 'month', 'all'));
