-- Probe EVERY table the app reads, in one shot, as a real signed-in user.
-- `agents` alone was fixed on 2026-08-21 but the app still 500s — so either another table's
-- policy recurses, or PostgREST is serving cached plans. This finds all of them at once
-- instead of one 500 at a time.
--
-- Run the whole file. The LAST statement returns the result table (Supabase's SQL Editor only
-- renders the final result set, which is why earlier diagnostics came back blank).

-- ── Step 0: tell PostgREST to drop its cached schema/plans ───────────────────
-- Cheap, safe, and a real possibility on its own: CREATE OR REPLACE FUNCTION can leave
-- pooled connections holding plans that still reference the OLD function definition.
NOTIFY pgrst, 'reload schema';
DISCARD PLANS;

-- ── Step 1: a probe that captures the error instead of aborting the query ────
-- SECURITY INVOKER is essential — it must run as the *calling* role (authenticated) so RLS
-- applies exactly as it does for a real request.
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

-- ── Step 2: run every table under a real authenticated session ──────────────
-- Uses one of the auth_user_ids from the browser console. Swap it for an ADMIN user's id and
-- re-run to compare — admin takes a different branch in most policies, so a table can pass for
-- one role and recurse for the other.
BEGIN;
  SET LOCAL ROLE authenticated;
  SET LOCAL request.jwt.claims TO '{"sub":"0015916e-bd23-4816-b3b1-cb81c7ae9cd1"}';

  SELECT t AS table_name, _rls_probe(t) AS result
  FROM unnest(ARRAY[
    'clients',
    'agents',
    'teams',
    'team_agents',
    'portfolios',
    'debtors',
    'call_logs',
    'messages',
    'payments',
    'disputes',
    'settlement_requests'
  ]) AS t
  ORDER BY 1;
ROLLBACK;
