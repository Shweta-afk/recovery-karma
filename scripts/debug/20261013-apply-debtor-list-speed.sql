-- Staged, low-impact way to put src/supabase/migrations/20261013_debtor_list_speed.sql live.
-- Run each STEP separately in the Supabase SQL Editor, in order. Every step is short; none locks
-- the debtors table for more than a moment. The end state is exactly the migration file's, so a
-- later replay of that file is a no-op.

-- ═══ STEP 1 — access rules: helpers evaluated once per query (instant) ═══════════════════════
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

-- ═══ STEP 2 — staging columns + sync trigger (instant) ═══════════════════════════════════════
-- Temporary names: the old extra_named()/extra_head() functions keep serving the app until STEP 4.
CREATE OR REPLACE FUNCTION public.debtor_extra_named(extra jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(CASE WHEN jsonb_typeof(extra) = 'object' THEN extra ELSE '{}'::jsonb END) AS e
      WHERE e.key = ANY (ARRAY['address', 'city', 'state', 'dob', 'employer', 'income', 'language',
                               'pos', 'Principal'])),
    '{}'::jsonb)
$$;
CREATE OR REPLACE FUNCTION public.debtor_extra_head(extra jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = public, pg_temp
AS $$
  SELECT coalesce(
    (SELECT jsonb_object_agg(e.key, e.value)
       FROM jsonb_each(CASE WHEN jsonb_typeof(extra) = 'object' THEN extra ELSE '{}'::jsonb END)
            WITH ORDINALITY AS e(key, value, n)
      WHERE e.n <= 25),
    '{}'::jsonb)
$$;
REVOKE EXECUTE ON FUNCTION public.debtor_extra_named(jsonb) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.debtor_extra_head(jsonb) FROM PUBLIC, anon;

ALTER TABLE debtors ADD COLUMN IF NOT EXISTS extra_named_s jsonb;
ALTER TABLE debtors ADD COLUMN IF NOT EXISTS extra_head_s jsonb;

CREATE OR REPLACE FUNCTION public.debtors_extra_sync()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.extra IS DISTINCT FROM OLD.extra THEN
    NEW.extra_named_s := public.debtor_extra_named(NEW.extra);
    NEW.extra_head_s := public.debtor_extra_head(NEW.extra);
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.debtors_extra_sync() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS debtors_extra_sync_trg ON debtors;
CREATE TRIGGER debtors_extra_sync_trg
  BEFORE INSERT OR UPDATE ON debtors
  FOR EACH ROW EXECUTE FUNCTION public.debtors_extra_sync();

-- ═══ STEP 3 — fill existing rows, 10,000 at a time (~a few seconds each) ════════════════════
-- Run this repeatedly until the result says 0 rows (about 8 runs for 74k debtors).
UPDATE debtors
   SET extra_named_s = public.debtor_extra_named(extra),
       extra_head_s = public.debtor_extra_head(extra)
 WHERE id IN (SELECT id FROM debtors WHERE extra_named_s IS NULL OR extra_head_s IS NULL LIMIT 10000);

-- Check before STEP 4 — must return 0:
SELECT count(*) AS still_empty FROM debtors WHERE extra_named_s IS NULL OR extra_head_s IS NULL;

-- ═══ STEP 4 — swap to the final names (instant) ═════════════════════════════════════════════
-- Catches any row added between STEP 3 and now, then switches the app over to the stored columns.
UPDATE debtors
   SET extra_named_s = public.debtor_extra_named(extra),
       extra_head_s = public.debtor_extra_head(extra)
 WHERE extra_named_s IS NULL OR extra_head_s IS NULL;
DROP FUNCTION IF EXISTS public.extra_named(public.debtors);
DROP FUNCTION IF EXISTS public.extra_head(public.debtors);
ALTER TABLE debtors RENAME COLUMN extra_named_s TO extra_named;
ALTER TABLE debtors RENAME COLUMN extra_head_s TO extra_head;
CREATE OR REPLACE FUNCTION public.debtors_extra_sync()
RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp
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
NOTIFY pgrst, 'reload schema';

-- ═══ CHECK — should be 0 mismatches ══════════════════════════════════════════════════════════
SELECT count(*) FILTER (WHERE extra_named IS DISTINCT FROM public.debtor_extra_named(extra)
                           OR extra_head IS DISTINCT FROM public.debtor_extra_head(extra)) AS mismatches,
       count(*) AS debtors
  FROM debtors;
