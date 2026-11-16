-- Managers read call notes only on accounts in their own portfolios (user, 2026-11-16).
-- Before: the manager branch allowed every call by an agent on the manager's team, so with an
-- agent shared between two managers (allowed since 2026-11-03) Manager A read the agent's notes
-- on Manager B's accounts. Measured before writing this: 455 of 13,690 calls, 3 managers, 6
-- portfolios, none on portfolios without a team/manager. Now the team-agent branch covers only
-- manual calls with no account (debtor_id IS NULL); account calls go through the existing
-- auth_visible_debtor_ids() branch, which is the manager's own portfolios. Admins and agents
-- are unchanged. NOT APPLIED until the user approves; compare
-- scripts/debug/rls-visibility-fingerprint.sql before and after.
DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs
  FOR SELECT TO authenticated
  USING (
    (
      debtor_id IN (SELECT auth_client_debtor_ids())
      OR (debtor_id IS NULL AND agent_id IN (SELECT auth_client_agent_ids()))
    )
    AND (
      (SELECT auth_role()) = 'admin'
      OR agent_id = (SELECT auth_agent_id())
      OR (
        (SELECT auth_role()) = 'manager'
        AND debtor_id IS NULL
        AND agent_id IN (SELECT auth_visible_agent_ids())
      )
      OR debtor_id IN (SELECT auth_visible_debtor_ids())
    )
  );
