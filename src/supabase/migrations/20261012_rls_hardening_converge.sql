-- Put 20260919_debtors_update_scoped_and_guarded.sql and 20260920_rls_hardening_round2.sql live.
--
-- Found 2026-10-11: neither file had ever reached production. Live still had
--   debtors_update  USING/CHECK (client_id = auth_client_id())       -- any user, any debtor
--   debtors_delete  any manager, any debtor in the company
--   no debtors_guard_columns trigger                                 -- agents could rewrite any column
--   payments/disputes/settlements insert: `debtor_id IS NULL OR ...` and no author check
--   disputes/settlements update: read `debtors` inline (the pattern CLAUDE.md bans)
--   payments_select: `debtor_id IS NULL OR ...` then the admin branch — cross-company for NULL rows
--   agents_guard_privileged_columns without the is_active / daily_target / agent_code check
--   27 public functions executable by `anon`
-- This file re-asserts the end state both files intended, so a replay converges here. The rules
-- and their reasons are in those two files; what differs from them:
--
--   * debtors_update / debtors_delete USING mirror debtors_select (admin; the assigned agent; a
--     manager's agents or portfolios) instead of `id IN auth_visible_debtor_ids()`. That helper
--     is not the same set: for an agent it is every debtor in any portfolio they hold one debtor
--     in, for a manager it misses team agents' debtors in a portfolio outside the manager's own.
--     Update reach is now exactly read reach.
--   * Scalar helpers are wrapped as (SELECT auth_role()) etc., the 2026-10-11 initplan pattern.
--   * The search_path ALTERs from round 2 are left out — 20261011_function_search_path.sql did
--     them (live has no public function with a mutable search_path).
--
-- What the app does that this must keep working (audited 2026-10-11):
--   agent    addDebtorPhone (alt_phones only, own debtor); payments insert from a "paid"
--            disposition with agent_id = the caller (saveDisposition resolves the signed-in user)
--   manager  upload/merge/remap/assign/transfer/remove/restore/bulk-paid on their portfolios;
--            bulk-paid payments carry agent_id NULL
--   admin    the same, company-wide (Admin → Portfolio is read-only); Admin → Users edits agents
--   server   every service-role write (ProfileX alt_phones writeback, archive, sessions) has
--            auth.uid() NULL and skips both guards
-- Nothing in the app writes disputes or settlement_requests yet (0 rows of each).
--
-- Written to the RLS rules in CLAUDE.md: policies reach RLS-protected tables only through the
-- plpgsql SECURITY DEFINER helpers, no BEGIN/COMMIT. Idempotent.

-- ── debtors ──────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS debtors_update ON debtors;
CREATE POLICY debtors_update ON debtors FOR UPDATE TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR assigned_agent_id = (SELECT auth_agent_id())
      OR (
        (SELECT auth_role()) = 'manager'
        AND (
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  )
  WITH CHECK (
    -- Against the NEW row: a manager cannot hand a debtor outside their own agents/portfolios,
    -- an agent cannot reassign a debtor away from themselves.
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR (
        (SELECT auth_role()) = 'manager'
        AND (
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
      OR ((SELECT auth_role()) = 'agent' AND assigned_agent_id = (SELECT auth_agent_id()))
    )
  );

DROP POLICY IF EXISTS debtors_delete ON debtors;
CREATE POLICY debtors_delete ON debtors FOR DELETE TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND (
      (SELECT auth_role()) = 'admin'
      OR (
        (SELECT auth_role()) = 'manager'
        AND (
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION debtors_guard_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN      -- service-role / server-side jobs
    RETURN NEW;
  END IF;

  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    RAISE EXCEPTION 'debtor client_id is immutable';
  END IF;

  IF auth_role() = 'agent' THEN
    -- Every column except alt_phones, compared as jsonb so a column added later is protected
    -- automatically instead of silently writable by agents.
    IF (to_jsonb(NEW) - 'alt_phones') IS DISTINCT FROM (to_jsonb(OLD) - 'alt_phones') THEN
      RAISE EXCEPTION 'agents may only add alternate phone numbers to a debtor';
    END IF;
  END IF;

  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS debtors_guard_columns_trg ON debtors;
CREATE TRIGGER debtors_guard_columns_trg
  BEFORE UPDATE ON debtors
  FOR EACH ROW EXECUTE FUNCTION debtors_guard_columns();

REVOKE ALL ON FUNCTION debtors_guard_columns() FROM PUBLIC, anon, authenticated;

-- ── payments ─────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      (SELECT auth_role()) = 'admin'
      OR agent_id = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
      OR (agent_id IS NULL AND debtor_id IN (SELECT auth_visible_debtor_ids()))
    )
  );

DROP POLICY IF EXISTS payments_insert ON payments;
CREATE POLICY payments_insert ON payments FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      agent_id = (SELECT auth_agent_id())
      -- The bank paid-file upload: no agent to credit.
      OR (agent_id IS NULL AND (SELECT auth_role()) IN ('admin', 'manager'))
    )
  );

-- ── disputes ─────────────────────────────────────────────────────────────────────────────────
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

DROP POLICY IF EXISTS disputes_insert ON disputes;
CREATE POLICY disputes_insert ON disputes FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND raised_by = (SELECT auth_agent_id())
  );

DROP POLICY IF EXISTS disputes_update ON disputes;
CREATE POLICY disputes_update ON disputes FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      (SELECT auth_role()) = 'admin'
      OR raised_by = (SELECT auth_agent_id())
      OR ((SELECT auth_role()) = 'manager' AND raised_by IN (SELECT auth_visible_agent_ids()))
    )
  )
  WITH CHECK (debtor_id IN (SELECT auth_client_debtor_ids()));

