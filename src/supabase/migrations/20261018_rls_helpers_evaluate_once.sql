-- Speed only: every check below allows exactly the same rows as before.
--
-- Found 2026-10-18 while chasing statement timeouts across the app. Reading call_logs (66 rows)
-- as a manager took 9.8 s, over the 8 s limit for `authenticated`, and the queries queued behind
-- it timed out too (the Insights tab's "canceling statement due to statement timeout").
--
-- Cause: an auth_*() call written in a WHERE clause or a policy as a plain function call is run
-- once PER ROW checked, not once per query. auth_client_id() and friends each read `agents`, so a
-- check over a 29,813-debtor company did tens of thousands of lookups:
--   auth_client_debtor_ids()  1,924 ms  -> ~170 ms
--   auth_visible_debtor_ids() 2,461 ms  ->  ~33 ms (also: `IN (SELECT set-returning fn)` over all
--                                                   debtors was a full scan; an array uses the index)
--   debtors count, manager    1,553 ms  (debtors_select calls three auth_*() per row)
--
-- Fix: helpers read the caller once into variables (as auth_my_debtor_ids already did), and the
-- policies wrap each auth_*() in a scalar subquery, `(SELECT auth_x())`, which Postgres evaluates
-- once per query (an InitPlan). Same functions, same arguments, same results.
--
-- Helpers stay plpgsql + SECURITY DEFINER + `SET row_security = off` (see CLAUDE.md, the RLS
-- recursion notes). Policies are changed with ALTER POLICY, which keeps their command and roles.
-- No table is rewritten; each ALTER POLICY holds its table's lock for milliseconds, and
-- lock_timeout makes it give up rather than queue behind a long query and block the app.

SET LOCAL lock_timeout = '3s';

-- ── Helpers ─────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION auth_client_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE cid UUID;
  BEGIN
    cid := auth_client_id();
    RETURN QUERY SELECT id FROM debtors WHERE client_id = cid;
  END; $$;

CREATE OR REPLACE FUNCTION auth_client_agent_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE cid UUID;
  BEGIN
    cid := auth_client_id();
    RETURN QUERY SELECT id FROM agents WHERE client_id = cid;
  END; $$;

-- Same two branches as before: debtors in a portfolio I can see, plus debtors assigned to me.
CREATE OR REPLACE FUNCTION auth_visible_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; pids UUID[];
  BEGIN
    me := auth_agent_id();
    pids := ARRAY(SELECT auth_visible_portfolio_ids());
    RETURN QUERY
    SELECT id FROM debtors WHERE portfolio_id = ANY (pids)
    UNION
    SELECT id FROM debtors WHERE assigned_agent_id = me;
  END; $$;

-- Already read the caller once; the manager branch now uses arrays too, for the same index reason.
CREATE OR REPLACE FUNCTION auth_my_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; r TEXT; cid UUID; aids UUID[]; pids UUID[];
  BEGIN
    me := auth_agent_id();
    r := auth_role();
    cid := auth_client_id();
    IF r = 'manager' THEN
      aids := ARRAY(SELECT auth_visible_agent_ids());
      pids := ARRAY(SELECT auth_visible_portfolio_ids());
    END IF;
    RETURN QUERY
    SELECT id FROM debtors
      WHERE client_id = cid
        AND (
          r = 'admin'
          OR assigned_agent_id = me
          OR (
            r = 'manager'
            AND (assigned_agent_id = ANY (aids) OR portfolio_id = ANY (pids))
          )
        );
  END; $$;

-- ── Policies: the same expressions, each auth_*() evaluated once per query ──────────────────

ALTER POLICY debtors_select ON debtors
  USING (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR assigned_agent_id = (SELECT auth_agent_id())
      OR (
        (SELECT auth_role()) = 'manager'
        AND (
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  );

ALTER POLICY portfolios_select ON portfolios
  USING (
    client_id = (SELECT auth_client_id())
    AND ((SELECT auth_role()) = 'admin' OR id IN (SELECT auth_visible_portfolio_ids()))
  );

ALTER POLICY agents_select ON agents
  USING (
    client_id = (SELECT auth_client_id())
    AND ((SELECT auth_role()) = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );

ALTER POLICY debtor_traces_select ON debtor_traces
  USING (client_id = (SELECT auth_client_id()) AND debtor_id IN (SELECT auth_my_debtor_ids()));

ALTER POLICY insight_requests_select ON insight_requests
  USING (client_id = (SELECT auth_client_id()) AND debtor_id IN (SELECT auth_my_debtor_ids()));
