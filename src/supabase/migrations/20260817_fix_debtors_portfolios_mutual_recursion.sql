-- Same class of bug as 20260814_disable_row_security_in_auth_helpers.sql (agents_select), but
-- between two DIFFERENT tables this time: 20260814_scope_remaining_tables_to_agent_and_manager.sql
-- gave debtors_select a manager branch that reads `portfolio_id IN (SELECT id FROM portfolios
-- WHERE ...)`, and portfolios_select a manager branch that reads `id IN (SELECT portfolio_id
-- FROM debtors WHERE ...)` — each table's SELECT policy queries the other table directly, so
-- resolving either one requires resolving the other, forever. Confirmed live 2026-08-17:
-- every query touching debtors OR portfolios (and everything downstream that reads through
-- debtors — call_logs, messages, payments) 500'd with 42P17 "infinite recursion detected in
-- policy for relation debtors/portfolios", which is what broke portfolio upload (createPortfolio
-- reads/writes both) and effectively every other page.
--
-- Same fix shape as before: pull the cross-table lookup into one row_security=off function so
-- neither policy ever queries the other table directly — it queries this function instead,
-- which reads both tables raw (RLS bypassed for its own execution) and unions the result.
CREATE OR REPLACE FUNCTION auth_visible_portfolio_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    me UUID;
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

DROP POLICY IF EXISTS portfolios_select ON portfolios;
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_portfolio_ids()))
  );

DROP POLICY IF EXISTS debtors_select ON debtors;
CREATE POLICY debtors_select ON debtors FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR assigned_agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR (
        auth_role() = 'manager'
        AND (
          assigned_agent_id IN (
            SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
            WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
          )
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  );
