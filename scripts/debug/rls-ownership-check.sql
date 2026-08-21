-- Why is SECURITY DEFINER not bypassing RLS on `agents`?
--
-- Mechanism, precisely: SECURITY DEFINER runs the body as the FUNCTION'S OWNER. RLS is skipped
-- only if that owner either (a) owns the table, or (b) has rolbypassrls. If it is neither, the
-- body's `SELECT ... FROM agents` is itself subject to agents_select — which calls the
-- function — genuine recursion. This is the one thing never actually verified here.
--
-- NOTE on `SET row_security = off`: it does NOT grant a bypass. Per Postgres docs it makes a
-- query ERROR rather than apply a policy; it only looks like it works for already-exempt
-- roles. So ownership is the whole ballgame.
--
-- Everything is UNIONed into ONE result set on purpose: Supabase's SQL Editor renders only the
-- final statement's output, which is why earlier multi-section diagnostics came back blank.

SELECT * FROM (
  -- ── Function owners / language / settings ─────────────────────────────────
  -- Every auth_* fn's owner must match the agents table owner below, or have rolbypassrls.
  -- A mismatch on even one — especially auth_visible_agent_ids(), which may have been CREATED
  -- fresh (new owner) rather than REPLACED (owner preserved) — is the bug.
  SELECT
    '1_function' AS section,
    p.proname    AS name,
    p.proowner::regrole::text AS owner,
    l.lanname || CASE WHEN p.prosecdef THEN ' / SECURITY DEFINER' ELSE ' / INVOKER' END
      || ' / ' || COALESCE(array_to_string(p.proconfig, ' | '), 'no settings') AS detail
  FROM pg_proc p
  JOIN pg_language l ON l.oid = p.prolang
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('auth_client_id','auth_role','auth_agent_id','auth_visible_agent_ids')

  UNION ALL

  -- ── Table owner + whether RLS is FORCED ───────────────────────────────────
  -- relforcerowsecurity MUST be false: forcing RLS applies policies even to the table owner,
  -- which would defeat the SECURITY DEFINER exemption entirely.
  SELECT
    '2_table',
    c.relname,
    c.relowner::regrole::text,
    CASE WHEN c.relrowsecurity THEN 'rls=ON' ELSE 'rls=off' END
      || CASE WHEN c.relforcerowsecurity THEN ' / FORCED (breaks owner exemption!)' ELSE ' / not forced' END
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('agents','team_agents','teams')

  UNION ALL

  -- ── Which roles can bypass RLS at all ─────────────────────────────────────
  -- The function owner above needs rolbypassrls=true here, or must be exactly the agents
  -- owner. e.g. functions owned by `supabase_admin` while agents is owned by `postgres`
  -- (or vice versa) would be the entire outage.
  SELECT
    '3_role',
    rolname,
    '',
    'superuser=' || rolsuper || ' / bypassrls=' || rolbypassrls
  FROM pg_roles
  WHERE rolname IN ('postgres','supabase_admin','authenticator','authenticated','service_role')

  UNION ALL

  -- ── Who the SQL Editor runs as ────────────────────────────────────────────
  -- CREATE OR REPLACE preserves an EXISTING function's owner, but a first-time CREATE is owned
  -- by whoever ran it — i.e. this role.
  SELECT '4_editor', current_user, session_user, ''

  UNION ALL

  -- ── Full policy text on the recursing tables ──────────────────────────────
  -- team_agents reported its OWN recursion (not the agents cascade), so its policy text
  -- matters too — including any FOR ALL policy, which also governs SELECT.
  SELECT
    '5_policy',
    tablename || '.' || policyname,
    cmd,
    COALESCE(qual, '(no USING)')
  FROM pg_policies
  WHERE tablename IN ('agents','team_agents')
) x
ORDER BY section, name;
