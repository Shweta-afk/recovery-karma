-- READ-ONLY. What deleting every closed portfolio would destroy.
--
-- Run this BEFORE any delete, and take a Supabase backup first. Nothing here writes.
--
-- Background: as of 2026-08-22 the live project had 13 portfolios, six of them holding 1,064
-- rows each — the same file re-uploaded, five of those six closed. Closing is not deleting:
-- their debtor rows are still in the table, and debtors is the FK parent for call_logs,
-- payments, messages, disputes and settlement_requests, so removing them cascades into real
-- collections history.
--
-- Two columns decide whether a portfolio is safe to drop:
--
--   also_in_open_pf  Debtors whose loan_reference ALSO appears in an open portfolio. If this
--                    equals `debtors`, the closed copy is a genuine duplicate re-upload and
--                    dropping it loses nothing. If it is well below, those rows are accounts
--                    that were NOT carried forward — real history you would be erasing.
--
--   paid_value       Completed payments attached to those debtors. This is the cost of being
--                    wrong, and it does not come back.
--
-- Deliberately touches only tables confirmed to exist. retention_requests,
-- portfolios.replaces_portfolio_id, debtors.retained_from_portfolio_id and payments.source
-- come from migrations that may not be applied here, and naming a missing table or column
-- makes the whole statement fail to parse rather than return partial results. Query B at the
-- bottom checks for them separately.
--
-- One statement: the Supabase SQL Editor renders only the final result set.

WITH target AS (
  SELECT id, name, closed_at FROM portfolios WHERE closed_at IS NOT NULL
),
d AS (
  SELECT id, portfolio_id, loan_reference, status
  FROM debtors WHERE portfolio_id IN (SELECT id FROM target)
),
open_refs AS (
  SELECT DISTINCT lower(trim(loan_reference)) AS ref
  FROM debtors
  WHERE portfolio_id IN (SELECT id FROM portfolios WHERE closed_at IS NULL)
    AND loan_reference IS NOT NULL
)
SELECT
  1 AS sort,
  t.name || ' · ' || left(t.id::text, 8)                                  AS portfolio,
  to_char(t.closed_at, 'YYYY-MM-DD')                                      AS closed_on,
  (SELECT count(*) FROM d WHERE d.portfolio_id = t.id)                    AS debtors,
  (SELECT count(*) FROM d WHERE d.portfolio_id = t.id AND d.status = 'paid') AS debtors_paid,
  (SELECT count(*) FROM d WHERE d.portfolio_id = t.id
     AND lower(trim(d.loan_reference)) IN (SELECT ref FROM open_refs))    AS also_in_open_pf,
  (SELECT count(*) FROM call_logs c
     WHERE c.debtor_id IN (SELECT id FROM d WHERE d.portfolio_id = t.id)) AS call_logs,
  (SELECT count(*) FROM payments p
     WHERE p.debtor_id IN (SELECT id FROM d WHERE d.portfolio_id = t.id)) AS payments,
  COALESCE((SELECT sum(p.amount) FROM payments p
     WHERE p.debtor_id IN (SELECT id FROM d WHERE d.portfolio_id = t.id)
       AND p.status = 'completed'), 0)                                    AS paid_value,
  (SELECT count(*) FROM messages m
     WHERE m.debtor_id IN (SELECT id FROM d WHERE d.portfolio_id = t.id)) AS messages,
  (SELECT count(*) FROM disputes x
     WHERE x.debtor_id IN (SELECT id FROM d WHERE d.portfolio_id = t.id)) AS disputes,
  (SELECT count(*) FROM settlement_requests s
     WHERE s.debtor_id IN (SELECT id FROM d WHERE d.portfolio_id = t.id)) AS settlements
FROM target t

UNION ALL

SELECT
  2,
  'TOTAL — ' || (SELECT count(*) FROM target) || ' closed portfolios',
  '',
  (SELECT count(*) FROM d),
  (SELECT count(*) FROM d WHERE status = 'paid'),
  (SELECT count(*) FROM d WHERE lower(trim(loan_reference)) IN (SELECT ref FROM open_refs)),
  (SELECT count(*) FROM call_logs WHERE debtor_id IN (SELECT id FROM d)),
  (SELECT count(*) FROM payments  WHERE debtor_id IN (SELECT id FROM d)),
  COALESCE((SELECT sum(amount) FROM payments
            WHERE debtor_id IN (SELECT id FROM d) AND status = 'completed'), 0),
  (SELECT count(*) FROM messages  WHERE debtor_id IN (SELECT id FROM d)),
  (SELECT count(*) FROM disputes  WHERE debtor_id IN (SELECT id FROM d)),
  (SELECT count(*) FROM settlement_requests WHERE debtor_id IN (SELECT id FROM d))

ORDER BY sort, portfolio;

-- ── Query B: do the optional tables/columns exist here? Run separately. ───────────────────
--
-- SELECT 'table: retention_requests' AS item,
--        coalesce(to_regclass('public.retention_requests')::text, 'MISSING') AS present
-- UNION ALL
-- SELECT 'column: ' || table_name || '.' || column_name, 'present'
-- FROM information_schema.columns
-- WHERE table_schema = 'public'
--   AND ((table_name = 'portfolios' AND column_name = 'replaces_portfolio_id')
--     OR (table_name = 'debtors'    AND column_name = 'retained_from_portfolio_id')
--     OR (table_name = 'payments'   AND column_name = 'source'))
-- ORDER BY 1;

-- ── Bonus: ₹0 bank-reported payments left by paid-file uploads before b3d6c73 ─────────────
--
-- SELECT count(*) AS zero_rows, min(created_at) AS first_seen, max(created_at) AS last_seen
-- FROM payments WHERE amount = 0 AND agent_id IS NULL;
