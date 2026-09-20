-- RLS hardening, round 2 (2026-09-19 security review). Follows 20260919_debtors_update_scoped_and_
-- guarded.sql. Nothing here touches calls or messaging tables — those wait for the next
-- telephony vendor.
--
-- 1. CROSS-TENANT LEAK: payments / disputes / settlement_requests SELECT allowed
--    `debtor_id IS NULL` and then the ADMIN branch, with no client scope — so any company's admin
--    could read every company's rows with a NULL debtor. None exist today (verified 0 rows), so
--    nothing has leaked; this closes it before one does. The app never writes a NULL-debtor row
--    to these three tables (disposition-store.ts skips ad-hoc calls; bulk paid files carry a
--    debtor), so NULL is now simply not allowed on INSERT and no longer matched on SELECT.
--
-- 2. ATTRIBUTION: inserts only checked the debtor's company, so any signed-in user could file a
--    payment / dispute / settlement in a colleague's name (or another company's agent id), which
--    pollutes the numbers incentives are computed from. The author column must now be the caller.
--    The one legitimate NULL author is the manager/admin bulk-paid file (payments.agent_id).
--
-- 3. Any dispute / settlement could be edited by anyone in the company; any manager could delete
--    any debtor. Scoped to what the caller can already see, the same rule as debtors_update.
--
-- 4. agents: a user could edit their OWN is_active / daily_target / agent_code (the policy allows
--    self-update for phone and profile). Only an admin may change those.
--
-- 5. SECURITY DEFINER / helper functions were executable by `anon` through /rest/v1/rpc, and five
--    had a mutable search_path. anon has no table grants so the exposure was small, but there is
--    no reason for it.
--
-- Written to the rules in CLAUDE.md: policies reach RLS-protected tables only through the existing
-- SECURITY DEFINER plpgsql helpers, and there is no BEGIN/COMMIT.

-- ── 1 + 2: payments ─────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments
  FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
      OR (agent_id IS NULL AND debtor_id IN (SELECT auth_visible_debtor_ids()))
    )
  );

DROP POLICY IF EXISTS payments_insert ON payments;
CREATE POLICY payments_insert ON payments
  FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      agent_id = auth_agent_id()
      OR (agent_id IS NULL AND auth_role() IN ('admin', 'manager'))
    )
  );

-- ── 1 + 2 + 3: disputes ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS disputes_select ON disputes;
CREATE POLICY disputes_select ON disputes
  FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      auth_role() = 'admin'
      OR raised_by = auth_agent_id()
      OR (auth_role() = 'manager' AND raised_by IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS disputes_insert ON disputes;
CREATE POLICY disputes_insert ON disputes
  FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND raised_by = auth_agent_id()
  );

DROP POLICY IF EXISTS disputes_update ON disputes;
CREATE POLICY disputes_update ON disputes
  FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      auth_role() = 'admin'
      OR raised_by = auth_agent_id()
      OR (auth_role() = 'manager' AND raised_by IN (SELECT auth_visible_agent_ids()))
    )
  )
  WITH CHECK (debtor_id IN (SELECT auth_client_debtor_ids()));

-- ── 1 + 2 + 3: settlement_requests ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS settlements_select ON settlement_requests;
CREATE POLICY settlements_select ON settlement_requests
  FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      auth_role() = 'admin'
      OR requested_by = auth_agent_id()
      OR (auth_role() = 'manager' AND requested_by IN (SELECT auth_visible_agent_ids()))
    )
  );

DROP POLICY IF EXISTS settlements_insert ON settlement_requests;
CREATE POLICY settlements_insert ON settlement_requests
  FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND requested_by = auth_agent_id()
  );

DROP POLICY IF EXISTS settlements_update ON settlement_requests;
CREATE POLICY settlements_update ON settlement_requests
  FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      auth_role() = 'admin'
      OR (auth_role() = 'manager' AND requested_by IN (SELECT auth_visible_agent_ids()))
    )
  )
  WITH CHECK (debtor_id IN (SELECT auth_client_debtor_ids()));

-- ── 3: debtors delete — same reach as update ────────────────────────────────────────────────
DROP POLICY IF EXISTS debtors_delete ON debtors;
CREATE POLICY debtors_delete ON debtors
  FOR DELETE TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (auth_role() = 'manager' AND id IN (SELECT auth_visible_debtor_ids()))
    )
  );

-- ── 4: agents — only an admin changes who is active, their target, or their code ─────────────
CREATE OR REPLACE FUNCTION agents_guard_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  BEGIN
    IF auth.uid() IS NULL THEN      -- service-role / server-side jobs
      RETURN NEW;
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role AND auth_role() <> 'admin' THEN
      RAISE EXCEPTION 'only an admin may change an agent role';
    END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
      RAISE EXCEPTION 'agent client_id is immutable';
    END IF;
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      RAISE EXCEPTION 'agent auth_user_id is immutable';
    END IF;
    IF auth_role() <> 'admin' AND (
         NEW.is_active IS DISTINCT FROM OLD.is_active
      OR NEW.daily_target IS DISTINCT FROM OLD.daily_target
      OR NEW.agent_code IS DISTINCT FROM OLD.agent_code
    ) THEN
      RAISE EXCEPTION 'only an admin may change is_active, daily_target or agent_code';
    END IF;
    RETURN NEW;
  END $function$;

-- ── 5: function grants + search_path ────────────────────────────────────────────────────────
-- New functions are granted to PUBLIC by default, and `anon` inherits PUBLIC — so revoking from
-- `anon` alone does nothing. Only functions anon can currently run are touched; the profilex_*
-- wallet functions are already service-role-only and are left exactly as they are.
DO $grants$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig, p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype) AS is_trigger
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND has_function_privilege('anon', p.oid, 'execute')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn.sig);
    IF fn.is_trigger THEN
      -- Trigger / event-trigger functions are never called through the API.
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    ELSE
      -- RLS helpers must stay callable by signed-in users: policies evaluate them as that role.
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
    END IF;
  END LOOP;
END
$grants$;

ALTER FUNCTION assign_agent_code() SET search_path = public, pg_temp;
ALTER FUNCTION next_agent_code(text) SET search_path = public, pg_temp;
ALTER FUNCTION clients_protect_admin_fields() SET search_path = public, pg_temp;
ALTER FUNCTION cleanup_ghost_live_calls() SET search_path = public, pg_temp;
ALTER FUNCTION portfolio_debtor_aggregates() SET search_path = public, pg_temp;
