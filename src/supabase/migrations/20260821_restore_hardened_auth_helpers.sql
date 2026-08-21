-- Fourth round on the recursion documented in CLAUDE.md → "RLS 'infinite recursion detected
-- in policy'". On 2026-08-21 PostgREST began returning 500 on the auth/roster reads that run
-- on EVERY page load:
--     /rest/v1/agents?select=name,email,role,agent_phone&auth_user_id=eq.<uuid>
--     /rest/v1/agents?select=id,email,name
--     /rest/v1/team_agents?select=team_id,agent_id
-- for at least two different signed-in users. `agents` and `team_agents` failing together is
-- the signature of the shared auth helpers regressing rather than any one policy, since every
-- policy on both tables bottoms out in auth_client_id()/auth_role()/auth_agent_id().
--
-- This file is a verbatim, idempotent re-application of the known-good definitions from
-- 20260814_disable_row_security_in_auth_helpers.sql. Re-running it is safe: CREATE OR REPLACE
-- FUNCTION and DROP POLICY IF EXISTS make it a no-op if the database is already correct, so it
-- can be applied without first proving the diagnosis (see scripts/debug/diagnose-rls-500.sql
-- to confirm the cause either way).
--
-- Why these exact shapes matter — all three constraints are load-bearing:
--   * LANGUAGE plpgsql  — a single-statement LANGUAGE sql function gets INLINED by the
--     planner, which silently discards SECURITY DEFINER. plpgsql is opaque and never inlined.
--   * SECURITY DEFINER  — runs as the table owner, which is exempt from RLS.
--   * SET row_security = off — covers EVERY read inside the function body (agents, teams,
--     team_agents), not just the final lookup, so no internal read re-enters any table's RLS.
-- Dropping any one of the three reintroduces the cycle.

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
-- I'm on their team" traversal. It must NOT be inlined into agents_select's USING clause —
-- that is precisely the shape that recursed (see 20260814_disable_row_security_in_auth_helpers.sql).
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

-- Verify: should return one row, not 42P17. Substitute a real agents.auth_user_id.
-- BEGIN;
--   SET LOCAL ROLE authenticated;
--   SET LOCAL request.jwt.claims TO '{"sub":"<a real auth_user_id>"}';
--   SELECT name, email, role FROM agents WHERE auth_user_id = '<same uuid>';
--   SELECT team_id, agent_id FROM team_agents;
-- ROLLBACK;