-- ── settlement_requests ──────────────────────────────────────────────────────────────────────
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

DROP POLICY IF EXISTS settlements_insert ON settlement_requests;
CREATE POLICY settlements_insert ON settlement_requests FOR INSERT TO authenticated
  WITH CHECK (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND requested_by = (SELECT auth_agent_id())
  );

DROP POLICY IF EXISTS settlements_update ON settlement_requests;
CREATE POLICY settlements_update ON settlement_requests FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT auth_client_debtor_ids())
    AND (
      (SELECT auth_role()) = 'admin'
      OR ((SELECT auth_role()) = 'manager' AND requested_by IN (SELECT auth_visible_agent_ids()))
    )
  )
  WITH CHECK (debtor_id IN (SELECT auth_client_debtor_ids()));

-- ── agents: only an admin changes who is active, their target, or their code ─────────────────
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
    IF auth_role() IS DISTINCT FROM 'admin' AND (
         NEW.is_active IS DISTINCT FROM OLD.is_active
      OR NEW.daily_target IS DISTINCT FROM OLD.daily_target
      OR NEW.agent_code IS DISTINCT FROM OLD.agent_code
    ) THEN
      RAISE EXCEPTION 'only an admin may change is_active, daily_target or agent_code';
    END IF;
    RETURN NEW;
  END $function$;

-- ── function grants ──────────────────────────────────────────────────────────────────────────
-- New functions are granted to PUBLIC by default and `anon` inherits PUBLIC, so revoking from
-- anon alone does nothing. Only functions anon can currently run are touched. Trigger functions
-- are never called through the API (and EXECUTE is not checked when a trigger fires); RLS helpers
-- must stay callable by `authenticated`, since policies evaluate them as that role.
DO $grants$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig,
           p.prorettype IN ('trigger'::regtype, 'event_trigger'::regtype) AS is_trigger
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND has_function_privilege('anon', p.oid, 'execute')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn.sig);
    IF fn.is_trigger THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    ELSE
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn.sig);
    END IF;
  END LOOP;
END
$grants$;
