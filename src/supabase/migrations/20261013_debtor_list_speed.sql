-- Make the debtor list queries (Call Queue, Debtors page, refreshScopedPortfolios) cheaper at
-- the database. Two independent changes; neither changes what any role can see.
--
-- Measured live 2026-10-13 (74,407 debtors), 1,000 rows of one agent's 5,086-row book:
--   bare index scan 1.6 ms · + extra_named(d)/extra_head(d) ~146 ms · + RLS as that agent ~500 ms.
--
-- ── 1. RLS initplan for the list tables ─────────────────────────────────────────────────────
-- debtors_select, portfolios_select, agents_select and teams_select still called the scalar
-- helpers bare: auth_client_id(), auth_role(), auth_agent_id(). They are STABLE, which Postgres
-- still evaluates once per ROW — each a plpgsql SECURITY DEFINER call that reads `agents`
-- (auth_role() also parses the JWT's amr). Wrapped as (SELECT auth_role()) each becomes an
-- initplan run once per query, the 2026-10-11 pattern (20261011_rls_policies_converge_and_initplan.sql).
-- A STABLE function returns the same value for every row of one statement, so the wrapped
-- policy admits exactly the same rows. The set-returning helpers (auth_visible_*_ids) were
-- already hashed subplans run once per query and are unchanged.
--
-- auth_visible_debtor_ids() "mirrors debtors_select" (20260827): its meaning is untouched here,
-- since debtors_select's meaning is untouched — only how the predicate is evaluated changes.
--
-- Written to the RLS rules in CLAUDE.md: no policy reads an RLS-protected table directly (only
-- the plpgsql SECURITY DEFINER helpers), helpers are not redefined, no BEGIN/COMMIT. Sorts
-- after every file that defines these four policies, so a full replay ends here.
--
-- ── 2. extra_named / extra_head become stored columns ───────────────────────────────────────
-- They were computed columns (functions of the row, 20260923_debtors_extra_preview.sql): every
-- list fetch ran jsonb_each over the ~88-key `extra` bag twice per row — including rows skipped
-- by OFFSET. 20261011_function_search_path.sql's SET clause also rules out inlining them.
-- Now they are real columns of the same name, so the client's `select=...,extra_named,extra_head`
-- is unchanged, and debtor-extra.ts's fallback to plain `extra` still covers a database that
-- lacks them. Kept in sync by debtors_extra_sync_trg on every write of `extra`:
--   * INSERT: always computed from NEW.extra.
--   * UPDATE: recomputed when `extra` changes, or when someone writes either column directly
--     (so neither can be forged — they always equal what `extra` implies). An update that
--     touches neither (status, assignment, alt_phones...) skips the JSON work entirely.
-- The trigger sorts before debtors_guard_columns_trg, and for an agent's alt_phones-only update
-- it changes nothing, so the guard's whole-row comparison still passes.
--
-- The two functions are dropped: Postgres refuses a one-argument function of a table's row type
-- named like one of its columns ("is already an attribute of type debtors"), and PostgREST must
-- see the column. 20260923_debtors_extra_preview.sql and 20261011_function_search_path.sql were
-- amended to skip the functions once these columns exist, so a replay converges here.
--
-- The backfill rewrites every debtor row once (~74k rows, ~140 MB). Apply off-hours.
-- Idempotent.

-- ── 1. RLS ───────────────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS debtors_select ON debtors;
CREATE POLICY debtors_select ON debtors FOR SELECT TO authenticated
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
  );

DROP POLICY IF EXISTS portfolios_select ON portfolios;
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND ((SELECT auth_role()) = 'admin' OR id IN (SELECT auth_visible_portfolio_ids()))
  );

DROP POLICY IF EXISTS agents_select ON agents;
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND ((SELECT auth_role()) = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
  );

DROP POLICY IF EXISTS teams_select ON teams;
CREATE POLICY teams_select ON teams FOR SELECT TO authenticated
  USING (
    client_id = (SELECT auth_client_id())
    AND ((SELECT auth_role()) = 'admin' OR id IN (SELECT auth_visible_team_ids()))
  );

-- ── 2. Stored slim views of `extra` ──────────────────────────────────────────────────────────
-- Same bodies as the computed columns they replace, taking the jsonb instead of the row.
CREATE OR REPLACE FUNCTION public.debtor_extra_named(extra jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(CASE WHEN jsonb_typeof(extra) = 'object' THEN extra ELSE '{}'::jsonb END) AS e
      WHERE e.key = ANY (ARRAY['address', 'city', 'state', 'dob', 'employer', 'income', 'language',
                               'pos', 'Principal'])),
    '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.debtor_extra_head(extra jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(CASE WHEN jsonb_typeof(extra) = 'object' THEN extra ELSE '{}'::jsonb END)
            WITH ORDINALITY AS e(key, value, n)
      WHERE e.n <= 25),
    '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION public.debtors_extra_sync()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.extra IS DISTINCT FROM OLD.extra
     OR NEW.extra_named IS DISTINCT FROM OLD.extra_named
     OR NEW.extra_head IS DISTINCT FROM OLD.extra_head THEN
    NEW.extra_named := public.debtor_extra_named(NEW.extra);
    NEW.extra_head := public.debtor_extra_head(NEW.extra);
  END IF;
  RETURN NEW;
END $$;

REVOKE EXECUTE ON FUNCTION public.debtors_extra_sync() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.debtor_extra_named(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.debtor_extra_head(jsonb) FROM PUBLIC, anon;

DROP FUNCTION IF EXISTS public.extra_named(public.debtors);
DROP FUNCTION IF EXISTS public.extra_head(public.debtors);

ALTER TABLE debtors ADD COLUMN IF NOT EXISTS extra_named jsonb;
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS extra_head jsonb;

-- Before the trigger exists, so the backfill pays for one computation per row, not two.
-- Server-side (auth.uid() NULL): debtors_guard_columns_trg passes it straight through.
UPDATE debtors
   SET extra_named = public.debtor_extra_named(extra),
       extra_head = public.debtor_extra_head(extra)
 WHERE extra_named IS NULL OR extra_head IS NULL;

DROP TRIGGER IF EXISTS debtors_extra_sync_trg ON debtors;
CREATE TRIGGER debtors_extra_sync_trg
  BEFORE INSERT OR UPDATE ON debtors
  FOR EACH ROW EXECUTE FUNCTION public.debtors_extra_sync();

NOTIFY pgrst, 'reload schema';
