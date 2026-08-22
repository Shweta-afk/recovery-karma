-- ═══════════════════════════════════════════════════════════════════════════════
-- DESTRUCTIVE — permanently deletes every CLOSED portfolio and everything under it.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- There is no undo. Before running STEP B:
--   1. Take a Supabase backup (Dashboard -> Database -> Backups). Not optional.
--   2. Run closed-portfolio-purge-inventory.sql, then closed-portfolio-migrate-then-purge.sql,
--      then STEP 0 here. Proceed only on "SAFE TO PROCEED".
--
-- Why this discovers its dependants instead of listing them:
--
-- An earlier draft hand-listed five children of `debtors` (call_logs, messages, payments,
-- disputes, settlement_requests). The app actually writes at least four more — escalations,
-- ptp_escalations, reminders, retention_requests — and `escalations` has no migration in this
-- repo at all, so its columns cannot be known from source. schema.sql declares none of these
-- FKs as ON DELETE CASCADE, so a single missed table aborts the whole run.
--
-- STEP B therefore reads pg_constraint for every foreign key pointing at debtors and at
-- portfolios and handles whatever it finds, including tables added after this was written.
-- A nullable reference INTO the doomed set is nulled (that is the retention provenance —
-- "this account continued from that cycle" — which is unavoidably lost); a NOT NULL one is
-- deleted, because such a row cannot survive its parent.
--
-- No BEGIN/COMMIT: the SQL Editor wraps one execution in one transaction, and a nested one
-- has silently rolled work back in this project before (see CLAUDE.md).

-- ── STEP 0: safety check. Run alone. Proceed only on "SAFE TO PROCEED". ───────────────────
SELECT
  CASE
    WHEN unique_accounts = 0 AND paid_value = 0
      THEN 'SAFE TO PROCEED — closed portfolios are pure duplicates, no payment history'
    ELSE 'STOP AND READ — ' || unique_accounts || ' accounts exist ONLY in closed portfolios, '
         || 'and ₹' || paid_value || ' of completed payments would be destroyed'
  END AS verdict,
  closed_portfolios, total_debtors, unique_accounts, call_logs, payments, paid_value
FROM (
  SELECT
    (SELECT count(*) FROM portfolios WHERE closed_at IS NOT NULL) AS closed_portfolios,
    (SELECT count(*) FROM debtors WHERE portfolio_id IN
       (SELECT id FROM portfolios WHERE closed_at IS NOT NULL)) AS total_debtors,
    (SELECT count(*) FROM debtors d WHERE d.portfolio_id IN
       (SELECT id FROM portfolios WHERE closed_at IS NOT NULL)
       AND lower(trim(d.loan_reference)) NOT IN (
         SELECT lower(trim(loan_reference)) FROM debtors
         WHERE portfolio_id IN (SELECT id FROM portfolios WHERE closed_at IS NULL)
           AND loan_reference IS NOT NULL)) AS unique_accounts,
    (SELECT count(*) FROM call_logs WHERE debtor_id IN
       (SELECT id FROM debtors WHERE portfolio_id IN
          (SELECT id FROM portfolios WHERE closed_at IS NOT NULL))) AS call_logs,
    (SELECT count(*) FROM payments WHERE debtor_id IN
       (SELECT id FROM debtors WHERE portfolio_id IN
          (SELECT id FROM portfolios WHERE closed_at IS NOT NULL))) AS payments,
    COALESCE((SELECT sum(amount) FROM payments WHERE status = 'completed' AND debtor_id IN
       (SELECT id FROM debtors WHERE portfolio_id IN
          (SELECT id FROM portfolios WHERE closed_at IS NOT NULL))), 0) AS paid_value
) x;

-- ── STEP A: DRY RUN. Read-only. Every table that will be touched, and by how much. ────────
-- Run this before STEP B and read it. Anything surprising here is a reason to stop.
WITH doomed_pf AS (SELECT id FROM portfolios WHERE closed_at IS NOT NULL),
     doomed_d  AS (SELECT id FROM debtors WHERE portfolio_id IN (SELECT id FROM doomed_pf)),
     fks AS (
       SELECT con.conrelid::regclass::text AS child_table,
              att.attname                  AS child_col,
              con.confrelid::regclass::text AS parent_table,
              att.attnotnull               AS col_not_null
       FROM pg_constraint con
       JOIN pg_attribute att
         ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
       WHERE con.contype = 'f'
         AND con.confrelid IN ('public.debtors'::regclass, 'public.portfolios'::regclass)
     )
