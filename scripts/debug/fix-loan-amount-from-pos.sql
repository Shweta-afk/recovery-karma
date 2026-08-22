-- Repair debtors.loan_amount for uploads whose CSV mapping never bound the amount column.
--
-- NOT a migration: it is a one-off data fix for a specific bad upload, and lives here so it
-- is never replayed by a runner. Applies to the same client-side operation the UI already
-- offers (Portfolio Overview -> Edit -> Remap Fields, remapPortfolioFields in
-- portfolio-store.ts) — use that instead if you prefer; this is the bulk equivalent.
--
-- Symptom (live, 2026-08-22): Portfolio Overview read "Total Outstanding ₹0" and every
-- recovery percentage read 0.0%, because all 1,064 debtors on portfolio aug-axio had
-- loan_amount = 0. The real figure was never mapped and is still sitting untouched in
-- debtors.extra under the file's own header, "pos" (principal outstanding) — populated on all
-- 1,064 rows, summing to about ₹4.96 Cr.
--
-- Beware the near-duplicate headers in that file:
--     pos        -> what you want, rupees            e.g. "20180.1201171875"
--     ucic_pos   -> identical in the sampled rows, but not guaranteed to be
--     pos_cr     -> the same number in CRORES        e.g. "0.00201801201171874"
--     POS Split  -> a text band, not a number        e.g. "6.20K-25K"
--
-- outstanding_balance is set alongside loan_amount because the app always writes the two
-- equal (see the inserts in portfolio-store.ts) and never reads outstanding_balance back;
-- leaving them divergent would be a trap for whoever does read it next.

-- ── STEP 1: DRY RUN. Run this alone first and check the numbers. Changes nothing. ─────────
-- Confirm rows_to_update matches what you expect and new_total looks like the real book size
-- BEFORE running step 2.
SELECT
  p.name || ' · ' || left(p.id::text, 8)                                   AS portfolio,
  count(*)                                                                 AS debtors,
  count(*) FILTER (WHERE d.extra->>'pos' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$')  AS rows_to_update,
  count(*) FILTER (WHERE d.extra->>'pos' IS NULL)                          AS missing_pos,
  count(*) FILTER (WHERE coalesce(d.loan_amount, 0) <> 0)                  AS already_set,
  round(sum((d.extra->>'pos')::numeric)
        FILTER (WHERE d.extra->>'pos' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'))    AS new_total
FROM debtors d
JOIN portfolios p ON p.id = d.portfolio_id
WHERE d.extra->>'pos' IS NOT NULL
GROUP BY p.id, p.name
ORDER BY 1;

-- ── STEP 2: THE UPDATE. Run only after step 1 looks right. ────────────────────────────────
-- Guards, in order: only rows that actually carry a "pos" value; only values that are plainly
-- numeric (the regex rejects "6.20K-25K" and blanks, which would otherwise abort the whole
-- statement on a cast error); and only rows not already carrying an amount, so re-running is
-- a no-op and a correctly-mapped portfolio is never overwritten.
--
-- Scoped to every affected portfolio. To limit it to one, add:
--     AND portfolio_id = '<uuid>'
--
-- UPDATE debtors
-- SET loan_amount         = (extra->>'pos')::numeric,
--     outstanding_balance = (extra->>'pos')::numeric
-- WHERE extra->>'pos' ~ '^\s*-?[0-9]+(\.[0-9]+)?\s*$'
--   AND coalesce(loan_amount, 0) = 0;

-- ── STEP 3: VERIFY ────────────────────────────────────────────────────────────────────────
-- SELECT p.name, count(*) AS debtors, round(sum(d.loan_amount)) AS total_outstanding
-- FROM debtors d JOIN portfolios p ON p.id = d.portfolio_id
-- GROUP BY p.id, p.name ORDER BY 1;
--
-- Then hard-reload the app: loan_amount is cached in localStorage under
-- recoveryai_portfolios_cache and the page will keep showing ₹0 until that cache refreshes.
