-- ⚠️ call_logs_select / messages_select below let every company's admin read every company's
-- NULL-debtor rows. Corrected by 20261011_scope_null_debtor_rows_to_company.sql, which sorts
-- after this file — keep it that way.
--
-- Re-assert the eleven policies Supabase's performance advisor flags as "Auth RLS Initialization
-- Plan" (lint 0003), and bring them back to the definitions this repo says are current.
--
-- Found 2026-10-11: production was NOT running the repo's versions of these. Live still had the
-- pre-2026-08-21 bodies that read agents / debtors / teams directly and call auth.uid() inline —
-- the pattern CLAUDE.md bans (recursion risk) and the reason the advisor flagged them (auth.uid()
-- re-evaluated per row). So this file changes behaviour in three places, all of them decisions
-- already recorded in earlier migrations that never reached production:
--
--   * call_logs_select — notes follow the account: anyone who can see a debtor sees every call
--     logged against it (20260827_notes_visible_on_shared_debtor.sql). Production was still
--     own-notes-only, so a reassigned account showed its new agent an empty history.
--   * disputes_select / settlements_select — rows must belong to a debtor in the caller's company;
--     a NULL debtor no longer matches (20260920_rls_hardening_round2.sql, item 1: closes a
--     cross-tenant read for admins). 0 such rows existed when this was written.
--
-- The other eight keep their meaning; only how they look up the caller changes:
--   * an inline `(SELECT id FROM agents WHERE auth_user_id = auth.uid())` becomes auth_agent_id()
--   * `debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())` becomes
--     auth_client_debtor_ids()
--   * a bare auth.uid() becomes (SELECT auth.uid()), and every scalar helper (auth_role(),
--     auth_agent_id(), auth_client_id()) is wrapped the same way. They are STABLE, which Postgres
--     still calls once per ROW; inside (SELECT ...) each becomes an initplan run once per query.
--     Measured 2026-10-11: an admin reading call_logs (66 rows) took 4.5s under the old policies.
--   * call_logs_manager_audit_update's team lookup becomes auth_visible_agent_ids(), the same set
--     call_logs_select already uses for a manager — a manager may audit exactly the calls they
--     can read.
--
-- notifications_recipient_only exists only in production (no earlier file creates it); its
-- meaning is kept as found: role PUBLIC, every command, recipient = the caller.
--
-- Written to the rules in CLAUDE.md: no policy here reads an RLS-protected table except
-- team_agents_write, which reads `teams` exactly as 20260821_rls_no_direct_table_reads.sql does;
-- no BEGIN/COMMIT. Sorts after every file that defines these policies, so a full replay ends here.
-- Idempotent.

-- ── call_logs ────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      (SELECT auth_role()) = 'admin'
      OR agent_id = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
      OR debtor_id IN (SELECT auth_visible_debtor_ids())
    )
  );

DROP POLICY IF EXISTS call_logs_manager_audit_update ON call_logs;
CREATE POLICY call_logs_manager_audit_update ON call_logs FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      (SELECT auth_role()) = 'admin'
      OR ((SELECT auth_role()) = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  )
  WITH CHECK (debtor_id IN (SELECT auth_client_debtor_ids()));

-- ── messages ─────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      (SELECT auth_role()) = 'admin'
      OR agent_id = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );

-- ── disputes / settlement_requests ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS disputes_select ON disputes;
CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      (SELECT auth_role()) = 'admin'
      OR raised_by = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND raised_by IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS settlements_select ON settlement_requests;
CREATE POLICY settlements_select ON settlement_requests FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      (SELECT auth_role()) = 'admin'
      OR requested_by = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND requested_by IN (SELECT auth_visible_agent_ids()))
    )
  );

-- ── teams / team_agents ──────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS teams_insert ON teams;
CREATE POLICY teams_insert ON teams FOR INSERT TO authenticated
  WITH CHECK (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR ((SELECT auth_role()) = 'manager' AND manager_id = (SELECT auth_agent_id()))
    )
  );

DROP POLICY IF EXISTS teams_update ON teams;
CREATE POLICY teams_update ON teams FOR UPDATE TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR ((SELECT auth_role()) = 'manager' AND manager_id = (SELECT auth_agent_id()))
    )
  )
  WITH CHECK (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR ((SELECT auth_role()) = 'manager' AND manager_id = (SELECT auth_agent_id()))
    )
  );

DROP POLICY IF EXISTS teams_delete ON teams;
CREATE POLICY teams_delete ON teams FOR DELETE TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR ((SELECT auth_role()) = 'manager' AND manager_id = (SELECT auth_agent_id()))
    )
  );

DROP POLICY IF EXISTS team_agents_write ON team_agents;
CREATE POLICY team_agents_write ON team_agents FOR ALL TO authenticated
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = (SELECT auth_client_id())
        AND ((SELECT auth_role()) = 'admin' OR manager_id = (SELECT auth_agent_id()))
    )
  )
  WITH CHECK (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = (SELECT auth_client_id())
        AND ((SELECT auth_role()) = 'admin' OR manager_id = (SELECT auth_agent_id()))
    )
  );

-- ── agents ───────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS agents_update ON agents;
CREATE POLICY agents_update ON agents FOR UPDATE TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND ((SELECT auth_role()) = 'admin' OR auth_user_id = (SELECT auth.uid()))
  )
  WITH CHECK (client_id = (SELECT auth_client_id()));

-- ── notifications ────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS notifications_recipient_only ON notifications;
CREATE POLICY notifications_recipient_only ON notifications
  USING (to_agent_id = (SELECT auth_agent_id()));
