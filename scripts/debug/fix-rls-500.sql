-- ONE-SHOT: capture current state → apply fix → verify.
-- Confirmed 2026-08-21: "42P17 infinite recursion detected in policy for relation agents".
-- Run this whole file in the Supabase SQL Editor. Sections 1 and 2 are read-only and tell us
-- WHY it broke; section 3 is the idempotent fix; section 4 proves it's fixed.
-- Please paste back the output of sections 1, 2 and 4.

-- ═══ 1. BEFORE: are the helpers still the hardened versions? ═════════════════
-- All four must be: prolang='plpgsql', security_definer=true, and settings containing
-- BOTH 'search_path=public, pg_temp' AND 'row_security=off'.
-- 'sql' in prolang, or a missing row_security=off, is the smoking gun.
-- A MISSING ROW here (esp. auth_visible_agent_ids) means the 20260814 hardening was lost.
SELECT
  p.proname   AS function_name,
  l.lanname   AS prolang,
  p.prosecdef AS security_definer,
  p.proconfig AS settings
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('auth_client_id','auth_role','auth_agent_id','auth_visible_agent_ids')
ORDER BY p.proname;

-- ═══ 2. BEFORE: what does agents_select actually look like? ═════════════════
-- Healthy: references auth_visible_agent_ids().
-- Broken:  contains an inline "FROM team_agents"/"FROM teams" subquery, meaning the older
--          20260814_scope_remaining_tables migration overwrote the hardened version.
SELECT tablename, policyname, cmd, qual
FROM pg_policies
WHERE tablename IN ('agents','team_agents','teams')
ORDER BY tablename, policyname;

-- ═══ 3. FIX (idempotent — no-op if already correct) ═════════════════════════
-- All three properties below are load-bearing:
--   LANGUAGE plpgsql        -> a single-statement LANGUAGE sql fn gets INLINED by the
--                              planner, silently discarding SECURITY DEFINER.
--   SECURITY DEFINER        -> runs as table owner, which is exempt from RLS.
--   SET row_security = off  -> covers EVERY read in the body (agents, teams, team_agents),
--                              not just the final lookup, so nothing re-enters RLS.
CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
  BEGIN
    SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END; $$;

CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
  BEGIN
    SELECT client_id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END; $$;

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result TEXT;
  BEGIN
    SELECT role INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END; $$;

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
  END; $$;

DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );

-- ═══ 4. AFTER: verify as a real signed-in user ══════════════════════════════
-- Both SELECTs must return rows. If either still raises 42P17, the helpers were NOT the
-- cause and section 2's policy dump is what we need to look at next.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{"sub":"0015916e-bd23-4816-b3b1-cb81c7ae9cd1"}';
  SELECT name, email, role FROM agents
   WHERE auth_user_id = '0015916e-bd23-4816-b3b1-cb81c7ae9cd1';
  SELECT count(*) AS team_agents_readable FROM team_agents;
  SELECT count(*) AS agents_readable FROM agents;
ROLLBACK;
