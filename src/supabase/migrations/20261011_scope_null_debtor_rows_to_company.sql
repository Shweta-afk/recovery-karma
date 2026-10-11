-- Close a cross-company read that 20261011_rls_policies_converge_and_initplan.sql put live.
--
-- call_logs_select (and messages_select) allow `debtor_id IS NULL OR debtor_id IN
-- (SELECT auth_client_debtor_ids())` and then the admin branch, with nothing tying a NULL-debtor
-- row to a company. Ad-hoc Manual Dial calls (no Loan ID) are exactly those rows, so EVERY
-- company's admin could read every company's ad-hoc calls. Verified 2026-10-11 right after the
-- converge migration: 13 such calls, all one company, visible to admins of two other companies.
-- The same hole that 20260920_rls_hardening_round2.sql (item 1) closed for payments; this
-- definition came from 20260827_notes_visible_on_shared_debtor.sql, which never reached
-- production, so it had never been exposed before 2026-10-11.
--
-- call_logs / messages carry no client_id, so a NULL-debtor row is tied to a company through the
-- agent who made it: auth_client_agent_ids() = every agent in the caller's company. NULL
-- debtor AND NULL agent matches nothing (0 such call_logs rows when this was written).
--
-- Written to the CLAUDE.md rules: plpgsql + SECURITY DEFINER + row_security off, no BEGIN/COMMIT.
-- Sorts after 20261011_rls_policies_converge_and_initplan.sql, so a replay ends here. Idempotent.

CREATE OR REPLACE FUNCTION auth_client_agent_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY SELECT id FROM agents WHERE client_id = auth_client_id();
  END; $$;

REVOKE ALL ON FUNCTION auth_client_agent_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auth_client_agent_ids() TO authenticated, service_role;

DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (
    (
      debtor_id IN (SELECT auth_client_debtor_ids())
      OR (debtor_id IS NULL AND agent_id IN (SELECT auth_client_agent_ids()))
    )
    AND (
      (SELECT auth_role()) = 'admin'
      OR agent_id = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
      OR debtor_id IN (SELECT auth_visible_debtor_ids())
    )
  );

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    (
      debtor_id IN (SELECT auth_client_debtor_ids())
      OR (debtor_id IS NULL AND agent_id IN (SELECT auth_client_agent_ids()))
    )
    AND (
      (SELECT auth_role()) = 'admin'
      OR agent_id = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );
