-- ROUND 2 of the 2026-08-21 outage. Round 1 (fix-rls-500-notx.sql) fixed agents/team_agents —
-- confirmed: agents, team_agents, teams, clients all now return OK.
--
-- The remaining failures are a DIFFERENT bug: debtors and portfolios recurse on THEMSELVES,
-- and call_logs / messages / payments / disputes / settlement_requests all cascade off
-- "relation debtors" because their policies read debtors to scope by client.
--
-- Cause: debtors_select's manager branch reads `portfolio_id IN (SELECT id FROM portfolios ...)`
-- while portfolios_select reads `id IN (SELECT portfolio_id FROM debtors ...)`. Each policy
-- queries the other's table, so resolving either requires resolving the other, forever. This is
-- root cause #2 in CLAUDE.md, and 20260817_fix_debtors_portfolios_mutual_recursion.sql already
-- solved it — it has evidently been reverted by the same replay of
-- 20260814_scope_remaining_tables_to_agent_and_manager.sql that undid the agents hardening.
--
-- Fix shape (unchanged from 20260817): pull the cross-table traversal into ONE
-- row_security=off function, so neither policy ever queries the other table directly.
--
-- ONE IMPROVEMENT over the original: the 2026-08-17 version used inline
-- `(SELECT id FROM agents WHERE auth_user_id = auth.uid())` in several places, because back
-- then auth_agent_id() was the broken LANGUAGE sql version and couldn't be trusted. We fixed
-- that in round 1, so those inline reads are now routed through auth_agent_id() instead —
-- removing three more direct RLS re-entries, which is the entire class of bug here.
--
-- NO explicit BEGIN/COMMIT: Supabase's SQL Editor wraps statements in its own transaction and
-- a nested one can silently roll the DDL back (this is what stalled the first attempt).
-- Run STEP 1, then STEP 2, then STEP 3 as separate pastes so any failure is visible.

-- ══ STEP 1 ══ The cross-table traversal, isolated behind one RLS-exempt function.
CREATE OR REPLACE FUNCTION auth_visible_portfolio_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID;
  BEGIN
    SELECT id INTO me FROM agents WHERE auth_user_id = auth.uid();
    RETURN QUERY
    SELECT id FROM portfolios WHERE manager_id = me
    UNION
    SELECT id FROM portfolios WHERE team_id IN (SELECT id FROM teams WHERE manager_id = me)
    UNION
    SELECT portfolio_id FROM debtors WHERE assigned_agent_id = me AND portfolio_id IS NOT NULL;
  END;
  $$;


-- ══ STEP 2 ══ portfolios_select — no longer reads debtors directly.
DROP POLICY IF EXISTS portfolios_select ON portfolios;
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_portfolio_ids()))
  );


-- ══ STEP 3 ══ debtors_select — no longer reads portfolios directly.
-- Visibility rule is unchanged: admin sees all; an agent sees debtors assigned to them; a
-- manager sees their team's debtors plus everything in portfolios they own (so freshly
-- uploaded, not-yet-assigned debtors stay visible for assignment).
DROP POLICY IF EXISTS debtors_select ON debtors;
CREATE POLICY debtors_select ON debtors FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR assigned_agent_id = auth_agent_id()
      OR (
        auth_role() = 'manager'
        AND (
          assigned_agent_id IN (
            SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
            WHERE t.manager_id = auth_agent_id()
          )
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  );


-- ══ STEP 4 ══ Verify. All 11 rows must say OK.
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
