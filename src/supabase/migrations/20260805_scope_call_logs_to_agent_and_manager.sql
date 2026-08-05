-- call_logs_select (20260730_harden_rls.sql) scopes only to the caller's company: any
-- agent, manager, or admin in the tenant can read every other agent's call history. An
-- agent's "Activity History" page and a manager's "Call Audit" page both pull the full
-- unfiltered table client-side (disposition-store.refreshDispositions selects call_logs.*
-- with no agent/team filter, relying entirely on RLS to scope it) — so this was a live
-- data leak: any agent could see the whole company's calls, not just their own.
--
-- New rule: an agent sees only calls they logged; a manager sees their own calls plus
-- calls logged by agents on a team they manage; an admin keeps full company-wide access
-- (unchanged) for compliance/audit oversight.

DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
    AND (
      auth_role() = 'admin'
      OR agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR (
        auth_role() = 'manager'
        AND agent_id IN (
          SELECT ta.agent_id
          FROM team_agents ta
          JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
      )
    )
  );
