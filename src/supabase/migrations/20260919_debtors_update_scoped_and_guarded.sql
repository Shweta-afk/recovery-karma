-- Stop any signed-in user from rewriting any debtor in their company.
--
-- ── The problem (found in the 2026-09-19 security review) ────────────────────────────────
-- debtors_update was:   USING (client_id = auth_client_id())  WITH CHECK (client_id = auth_client_id())
-- with no trigger on the table. Every role passed it, and the browser talks to Supabase
-- directly with the anon key, so any AGENT could reassign accounts, change balances / DPD /
-- status, or move debtors between portfolios — including debtors assigned to other agents.
--
-- ── The rule ─────────────────────────────────────────────────────────────────────────────
-- Row scope (the policy) — you may update a debtor only if you may already SEE it:
--   admin    every debtor in the company
--   manager  debtors in their portfolios / assigned to their team (auth_visible_debtor_ids)
--   agent    debtors assigned to them (auth_visible_debtor_ids resolves to exactly that)
--
-- Column scope (the trigger) — the policy alone cannot express "which columns":
--   agent    alt_phones ONLY (that is the one thing agents legitimately do — Add number in
--            the call queue; see addDebtorPhone in portfolio-store.ts)
--   manager/admin  anything, except client_id, which is immutable for everyone
--   service role / server jobs (auth.uid() IS NULL)  unrestricted, as before — ProfileX writes
--            discovered numbers to alt_phones that way.
--
-- Written to the RLS rules in CLAUDE.md: no policy reads an RLS-protected table directly (every
-- lookup goes through an existing SECURITY DEFINER plpgsql helper), and no BEGIN/COMMIT.

DROP POLICY IF EXISTS debtors_update ON debtors;

CREATE POLICY debtors_update ON debtors
  FOR UPDATE TO authenticated
  USING (
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR id IN (SELECT auth_visible_debtor_ids())
    )
  )
  WITH CHECK (
    -- Evaluated against the NEW row, so a manager cannot hand a debtor to an agent/portfolio
    -- outside their own scope, and an agent cannot reassign a debtor away from themselves.
    client_id = auth_client_id()
    AND (
      auth_role() = 'admin'
      OR (
        auth_role() = 'manager'
        AND (
          assigned_agent_id IN (SELECT auth_visible_agent_ids())
          OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
        )
      )
      OR (auth_role() = 'agent' AND assigned_agent_id = auth_agent_id())
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
    -- Compare every column except alt_phones. Doing it on the jsonb form means a column added
    -- to debtors later is protected automatically instead of silently writable by agents.
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

-- Trigger functions have no business being callable over /rest/v1/rpc.
REVOKE EXECUTE ON FUNCTION debtors_guard_columns() FROM PUBLIC, anon, authenticated;
