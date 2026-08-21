-- Fixes the 2026-08-21 outage: PostgREST 500s on nearly every table, all reporting
-- "42P17 infinite recursion detected in policy for relation agents".
--
-- Diagnosed against the live database rather than inferred. A smoke test over all 11 tables
-- showed 9 failing, and 8 of those named relation *agents* rather than themselves — one bug,
-- not nine: every policy in the schema calls auth_client_id()/auth_role(), both of which read
-- `agents`, so agents recursing takes the whole schema down. `clients` and `teams` survived
-- because their policies don't route through it.
--
-- OWNERSHIP IS FINE and was ruled out: all four auth_* functions and all three tables are
-- owned by `postgres`, which has rolbypassrls=true, and relforcerowsecurity is false
-- everywhere. So the SECURITY DEFINER owner-exemption works — once the function is actually
-- opaque to the planner (defect 1 below).
--
-- Correcting a misconception carried through earlier rounds of this fix: `SET row_security =
-- off` does NOT grant an RLS bypass. Per the Postgres docs it makes a query ERROR instead of
-- applying a policy; it only ever *looked* load-bearing because the roles involved were
-- already exempt. The real mechanism is SECURITY DEFINER + an owner that can bypass RLS.
--
-- THREE ACTUAL DEFECTS FOUND IN THE LIVE SCHEMA:
--
--   1. auth_agent_id() was `LANGUAGE sql` (the other three helpers were already plpgsql).
--      Postgres INLINES simple single-statement SQL functions, which silently discards
--      SECURITY DEFINER. Once inlined its `SELECT id FROM agents` runs as the CALLING role,
--      hits agents_select, which calls auth_agent_id() — a true cycle.
--
--   2. agents_select still carried the pre-hardening body with `team_agents`/`teams`
--      subqueries inline in its USING clause. Those tables have their own RLS, which
--      re-enters policy evaluation. (auth_visible_agent_ids() already existed with the
--      correct definition — the policy simply wasn't using it.)
--
--   3. team_agents_write is `FOR ALL`, so it governs SELECT too, and both its USING and
--      WITH CHECK read `(SELECT id FROM agents WHERE auth_user_id = auth.uid())` directly as
--      the calling role. That is team_agents' OWN recursion, separate from the agents
--      cascade, and is why team_agents reported "for relation team_agents".
--
-- Wrapped in a single transaction: an earlier attempt left the schema half-patched (helpers
-- updated, policy not), which made the system look fixed while still being broken. All or
-- nothing.

BEGIN;

-- ── Defect 1: make auth_agent_id() non-inlinable ────────────────────────────
-- plpgsql functions are opaque to the planner, so SECURITY DEFINER survives and the body
-- genuinely runs as `postgres` (rolbypassrls), bypassing agents' RLS. This single change is
-- the root fix; 2 and 3 remove the remaining direct RLS re-entries.
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

-- Re-assert the other three so this migration is self-sufficient if replayed onto a database
-- where they were never hardened. No-ops where they are already correct.
CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
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
  DECLARE result TEXT;
  BEGIN
    SELECT role INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;

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

-- ── Defect 2: agents_select must not read team_agents/teams itself ──────────
DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );

-- ── Defect 3: team_agents_write must not read agents inline ─────────────────
-- Same visibility rule as before (admin, or the team's own manager) — the only change is
-- routing the "who am I" lookup through auth_agent_id() instead of an inline subquery that
-- re-enters agents' RLS. Preserves the WITH CHECK from 20260806_managers_write_own_team.sql.
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

COMMIT;

-- ⚠️ DO NOT re-run 20260814_scope_remaining_tables_to_agent_and_manager.sql after this file.
-- It re-declares auth_agent_id() as LANGUAGE sql and restores the inline agents_select body —
-- i.e. it reintroduces defects 1 and 2 verbatim and will reproduce this exact outage.
