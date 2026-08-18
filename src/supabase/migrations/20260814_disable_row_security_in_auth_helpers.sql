-- Third and final round on the same recursion (see 20260814_fix_auth_agent_id_recursion.sql
-- and 20260814_fix_auth_client_id_role_recursion.sql). Both prior fixes were verified correct
-- on every checkable dimension — plpgsql (non-inlinable), SECURITY DEFINER, function owner
-- (postgres) matches the agents table owner, that role has rolbypassrls=true, and
-- agents.relforcerowsecurity was confirmed false — yet the recursion persisted. Bisected live
-- against the real database (2026-08-14) by incrementally rebuilding agents_select from a
-- trivial `auth_user_id = auth.uid()` policy back up to the full one, testing each addition
-- with `SET LOCAL ROLE authenticated; SELECT ... FROM agents WHERE auth_user_id = ...` in a
-- rolled-back transaction:
--   auth_user_id = auth.uid()                                    -> works
--   OR client_id = auth_client_id()                               -> works
--   OR auth_role() = 'admin'                                      -> works
--   OR id = auth_agent_id()                                       -> works
--   OR id IN (SELECT ... FROM team_agents JOIN teams
--             WHERE ta.agent_id = auth_agent_id())                -> RECURSES
--
-- So every function works in isolation — the recursion is specifically in the subquery that
-- reads team_agents/teams from INSIDE agents_select's own USING clause. Those two tables have
-- their own RLS (team_agents_select, teams_select), which also call auth_client_id() — reading
-- them as the ORIGINAL calling role (not through any SECURITY DEFINER function, since only the
-- final `= auth_agent_id()` comparison was elevated, not the FROM clause) re-triggers their
-- policies, and something about that specific nested-subquery shape reintroduces the recursion
-- Postgres's guard catches, even though every individual function is provably safe alone.
--
-- Fix: stop letting agents_select read team_agents/teams directly at all. Wrap the entire
-- "which agent ids can I see" traversal — including the team_agents/teams reads, not just the
-- final agents lookup — inside ONE SECURITY DEFINER function with row_security=off for its
-- whole execution, so none of those reads ever trigger RLS on any table.
CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    result UUID;
  BEGIN
    SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;

CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    result UUID;
  BEGIN
    SELECT client_id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    result TEXT;
  BEGIN
    SELECT role INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;

-- Encapsulates the "own row, or a team member's row if I manage them, or my manager's row if
-- I'm on their team" traversal that used to live inline in agents_select's USING clause.
-- row_security=off covers every read in here (agents, team_agents, teams), so none of them
-- ever re-enter any table's RLS.
CREATE OR REPLACE FUNCTION auth_visible_agent_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY
    SELECT id FROM agents WHERE auth_user_id = auth.uid()
    UNION
    SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
    WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
    UNION
    SELECT t.manager_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
    WHERE ta.agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid());
  END;
  $$;

DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );
