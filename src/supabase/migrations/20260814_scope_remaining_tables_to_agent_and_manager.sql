-- call_logs_select (20260805_scope_call_logs_to_agent_and_manager.sql) fixed a company-wide
-- data leak: every table besides call_logs still has the SAME bug today (confirmed by audit
-- 2026-08-14) - debtors, messages, payments, disputes, settlement_requests, portfolios, and
-- agents are all scoped only by client_id, meaning any agent or manager can read every OTHER
-- agent's/team's rows company-wide. This migration applies the identical fix shape to all
-- seven: admin keeps full company-wide access, a manager sees their own team's data, an agent
-- sees only their own. Client code (messages-store.ts, payments-store.ts, portfolio-store.ts,
-- fetch-debtors.ts) already does raw `.select("*")` trusting RLS entirely - no app code change
-- needed, this migration IS the fix.

-- ────────────────────────────────────────────────────────────
-- 0. New helper: the caller's own agents.id, safe to use INSIDE the agents table's own
-- policy. A plain `(SELECT id FROM agents WHERE auth_user_id = auth.uid())` subquery used
-- inside agents_select would recurse (Postgres errors "infinite recursion detected in policy
-- for relation agents") since it queries the very table being protected. SECURITY DEFINER
-- makes this function's internal query bypass RLS, exactly like auth_client_id()/auth_role()
-- already do for the same reason.
-- ────────────────────────────────────────────────────────────
-- ⚠️ AMENDED 2026-08-21 — DO NOT restore the LANGUAGE sql version below.
--
-- This file originally declared auth_agent_id() as `LANGUAGE sql`. Postgres INLINES simple
-- single-statement SQL functions, which silently discards SECURITY DEFINER — so the body's
-- `SELECT id FROM agents` ran as the CALLING role, hit agents_select, which calls this
-- function: genuine recursion (42P17).
--
-- That was already fixed by 20260814_fix_auth_agent_id_recursion.sql — but migrations apply in
-- FILENAME ORDER, and "scope_remaining_tables" sorts AFTER both "disable_row_security..." and
-- "fix_auth_agent_id...", so every replay of this directory silently re-broke production. That
-- is what caused the 2026-08-21 outage, and it had likely been recurring on every deploy.
--
-- Amended in place so replaying this directory is idempotent and safe. Kept as plpgsql
-- (opaque to the planner, never inlined) so SECURITY DEFINER survives.
CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE result UUID;
  BEGIN
    SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;

-- ────────────────────────────────────────────────────────────
-- 1. debtors - the core queue/assignment table every agent and manager uses daily.
-- Agent: only debtors assigned to them. Manager: debtors assigned to their team, PLUS
-- debtors in portfolios they directly manage (portfolios.manager_id/team_id) so a manager can
-- still see and assign freshly-uploaded, not-yet-assigned debtors in their own portfolios.
-- ────────────────────────────────────────────────────────────
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
          OR portfolio_id IN (
            SELECT id FROM portfolios
            WHERE manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
               OR team_id IN (
                 SELECT id FROM teams
                 WHERE manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
               )
          )
        )
      )
    )
  );

-- ────────────────────────────────────────────────────────────
-- 2. messages, 3. payments - both have their own agent_id column, same shape as call_logs.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
    AND (
      auth_role() = 'admin'
      OR agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR (
        auth_role() = 'manager'
        AND agent_id IN (
          SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
      )
    )
  );

DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
    AND (
      auth_role() = 'admin'
      OR agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR (
        auth_role() = 'manager'
        AND agent_id IN (
          SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
      )
    )
  );

-- ────────────────────────────────────────────────────────────
-- 4. disputes - owned by whoever raised it (raised_by), same shape.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS disputes_select ON disputes;
CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
    AND (
      auth_role() = 'admin'
      OR raised_by = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR (
        auth_role() = 'manager'
        AND raised_by IN (
          SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
      )
    )
  );

-- ────────────────────────────────────────────────────────────
-- 5. settlement_requests - owned by whoever requested it (requested_by), same shape.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS settlements_select ON settlement_requests;
CREATE POLICY settlements_select ON settlement_requests FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
    AND (
      auth_role() = 'admin'
      OR requested_by = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR (
        auth_role() = 'manager'
        AND requested_by IN (
          SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
        )
      )
    )
  );

-- ────────────────────────────────────────────────────────────
-- 6. portfolios - already carries manager_id/team_id (added after schema.sql was written -
-- see 20260804/20260806 migrations), so scoping is direct rather than derived. Agent visibility
-- covers portfolios containing any debtor assigned to them, so their own queue/debtor-profile
-- pages can still show portfolio name/details.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS portfolios_select ON portfolios;
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      OR team_id IN (
        SELECT id FROM teams WHERE manager_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      )
      OR id IN (
        SELECT portfolio_id FROM debtors
        WHERE assigned_agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
      )
    )
  );

-- ────────────────────────────────────────────────────────────
-- 7. agents - the trickiest one, since it's self-referential (see auth_agent_id() above).
-- Agent: sees only their own row, PLUS the manager(s) of any team they're on (so notifications/
-- audit-trail "from"/"audited by" displays still resolve a name instead of breaking). Manager:
-- sees their own row plus their team's agents. Admin: full roster, unchanged.
-- ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR id = auth_agent_id()
      OR (
        auth_role() = 'manager'
        AND id IN (
          SELECT ta.agent_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
          WHERE t.manager_id = auth_agent_id()
        )
      )
      OR id IN (
        SELECT t.manager_id FROM team_agents ta JOIN teams t ON t.id = ta.team_id
        WHERE ta.agent_id = auth_agent_id()
      )
    )
  );
