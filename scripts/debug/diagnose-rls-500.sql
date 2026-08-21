-- Diagnose the PostgREST 500s on /rest/v1/agents and /rest/v1/team_agents (2026-08-21).
-- A 500 (rather than 401/403) from these endpoints is almost always Postgres error 42P17,
-- "infinite recursion detected in policy for relation ...". See CLAUDE.md → "RLS 'infinite
-- recursion detected in policy'" for why this class of bug keeps recurring in this project.
--
-- Run each section in the Supabase SQL Editor and compare against "EXPECTED" below.

-- ── 1. Reproduce the actual error ────────────────────────────────────────────
-- Swap in a real agents.auth_user_id — the browser console showed these two:
--   0015916e-bd23-4816-b3b1-cb81c7ae9cd1
--   6715cfa2-b01d-49b8-a427-c107ed9a917c
-- EXPECTED (healthy): one row back.
-- IF BROKEN: ERROR 42P17 infinite recursion detected in policy for relation "agents".
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{"sub":"0015916e-bd23-4816-b3b1-cb81c7ae9cd1"}';
  SELECT name, email, role FROM agents WHERE auth_user_id = '0015916e-bd23-4816-b3b1-cb81c7ae9cd1';
ROLLBACK;

-- ── 2. Are the auth helpers still the hardened versions? ─────────────────────
-- EXPECTED for all four: prolang = 'plpgsql', security_definer = true, and the config
-- array containing BOTH 'search_path=public, pg_temp' AND 'row_security=off'.
--
-- IF prolang shows 'sql' on any of them → they were reverted to the inlinable form and
-- Postgres is discarding SECURITY DEFINER (root cause #1 in CLAUDE.md).
-- IF 'row_security=off' is missing → root cause #2 (cross-table traversal re-enters RLS).
SELECT
  p.proname                      AS function_name,
  l.lanname                      AS prolang,
  p.prosecdef                    AS security_definer,
  p.proconfig                    AS settings
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('auth_client_id', 'auth_role', 'auth_agent_id', 'auth_visible_agent_ids')
ORDER BY p.proname;

-- ── 3. Does agents_select still route through auth_visible_agent_ids()? ──────
-- EXPECTED: the USING clause references auth_visible_agent_ids() and does NOT contain a
-- direct "FROM team_agents" / "FROM teams" subquery. If you see those tables inline in the
-- agents policy, 20260814_disable_row_security_in_auth_helpers.sql has been overwritten by
-- the earlier 20260814_scope_remaining_tables_to_agent_and_manager.sql.
SELECT policyname, qual
FROM pg_policies
WHERE tablename IN ('agents', 'team_agents', 'teams')
ORDER BY tablename, policyname;

-- ── 4. Owner / bypass sanity (ruled out last time, cheap to re-confirm) ──────
-- EXPECTED: function owner == agents table owner, that role has rolbypassrls = true,
-- and agents.relforcerowsecurity = false (forcing RLS on the owner would defeat the
-- SECURITY DEFINER exemption the helpers rely on).
SELECT 'agents table' AS what, c.relowner::regrole::text AS owner,
       c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'agents'
UNION ALL
SELECT 'auth_agent_id fn', p.proowner::regrole::text, NULL, NULL
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'auth_agent_id';

SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = 'postgres';