SELECT f.parent_table || ' <- ' || f.child_table || '.' || f.child_col AS reference,
       CASE WHEN f.parent_table = 'debtors' THEN 'DELETE rows'
            WHEN f.child_table = 'debtors' AND f.child_col = 'portfolio_id' THEN 'DELETE rows'
            WHEN f.col_not_null THEN 'DELETE rows'
            ELSE 'SET NULL' END AS action,
       (SELECT count(*) FROM doomed_d)  AS doomed_debtors,
       (SELECT count(*) FROM doomed_pf) AS doomed_portfolios
FROM fks f
ORDER BY 1;

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEP B — the delete. Uncomment the whole block, paste it alone, run once.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- DO $$
-- DECLARE
--   r        RECORD;
--   n        BIGINT;
--   affected TEXT := '';
-- BEGIN
--   -- Materialised once: the sets must not shift as rows are deleted underneath them.
--   DROP TABLE IF EXISTS _doomed_pf;
--   DROP TABLE IF EXISTS _doomed_d;
--   CREATE TEMP TABLE _doomed_pf ON COMMIT DROP AS
--     SELECT id FROM portfolios WHERE closed_at IS NOT NULL;
--   CREATE TEMP TABLE _doomed_d ON COMMIT DROP AS
--     SELECT id FROM debtors WHERE portfolio_id IN (SELECT id FROM _doomed_pf);
--
--   -- 1. Every child of portfolios EXCEPT debtors: null the reference if it is optional,
--   --    delete the row if the FK is mandatory. Runs first so nothing points at a portfolio
--   --    that is about to disappear.
--   FOR r IN
--     SELECT con.conrelid::regclass::text AS tbl, att.attname AS col, att.attnotnull AS req
--     FROM pg_constraint con
--     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
--     WHERE con.contype = 'f' AND con.confrelid = 'public.portfolios'::regclass
--       AND NOT (con.conrelid = 'public.debtors'::regclass AND att.attname = 'portfolio_id')
--   LOOP
--     IF r.req THEN
--       EXECUTE format('DELETE FROM %s WHERE %I IN (SELECT id FROM _doomed_pf)', r.tbl, r.col);
--     ELSE
--       EXECUTE format('UPDATE %s SET %I = NULL WHERE %I IN (SELECT id FROM _doomed_pf)',
--                      r.tbl, r.col, r.col);
--     END IF;
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n > 0 THEN affected := affected || format('%s.%s: %s; ', r.tbl, r.col, n); END IF;
--   END LOOP;
--
--   -- 2. Every child of debtors, discovered rather than listed — this is where the
--   --    hand-written version missed escalations, reminders and ptp_escalations.
--   FOR r IN
--     SELECT con.conrelid::regclass::text AS tbl, att.attname AS col
--     FROM pg_constraint con
--     JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
--     WHERE con.contype = 'f' AND con.confrelid = 'public.debtors'::regclass
--   LOOP
--     EXECUTE format('DELETE FROM %s WHERE %I IN (SELECT id FROM _doomed_d)', r.tbl, r.col);
--     GET DIAGNOSTICS n = ROW_COUNT;
--     IF n > 0 THEN affected := affected || format('%s.%s: %s; ', r.tbl, r.col, n); END IF;
--   END LOOP;
--
--   -- 3. The debtors, then the portfolios.
--   DELETE FROM debtors WHERE id IN (SELECT id FROM _doomed_d);
--   GET DIAGNOSTICS n = ROW_COUNT;
--   affected := affected || format('debtors: %s; ', n);
--
--   DELETE FROM portfolios WHERE id IN (SELECT id FROM _doomed_pf);
--   GET DIAGNOSTICS n = ROW_COUNT;
--   affected := affected || format('portfolios: %s', n);
--
--   RAISE NOTICE 'purged -> %', affected;
-- END $$;

-- ── AFTER: verify, then hard-reload every open tab ───────────────────────────────────────
-- SELECT
--   (SELECT count(*) FROM portfolios WHERE closed_at IS NOT NULL) AS closed_remaining,
--   (SELECT count(*) FROM portfolios) AS portfolios,
--   (SELECT count(*) FROM debtors)    AS debtors,
--   (SELECT count(*) FROM payments)   AS payments;
--
-- closed_remaining must be 0. Clients cache debtors in localStorage
-- (recoveryai_portfolios_cache), so the app keeps showing deleted accounts until each open
-- tab reloads.
