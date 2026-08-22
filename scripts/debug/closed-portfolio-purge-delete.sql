-- ═══════════════════════════════════════════════════════════════════════════════
-- DESTRUCTIVE — permanently deletes every CLOSED portfolio and everything under it.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- There is no undo. Before running any of this:
--
--   1. Take a Supabase backup (Dashboard -> Database -> Backups). Not optional.
--   2. Run scripts/debug/closed-portfolio-purge-inventory.sql and READ IT. In particular
--      `also_in_open_pf`: where that equals `debtors`, the closed portfolio is a duplicate
--      re-upload and losing it costs nothing. Where it is lower, those rows are accounts that
--      were never carried forward, and `paid_value` is real money you are erasing the record
--      of. STEP 0 below refuses to proceed if anything looks load-bearing.
--
-- Why this is not a one-line DELETE: schema.sql declares every debtor FK WITHOUT
-- ON DELETE CASCADE --
--     call_logs.debtor_id, messages.debtor_id, payments.debtor_id,
--     disputes.debtor_id, settlement_requests.debtor_id  ->  debtors(id)
--     debtors.portfolio_id                               ->  portfolios(id)
-- so children must go first or the delete simply errors. Two references also point INTO the
-- doomed set from rows that SURVIVE, and must be unlinked first:
--     portfolios.replaces_portfolio_id   (an open cycle pointing back at the closed one)
--     debtors.retained_from_portfolio_id (a carried-forward debtor's origin)
-- Both are the retention chain: unlinking loses the "this account continued from that cycle"
-- provenance. That is unavoidable if the old cycle is deleted, and is a reason to reconsider.
--
-- HOW TO RUN: paste STEP 0 alone first. If it clears, paste STEPS 1-8 together and run them
-- as a SINGLE execution — the Supabase SQL Editor wraps one execution in one transaction, so
-- either all of it lands or none of it does. Do NOT add your own BEGIN/COMMIT: a nested
-- transaction has silently rolled work back in this project before (see CLAUDE.md).

-- ── STEP 0: safety check. Run alone. Proceed only if it returns "SAFE TO PROCEED". ────────
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- STEPS 1-8 — paste together, run once. Everything below is commented out on purpose;
-- uncomment the whole block only after STEP 0 and a backup.
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- -- STEP 1: unlink survivors that point INTO the doomed set (must precede the deletes).
-- UPDATE portfolios SET replaces_portfolio_id = NULL
--  WHERE replaces_portfolio_id IN (SELECT id FROM portfolios WHERE closed_at IS NOT NULL);
--
-- UPDATE debtors SET retained_from_portfolio_id = NULL
--  WHERE retained_from_portfolio_id IN (SELECT id FROM portfolios WHERE closed_at IS NOT NULL);
--
-- -- STEP 2: retention_requests, only if that migration was ever applied here. The DO block
-- -- keeps this parse-safe on a database where the table does not exist — naming a missing
-- -- table directly would abort the whole script before anything ran.
-- DO $$
-- BEGIN
--   IF to_regclass('public.retention_requests') IS NOT NULL THEN
--     DELETE FROM retention_requests WHERE debtor_id IN (
--       SELECT id FROM debtors WHERE portfolio_id IN
--         (SELECT id FROM portfolios WHERE closed_at IS NOT NULL));
--   END IF;
-- END $$;
--
-- -- STEPS 3-7: children of debtors, in any order among themselves, but all before STEP 8.
-- DELETE FROM call_logs WHERE debtor_id IN (
--   SELECT id FROM debtors WHERE portfolio_id IN
--     (SELECT id FROM portfolios WHERE closed_at IS NOT NULL));
--
-- DELETE FROM messages WHERE debtor_id IN (
--   SELECT id FROM debtors WHERE portfolio_id IN
--     (SELECT id FROM portfolios WHERE closed_at IS NOT NULL));
--
-- DELETE FROM payments WHERE debtor_id IN (
--   SELECT id FROM debtors WHERE portfolio_id IN
--     (SELECT id FROM portfolios WHERE closed_at IS NOT NULL));
--
-- DELETE FROM disputes WHERE debtor_id IN (
--   SELECT id FROM debtors WHERE portfolio_id IN
--     (SELECT id FROM portfolios WHERE closed_at IS NOT NULL));
--
-- DELETE FROM settlement_requests WHERE debtor_id IN (
--   SELECT id FROM debtors WHERE portfolio_id IN
--     (SELECT id FROM portfolios WHERE closed_at IS NOT NULL));
--
-- -- STEP 8: the debtors, then the portfolios themselves. portfolio_agent_targets declares
-- -- ON DELETE CASCADE on portfolio_id, so it clears itself.
-- DELETE FROM debtors WHERE portfolio_id IN
--   (SELECT id FROM portfolios WHERE closed_at IS NOT NULL);
--
-- DELETE FROM portfolios WHERE closed_at IS NOT NULL;

-- ── AFTER: verify, then hard-reload the app ──────────────────────────────────────────────
-- SELECT
--   (SELECT count(*) FROM portfolios WHERE closed_at IS NOT NULL) AS closed_remaining,
--   (SELECT count(*) FROM portfolios) AS portfolios,
--   (SELECT count(*) FROM debtors)    AS debtors,
--   (SELECT count(*) FROM payments)   AS payments;
--
-- Every client caches debtors in localStorage (recoveryai_portfolios_cache), so the app keeps
-- showing deleted accounts until each open tab hard-reloads.
