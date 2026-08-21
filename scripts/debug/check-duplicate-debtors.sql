-- Are debtor rows duplicated? And why does the report undercount them?
--
-- Two things prompted this:
--   (a) Per-agent assigned counts sum to ~7,746, but admin/reports showed a total of 1,449.
--   (b) The top agents reportedly don't really hold that many accounts.
--
-- Both point the same way: the same real-world debtor may exist as MANY rows (e.g. a portfolio
-- re-uploaded several times inserts fresh rows rather than updating existing ones), inflating
-- every per-agent count. Section 1 settles it in one number.
--
-- Run each section separately — the Supabase SQL Editor renders only the last result set.

-- ══ 1. HEADLINE: total rows vs. distinct people ═════════════════════════════
-- If `distinct_by_phone` is far below `total_rows`, the table is duplicated and every
-- assigned-count in the app is inflated by the same factor.
SELECT
  count(*)                                                  AS total_rows,
  count(*) FILTER (WHERE status IS DISTINCT FROM 'removed')  AS live_rows,
  count(DISTINCT phone_primary)                             AS distinct_by_phone,
  count(DISTINCT loan_reference)                            AS distinct_by_loan_ref,
  count(DISTINCT portfolio_id)                              AS portfolios_referenced,
  round(
    count(*)::numeric / NULLIF(count(DISTINCT phone_primary), 0), 2
  )                                                         AS avg_rows_per_person
FROM debtors;


-- ══ 2. The worst offenders — same phone, many rows ══════════════════════════
-- `portfolios` > 1 means the same person exists across several portfolios (likely repeated
-- uploads). `agents` > 1 means different agents are each working a copy of the same debtor.
SELECT
  d.phone_primary,
  max(d.name)                                   AS name,
  count(*)                                      AS row_count,
  count(DISTINCT d.portfolio_id)                AS portfolios,
  count(DISTINCT d.assigned_agent_id)           AS agents,
  string_agg(DISTINCT p.name, ' | ')            AS portfolio_names
FROM debtors d
LEFT JOIN portfolios p ON p.id = d.portfolio_id
WHERE d.status IS DISTINCT FROM 'removed'
GROUP BY d.phone_primary
HAVING count(*) > 1
ORDER BY row_count DESC
LIMIT 30;


-- ══ 3. Duplication per portfolio — which upload created the copies? ═════════
-- A portfolio whose total_rows greatly exceeds distinct_phones was likely uploaded more than
-- once, or built from a file containing repeats.
SELECT
  p.name                                       AS portfolio,
  CASE WHEN p.closed_at IS NULL THEN 'open' ELSE 'closed' END AS state,
  p.created_at::date                           AS created,
  count(d.id)                                  AS total_rows,
  count(DISTINCT d.phone_primary)              AS distinct_phones,
  count(d.id) - count(DISTINCT d.phone_primary) AS duplicate_rows
FROM portfolios p
LEFT JOIN debtors d ON d.portfolio_id = p.id AND d.status IS DISTINCT FROM 'removed'
GROUP BY p.id, p.name, p.closed_at, p.created_at
ORDER BY duplicate_rows DESC;


-- ══ 4. WHY THE REPORT UNDERCOUNTS (1,449 vs ~7,746) ═════════════════════════
-- The app caches portfolios+debtors in localStorage. With this many rows that cache can blow
-- past the browser's ~5MB quota, so a stale/partial snapshot gets served — which would explain
-- the app showing one portfolio's worth of rows while the database holds far more.
-- This shows the true scale the client is being asked to cache.
SELECT
  (SELECT count(*) FROM portfolios)                                  AS portfolios_total,
  (SELECT count(*) FROM portfolios WHERE closed_at IS NULL)          AS portfolios_open,
  (SELECT count(*) FROM debtors WHERE status IS DISTINCT FROM 'removed') AS debtors_live,
  pg_size_pretty(pg_total_relation_size('debtors'))                  AS debtors_table_size;
