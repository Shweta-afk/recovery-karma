-- Why a paid-file upload's portal total is lower than the spreadsheet's.
--
-- Reported 2026-08-22: an RBL file totalling ₹120,984 showed ₹116,484 — ₹4,500 missing.
--
-- applyBulkPaidFile() skips a row in three cases, and until now reported only row COUNTS for
-- them, never amounts, so every skip was silent:
--
--   1. ALREADY PAID   The debtor's status is already 'paid', so the row is skipped whole.
--                     That protects against double-counting a re-uploaded file — but it also
--                     drops a genuinely NEW payment the bank reports against an account that
--                     was already settled (a second instalment, a top-up). This is the most
--                     likely cause of a missing few thousand.
--   2. NOT FOUND      The loan id isn't in that portfolio. Common when a file spans lenders,
--                     or the wrong portfolio was selected in the dialog.
--   3. NO AMOUNT      Blank, ₹0 or unparseable amount cell. Since b3d6c73 the account is
--                     still marked paid but no payments row is written, so the amount is
--                     absent from every total. Before that it was written as ₹0 — equally
--                     wrong, but it kept the row COUNT matching, which is why this only
--                     became visible as a money gap recently.
--
-- The upload dialog now shows this reconciliation live. These queries are for the uploads
-- already done. Read-only.

-- ── Q1: accounts marked paid that have NO payment attached. ───────────────────────────────
-- These are exactly the silently-dropped ones — case 1 or 3 above. The count per portfolio is
-- the size of the hole; the sample shows which accounts to check against the spreadsheet.
SELECT p.name || ' · ' || left(p.id::text, 8)                  AS portfolio,
       count(*)                                                AS paid_with_no_payment,
       min(d.loan_reference)                                   AS sample_loan_ref,
       count(*) FILTER (WHERE d.status = 'paid')               AS still_marked_paid
FROM debtors d
JOIN portfolios p ON p.id = d.portfolio_id
WHERE d.status = 'paid'
  AND NOT EXISTS (SELECT 1 FROM payments pay WHERE pay.debtor_id = d.id)
GROUP BY p.id, p.name
ORDER BY 2 DESC;

-- ── Q2: what each portfolio actually recorded, split by how it arrived. ───────────────────
-- Compare bank_reported against your spreadsheet totals. `source` needs
-- migrations/20260811_payments_source.sql; if that column is missing this errors and Q3 is
-- the fallback.
-- SELECT p.name || ' · ' || left(p.id::text, 8) AS portfolio,
--        count(*) FILTER (WHERE pay.source = 'bank_reported')          AS bank_rows,
--        COALESCE(sum(pay.amount) FILTER (WHERE pay.source = 'bank_reported'), 0) AS bank_total,
--        count(*) FILTER (WHERE pay.source <> 'bank_reported')         AS agent_rows,
--        COALESCE(sum(pay.amount) FILTER (WHERE pay.source <> 'bank_reported'), 0) AS agent_total
-- FROM payments pay
-- JOIN debtors d    ON d.id = pay.debtor_id
-- JOIN portfolios p ON p.id = d.portfolio_id
-- WHERE pay.status = 'completed'
-- GROUP BY p.id, p.name ORDER BY 1;

-- ── Q3: same split without the `source` column — unattributed = bank-reported. ────────────
-- SELECT p.name || ' · ' || left(p.id::text, 8) AS portfolio,
--        count(*) FILTER (WHERE pay.agent_id IS NULL)          AS bank_rows,
--        COALESCE(sum(pay.amount) FILTER (WHERE pay.agent_id IS NULL), 0) AS bank_total,
--        count(*) FILTER (WHERE pay.agent_id IS NOT NULL)      AS collected_rows,
--        COALESCE(sum(pay.amount) FILTER (WHERE pay.agent_id IS NOT NULL), 0) AS collected_total
-- FROM payments pay
-- JOIN debtors d    ON d.id = pay.debtor_id
-- JOIN portfolios p ON p.id = d.portfolio_id
-- WHERE pay.status = 'completed'
-- GROUP BY p.id, p.name ORDER BY 1;

-- ── Recovering a specific missing amount ──────────────────────────────────────────────────
-- Once Q1 identifies the accounts, take the loan ids whose amounts are missing, put JUST
-- those rows in a small CSV, clear their paid status so the upload stops skipping them:
--
--   UPDATE debtors SET status = 'active'
--    WHERE portfolio_id = '<uuid>' AND loan_reference IN ('<ref1>', '<ref2>');
--
-- then re-run Upload Paid File with that CSV. The dialog's reconciliation panel will now show
-- the file total against what was recorded, so a repeat is visible immediately.
