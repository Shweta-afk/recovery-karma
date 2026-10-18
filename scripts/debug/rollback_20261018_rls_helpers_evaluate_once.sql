-- Rollback for migrations/20261018_rls_helpers_evaluate_once.sql: restores the definitions that
-- were live on 2026-10-18 (copied from pg_get_functiondef / pg_policies that day). Paste into the
-- Supabase SQL Editor only if that migration changed what someone can see. Kept out of
-- migrations/ on purpose so no runner ever applies it.

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION auth_client_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY SELECT id FROM debtors WHERE client_id = auth_client_id();
  END; $$;

CREATE OR REPLACE FUNCTION auth_client_agent_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY SELECT id FROM agents WHERE client_id = auth_client_id();
  END; $$;

CREATE OR REPLACE FUNCTION auth_visible_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY
    SELECT id FROM debtors WHERE portfolio_id IN (SELECT auth_visible_portfolio_ids())
    UNION
    SELECT id FROM debtors WHERE assigned_agent_id = auth_agent_id();
  END; $$;

CREATE OR REPLACE FUNCTION auth_my_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; r TEXT; cid UUID;
  BEGIN
    me := auth_agent_id();
    r := auth_role();
    cid := auth_client_id();
    RETURN QUERY
    SELECT id FROM debtors
      WHERE client_id = cid
        AND (
          r = 'admin'
          OR assigned_agent_id = me
          OR (
            r = 'manager'
            AND (
              assigned_agent_id IN (SELECT auth_visible_agent_ids())
              OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
            )
          )
        );
  END; $$;

ALTER POLICY debtors_select ON debtors
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR assigned_agent_id = auth_agent_id()
      OR (
        auth_role() = 'manager'
        AND (
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  );

ALTER POLICY portfolios_select ON portfolios
  USING (client_id = auth_client_id() AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_portfolio_ids())));

ALTER POLICY agents_select ON agents
  USING (client_id = auth_client_id() AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids())));

ALTER POLICY debtor_traces_select ON debtor_traces
  USING (client_id = auth_client_id() AND debtor_id IN (SELECT auth_my_debtor_ids()));

ALTER POLICY insight_requests_select ON insight_requests
  USING (client_id = auth_client_id() AND debtor_id IN (SELECT auth_my_debtor_ids()));
