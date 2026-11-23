-- One SkyCRM predictive queue per TEAM (user, 2026-11-23).
--
-- SkyCRM hands a borrower who picks up to any free extension logged into the call's queue. With
-- one queue per company, a team's borrower could reach an agent of another team, i.e. another
-- lender's book. Productive Dial now uses the queue of the team owning the portfolio being
-- dialled (telephony/server.ts), so a team's borrowers only ever reach that team's agents.
-- A team without a queue gets Productive Dial's one-line-per-agent fallback (agent rung first),
-- which never hands a borrower to anyone else. telephony_settings.predictive_queue is no longer
-- used for routing.
--
-- teams already has RLS; this column is written only by the service role
-- (setTeamPredictiveQueue, superadmin), so no policy or grant changes.

ALTER TABLE teams
  ADD COLUMN IF NOT EXISTS predictive_queue TEXT
  CHECK (predictive_queue IS NULL OR predictive_queue ~ '^[0-9]{3,6}$');

-- A queue belongs to one team, platform-wide: two teams sharing one would mix their borrowers.
CREATE UNIQUE INDEX IF NOT EXISTS teams_predictive_queue_unique
  ON teams (predictive_queue) WHERE predictive_queue IS NOT NULL;
