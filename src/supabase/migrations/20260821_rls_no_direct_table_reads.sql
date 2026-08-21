-- ══════════════════════════════════════════════════════════════════════════════
-- COMPLETE RLS FIX — replaces every policy at once. Run this whole file, once.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- Previous attempts fixed tables one pair at a time and the failures just moved:
-- agents -> team_agents -> debtors -> portfolios. That is because EVERY policy in this schema
-- contains the same two re-entrant patterns:
--
--     (SELECT id FROM agents WHERE auth_user_id = auth.uid())        -- reads agents
--     team_agents ta JOIN teams t ... WHERE t.manager_id = (...)     -- reads team_agents+teams
--
-- Each of those reads runs as the CALLING role, so it re-enters that table's own RLS. Any
-- cycle among them raises 42P17. Fixing one policy just relocates the cycle — which is exactly
-- the behaviour we observed.
--
-- THE FIX: no policy may read an RLS-protected table directly. Every such lookup goes through
-- a SECURITY DEFINER function owned by `postgres` (verified: rolbypassrls = true, and no table
-- has relforcerowsecurity), so the read happens with RLS bypassed and cannot re-enter.
--
-- Semantics are UNCHANGED — admin sees everything, a manager sees their own team, an agent
-- sees only their own rows. Only the lookup mechanism changes.
--
-- No BEGIN/COMMIT: the Supabase SQL Editor supplies its own transaction, and a nested one
-- silently rolled an earlier attempt back.

-- ── 1. Helper functions (RLS-exempt) ─────────────────────────────────────────

-- plpgsql, NOT sql: Postgres inlines simple SQL functions, which discards SECURITY DEFINER
-- and reintroduces the recursion. This was the original root cause.
CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
  BEGIN
    SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END; $$;

CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
  BEGIN
    SELECT client_id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END; $$;

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result TEXT;
  BEGIN
    SELECT role INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END; $$;

-- "Whose rows may I see": my own + (if I manage a team) that team's agents + my own manager.
-- Reads agents/team_agents/teams with RLS off, so no policy is ever re-entered.
CREATE OR REPLACE FUNCTION auth_visible_agent_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID;
  BEGIN
    SELECT id INTO me FROM agents WHERE auth_user_id = auth.uid();
    RETURN QUERY
    SELECT me
    UNION
    SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
      WHERE t.manager_id = me
    UNION
    SELECT t.manager_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
      WHERE ta.agent_id = me;
  END; $$;

-- "Which portfolios may I see": ones I manage, ones owned by a team I manage, and ones
-- containing a debtor assigned to me. Breaks the debtors <-> portfolios mutual cycle.
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
    SELECT portfolio_id FROM debtors
      WHERE assigned_agent_id = me AND portfolio_id IS NOT NULL;
  END; $$;

-- "Which debtors belong to my client": used by the five downstream tables to scope by tenant
-- without reading `debtors` (and therefore debtors_select) directly.
CREATE OR REPLACE FUNCTION auth_client_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY SELECT id FROM debtors WHERE client_id = auth_client_id();
  END; $$;

-- ── 2. agents ────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );

-- ── 3. team_agents (its FOR ALL policy also governs SELECT) ──────────────────
DROP POLICY IF EXISTS team_agents_select ON team_agents;
CREATE POLICY team_agents_select ON team_agents FOR SELECT TO authenticated
  USING (team_id IN (SELECT id FROM teams WHERE client_id = auth_client_id()));

DROP POLICY IF EXISTS team_agents_write ON team_agents;
CREATE POLICY team_agents_write ON team_agents FOR ALL TO authenticated
  USING (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = auth_client_id()
        AND (auth_role() = 'admin' OR manager_id = auth_agent_id())
    )
  )
  WITH CHECK (
    team_id IN (
      SELECT id FROM teams
      WHERE client_id = auth_client_id()
        AND (auth_role() = 'admin' OR manager_id = auth_agent_id())
    )
  );

-- ── 4. portfolios ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS portfolios_select ON portfolios;
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_portfolio_ids()))
  );

-- ── 5. debtors ───────────────────────────────────────────────────────────────
-- Previously read team_agents inline — the cause of the latest round of failures.
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
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  );

-- ── 6. Downstream tables: call_logs, messages, payments, disputes, settlements ─
-- All five share one shape: scope to the tenant's debtors, then to admin / own rows / team.
DROP POLICY IF EXISTS call_logs_select ON call_logs;
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS disputes_select ON disputes;
CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR raised_by = auth_agent_id()
      OR (auth_role() = 'manager' AND raised_by IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS settlements_select ON settlement_requests;
CREATE POLICY settlements_select ON settlement_requests FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR requested_by = auth_agent_id()
      OR (auth_role() = 'manager' AND requested_by IN (SELECT auth_visible_agent_ids()))
    )
  );

