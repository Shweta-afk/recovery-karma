-- Live call state, shared across users.
--
-- Until now an agent's in-progress call existed ONLY in that agent's browser: useCallSession is
-- a React context, and call_logs is not written until the call ends and the agent dispositions
-- it. So nothing on the server knew a call was happening, and no manager could see one. This
-- table is that missing shared state.
--
-- It is NOT a second copy of history. call_logs remains the record of what happened; rows here
-- are ephemeral and describe only what is happening right now.
CREATE TABLE IF NOT EXISTS live_calls (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id),
  agent_id          UUID NOT NULL REFERENCES agents(id),
  -- Null for an unmapped manual dial — those have no debtor row behind them.
  debtor_id         UUID REFERENCES debtors(id),
  -- Correlates this row with the provider's status webhooks and, later, with call_logs.
  provider_call_id  TEXT,
  phase             TEXT NOT NULL CHECK (phase IN ('ringing', 'connected', 'wrapup')),
  -- Same vocabulary as call_logs.dial_mode (20260827_call_logs_dial_mode.sql) — deliberately
  -- avoids the swapped "productive"/"predictive" words. See DIAL_MODE_META.
  dial_mode         TEXT,
  contact_name      TEXT,
  contact_phone     TEXT,
  loan_reference    TEXT,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Heartbeat. The owning tab refreshes this while the call is live; a row not seen recently
  -- is shown as STALE rather than live. See the ghost-call note in docs/LIVE_CALLS_SCOPE.md:
  -- a browser that crashes never writes "call ended", and a board showing an agent
  -- permanently on a finished call loses a manager's trust after the first one.
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Stamped rather than deleted, so provider webhooks have a row to reconcile against later
  -- (phase 3) and the board can briefly show "just ended".
  ended_at          TIMESTAMPTZ
);

-- The board's only query: live rows for the viewer's client, newest first.
CREATE INDEX IF NOT EXISTS idx_live_calls_client_live
  ON live_calls(client_id, ended_at, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_calls_agent ON live_calls(agent_id);

ALTER TABLE live_calls ENABLE ROW LEVEL SECURITY;

-- Same shape as call_logs_select. Note this policy reads NO other table, so unlike the
-- debtor-scoped policies it needs no SECURITY DEFINER helper — keep it that way.
DROP POLICY IF EXISTS live_calls_select ON live_calls;
CREATE POLICY live_calls_select ON live_calls FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );

-- Only the agent on the call may write their own row: nobody can fabricate a call for someone
-- else, or clear one to hide it.
DROP POLICY IF EXISTS live_calls_insert ON live_calls;
CREATE POLICY live_calls_insert ON live_calls FOR INSERT TO authenticated
  WITH CHECK (client_id = auth_client_id() AND agent_id = auth_agent_id());

DROP POLICY IF EXISTS live_calls_update ON live_calls;
CREATE POLICY live_calls_update ON live_calls FOR UPDATE TO authenticated
  USING (client_id = auth_client_id() AND agent_id = auth_agent_id())
  WITH CHECK (client_id = auth_client_id() AND agent_id = auth_agent_id());

-- Realtime. This is the first table in the app to use it, so the publication may not list it.
-- Guarded because ALTER PUBLICATION ... ADD TABLE errors if the table is already a member,
-- which would abort a replay of this migration.
DO $$
BEGIN
  -- Guard on the publication EXISTING as well as on membership. Not every project has
  -- `supabase_realtime` (it is created when Realtime is first enabled), and ALTER PUBLICATION
  -- on a missing one is a hard error that would abort this whole migration — taking the table
  -- and its policies down with it, for a feature that would still work by polling.
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE NOTICE 'supabase_realtime publication not found — live_calls created, but enable Realtime for it in the Supabase dashboard (Database > Replication).';
  ELSIF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'live_calls'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE live_calls;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
