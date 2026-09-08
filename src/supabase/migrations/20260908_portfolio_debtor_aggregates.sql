-- Per-portfolio aggregate rollup over `debtors`, for portfolios whose row-level cache is
-- deliberately emptied client-side once closed (see refreshPortfolios in portfolio-store.ts —
-- protects the localStorage quota, recoveryai-localstorage-cache-limit memory: 10,436 debtors/
-- 26MB blew the ~5MB quota). Without this, a closed/superseded portfolio's dashboard read
-- totalOutstanding/totalPrincipal/buckets/assignedAccounts as zero even though the real debtor
-- rows are still sitting in the table under their original portfolio_id — only accounts with an
-- honored retention request actually move to the successor portfolio (reconcileRetainedDebtors
-- in portfolio-store.ts); everything else just stops being rendered from the emptied cache.
--
-- SECURITY INVOKER (the default — no SECURITY DEFINER here) and reads `debtors` directly, same
-- pattern as profilex_usage_detail (20260905_profilex_usage_detail.sql): called directly by an
-- authenticated client, not from inside another RLS policy, so it runs with the CALLER's own
-- privileges and RLS on `debtors` scopes the result exactly like any query the caller could run
-- themselves (agent sees only their own, manager/admin their team/client). This is NOT the
-- "policy reads a protected table" pattern CLAUDE.md's RLS rules forbid — that rule is about
-- helpers invoked FROM a policy; this one is invoked BY the client.
CREATE OR REPLACE FUNCTION portfolio_debtor_aggregates()
RETURNS TABLE (
  portfolio_id uuid,
  total_accounts bigint,
  total_outstanding numeric,
  total_principal numeric,
  assigned_accounts bigint,
  agent_ids uuid[],
  retained_accounts bigint,
  retained_amount numeric,
  bucket_x bigint,
  bucket_1 bigint,
  bucket_2 bigint,
  bucket_npa bigint,
  bucket_writeoff bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    d.portfolio_id,
    count(*) AS total_accounts,
    coalesce(sum(d.loan_amount), 0) AS total_outstanding,
    coalesce(sum(d.principal_amount), 0) AS total_principal,
    count(*) FILTER (WHERE d.assigned_agent_id IS NOT NULL) AS assigned_accounts,
    array_agg(DISTINCT d.assigned_agent_id) FILTER (WHERE d.assigned_agent_id IS NOT NULL) AS agent_ids,
    count(*) FILTER (WHERE d.retained_from_portfolio_id IS NOT NULL) AS retained_accounts,
    coalesce(sum(d.loan_amount) FILTER (WHERE d.retained_from_portfolio_id IS NOT NULL), 0) AS retained_amount,
    count(*) FILTER (WHERE d.dpd = 0) AS bucket_x,
    count(*) FILTER (WHERE d.dpd BETWEEN 1 AND 30) AS bucket_1,
    count(*) FILTER (WHERE d.dpd BETWEEN 31 AND 90) AS bucket_2,
    count(*) FILTER (WHERE d.dpd BETWEEN 91 AND 179) AS bucket_npa,
    count(*) FILTER (WHERE d.dpd >= 180) AS bucket_writeoff
  FROM debtors d
  WHERE d.portfolio_id IS NOT NULL
    AND d.status IS DISTINCT FROM 'removed'
  GROUP BY d.portfolio_id;
$$;
