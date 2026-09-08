-- Manager data isolation: three tables were readable across the whole client instead of being
-- scoped to a manager's own team, confirmed live via `pg_policies` on 2026-09-08:
--
--   teams_select        USING (client_id = auth_client_id())
--   team_agents_select  USING (team_id IN (SELECT id FROM teams WHERE client_id = auth_client_id()))
--   ptp_escalations_*   USING (debtor_id IN (SELECT auth_client_debtor_ids()))
--
-- None of these check WHO the caller is beyond "same client" — so any manager (or agent) could
-- read every OTHER manager's team roster (name + manager_id + full agent membership) via
-- `teams`/`team_agents`, and every other team's PTP/callback escalations via `ptp_escalations`,
-- regardless of what the UI renders. The app code already filters its own display down to the
-- caller's team (team-store.ts, ptp-escalation-store.ts) but that's a client-side convenience,
-- not a security boundary — a direct API call bypasses it entirely.
--
-- report_agent_account_counts()/report_portfolio_totals() were also checked (both LANGUAGE sql,
-- SECURITY INVOKER, not DEFINER) — they run under the caller's own RLS, so their internal joins
-- against debtors/agents/portfolios are already correctly narrowed by debtors_select/
-- agents_select/portfolios_select. No change needed there.
--
-- Fix follows the established convention (see 20260821_rls_no_direct_table_reads.sql): every
-- cross-table visibility check goes through one SECURITY DEFINER, plpgsql, row_security=off
-- helper, so no policy ever reads another RLS-protected table directly and nothing can recurse.

-- ── 1. New helper: which teams may I see ─────────────────────────────────────────────────────
-- Mirrors auth_visible_agent_ids()/auth_visible_portfolio_ids(): a manager sees teams they
-- manage, an agent sees the team(s) they belong to. Admin/client scoping is applied by the
-- calling policy from the table's own client_id column, same as every other _select policy.
CREATE OR REPLACE FUNCTION auth_visible_team_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID;
  BEGIN
    SELECT id INTO me FROM agents WHERE auth_user_id = auth.uid();
    RETURN QUERY
    SELECT id FROM teams WHERE manager_id = me
    UNION
    SELECT team_id FROM team_agents WHERE agent_id = me;
  END; $$;

-- ── 2. teams: a manager sees only their own team(s), an agent only the team they're in ──────
DROP POLICY IF EXISTS teams_select ON teams;
CREATE POLICY teams_select ON teams FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_team_ids()))
  );

-- ── 3. team_agents: same visibility as the team itself, via the helper only (no direct reads
--    of teams/team_agents from either policy body, so nothing can recurse) ──────────────────
DROP POLICY IF EXISTS team_agents_select ON team_agents;
CREATE POLICY team_agents_select ON team_agents FOR SELECT TO authenticated
  USING (
    auth_role() = 'admin'
    OR team_id IN (SELECT auth_visible_team_ids())
  );

-- team_agents_write already scopes correctly (admin OR teams.manager_id = auth_agent_id()) —
-- left untouched.

-- ── 4. ptp_escalations: scope to debtors the caller can actually see, not the whole client ──
-- Same shape as call_logs_select/messages_select/etc: tenant boundary first, then admin / own
-- visibility. auth_visible_debtor_ids() already covers "my own debtor" (agent) and "my team's
-- portfolio or assigned-agent debtors" (manager).
DROP POLICY IF EXISTS ptp_escalations_select ON ptp_escalations;
CREATE POLICY ptp_escalations_select ON ptp_escalations FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (auth_role() = 'admin' OR debtor_id IN (SELECT auth_visible_debtor_ids()))
  );

DROP POLICY IF EXISTS ptp_escalations_insert ON ptp_escalations;
CREATE POLICY ptp_escalations_insert ON ptp_escalations FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (auth_role() = 'admin' OR debtor_id IN (SELECT auth_visible_debtor_ids()))
  );

NOTIFY pgrst, 'reload schema';
