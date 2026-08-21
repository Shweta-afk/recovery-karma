-- Same three fixes as 20260821_restore_hardened_auth_helpers.sql, but with NO explicit
-- BEGIN/COMMIT — Supabase's SQL Editor wraps statements in its own transaction, and a nested
-- BEGIN/COMMIT can end it early or cause the DDL to roll back silently. That may be why the
-- previous run appeared to do nothing.
--
-- RUN THIS IN FOUR SEPARATE PASTES, checking each one succeeds before moving on. Splitting it
-- means a failure is visible and attributable instead of vanishing mid-script.

-- ══ STEP 1 ══ Make auth_agent_id() non-inlinable. THIS IS THE ROOT FIX.
-- It is currently LANGUAGE sql; Postgres inlines simple SQL functions, discarding SECURITY
-- DEFINER, so its body's `SELECT FROM agents` runs as the caller, hits agents_select, which
-- calls this function. plpgsql is opaque to the planner and never inlined.
CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
  BEGIN
    SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;


-- ══ STEP 2 ══ Stop agents_select reading team_agents/teams inside its own USING clause.
-- auth_visible_agent_ids() already exists and is correct; the policy just wasn't using it.
DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );


-- ══ STEP 3 ══ Stop team_agents_write reading agents inline.
-- It is FOR ALL, so it governs SELECT too — this is team_agents' own recursion. Same
-- visibility rule (admin, or the team's own manager); only the lookup mechanism changes.
DROP POLICY IF EXISTS team_agents_write ON team_agents;
CREATE POLICY team_agents_write ON team_agents FOR ALL TO authenticated
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = auth_client_id()
        AND (auth_role() = 'admin' OR manager_id = auth_agent_id())
    )
  )
  WITH CHECK (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = auth_client_id()
        AND (auth_role() = 'admin' OR manager_id = auth_agent_id())
    )
  );


-- ══ STEP 4 ══ Verify. Every row must say OK.
NOTIFY pgrst, 'reload schema';

CREATE OR REPLACE FUNCTION _rls_probe(t text) RETURNS text
  LANGUAGE plpgsql SECURITY INVOKER
  AS $$
  DECLARE n bigint;
  BEGIN
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    RETURN 'OK — ' || n || ' rows';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'FAIL — ' || SQLSTATE || ': ' || SQLERRM;
  END;
  $$;

BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{"sub":"25e3159e-555a-4bac-964e-0c66b9f1af4d"}';
  SELECT t AS table_name, _rls_probe(t) AS result
  FROM unnest(ARRAY[
    'clients','agents','teams','team_agents','portfolios','debtors',
    'call_logs','messages','payments','disputes','settlement_requests'
  ]) AS t
  ORDER BY 1;
ROLLBACK;
