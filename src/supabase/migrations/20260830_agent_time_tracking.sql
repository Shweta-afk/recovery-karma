-- Make agent time REAL.
--
-- agent-time-stats.ts has been generating ringing, wrap, break and idle time from a seeded
-- RNG, because the schema had nowhere to record any of it. Only talk time was ever real
-- (Σ call_logs.duration_seconds). Those figures are shown on the agent dashboard, Team Activity
-- and the Reports "Time & Effort" report — labelled as estimates, but still numbers that look
-- like measurements of a person's working day.
--
-- This migration adds the two things needed to replace them with observations.
--
-- ⚠️ Both are FORWARD-ONLY. Nothing here can reconstruct time that was never recorded, so any
-- period before this is deployed has no data and must be reported as "not recorded" rather
-- than back-filled or estimated.

-- ── 1. Presence ──────────────────────────────────────────────────────────────────────────
-- One row per continuous period in a status. The Call Queue already has the status picker
-- (available / break / lunch / training / offline — see AgentStatus in call-queue/types.ts);
-- it has simply never been persisted.
--
-- Interval rows rather than an event stream: "how long was this agent on break today" is the
-- only question anyone asks of it, and intervals answer it without a window function.
CREATE TABLE IF NOT EXISTS agent_status_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id),
  agent_id    UUID NOT NULL REFERENCES agents(id),
  status      TEXT NOT NULL CHECK (status IN ('available', 'break', 'lunch', 'training', 'offline')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NULL means "still in this status". Closed when the agent changes status or the tab goes
  -- away; an interval left open past the end of a day is reported as unknown, not as an
  -- all-night shift.
  ended_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_status_log_agent_day
  ON agent_status_log(agent_id, started_at DESC);

ALTER TABLE agent_status_log ENABLE ROW LEVEL SECURITY;

-- Same shape as live_calls / call_logs: own rows, team for a manager, client for an admin.
-- Reads no other table, so no SECURITY DEFINER helper is needed.
DROP POLICY IF EXISTS agent_status_log_select ON agent_status_log;
CREATE POLICY agent_status_log_select ON agent_status_log FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );

-- Only the agent may record their own presence. A manager cannot mark someone as on a break
-- they did not take, and an agent cannot rewrite someone else's day.
DROP POLICY IF EXISTS agent_status_log_insert ON agent_status_log;
CREATE POLICY agent_status_log_insert ON agent_status_log FOR INSERT TO authenticated
  WITH CHECK (client_id = auth_client_id() AND agent_id = auth_agent_id());

DROP POLICY IF EXISTS agent_status_log_update ON agent_status_log;
CREATE POLICY agent_status_log_update ON agent_status_log FOR UPDATE TO authenticated
  USING (client_id = auth_client_id() AND agent_id = auth_agent_id())
  WITH CHECK (client_id = auth_client_id() AND agent_id = auth_agent_id());

-- ── 2. Ring and wrap, per call ───────────────────────────────────────────────────────────
-- Seconds, not timestamps: every consumer wants a duration to sum, and a duration cannot be
-- corrupted by a clock skew between the agent's browser and the server the way a pair of
-- timestamps can.
--
-- ring_seconds  — dial to answered/abandoned. use-single-call.ts already knows both moments;
--                 it just discarded them.
-- wrap_seconds  — call ended to disposition submitted. The gap the agent spends typing.
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS ring_seconds INTEGER;
ALTER TABLE call_logs ADD COLUMN IF NOT EXISTS wrap_seconds INTEGER;

NOTIFY pgrst, 'reload schema';
