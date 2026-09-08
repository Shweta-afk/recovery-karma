-- Correction to 20260908_scope_teams_and_ptp_to_manager.sql, applied minutes later the same
-- day after the smoke test below caught it.
--
-- That migration's team_agents_select policy was:
--   USING (auth_role() = 'admin' OR team_id IN (SELECT auth_visible_team_ids()))
-- The admin branch had NO client_id check at all, so ANY admin -- from ANY client on the
-- platform, not just the caller's own -- saw every client's team_agents rows. That is a
-- cross-TENANT leak, strictly worse than the cross-manager-within-one-client gap the original
-- migration set out to close.
--
-- Caught immediately by re-running the project's own RLS smoke-test pattern
-- (scripts/debug/rls-smoke-test.sql) as a real admin right after applying: team_agents came
-- back with all 16 platform-wide rows instead of the 0 that admin's own (team-less) client
-- should see. Verified again after this fix, plus against an admin whose client DOES have
-- teams (saw exactly their own client's 5 teams / 15 team_agents rows, not the other client's).
--
-- Fix: move admin's client scoping INTO auth_visible_team_ids() itself, so team_agents_select
-- has no separate admin bypass left where a check could be missing -- it only ever calls the
-- helper, same shape as every other _select policy in this schema.
CREATE OR REPLACE FUNCTION auth_visible_team_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; r TEXT; cid UUID;
  BEGIN
    SELECT id, role, client_id INTO me, r, cid FROM agents WHERE auth_user_id = auth.uid();
    IF r = 'admin' THEN
      RETURN QUERY SELECT id FROM teams WHERE client_id = cid;
    ELSE
      RETURN QUERY
      SELECT id FROM teams WHERE manager_id = me
      UNION
      SELECT team_id FROM team_agents WHERE agent_id = me;
    END IF;
  END; $$;

DROP POLICY IF EXISTS team_agents_select ON team_agents;
CREATE POLICY team_agents_select ON team_agents FOR SELECT TO authenticated
  USING (team_id IN (SELECT auth_visible_team_ids()));

NOTIFY pgrst, 'reload schema';
