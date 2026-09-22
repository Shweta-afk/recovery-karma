-- Portfolio-scoped twin of portfolio_debtor_aggregates() (migrations/
-- 20260908_portfolio_debtor_aggregates.sql). The original takes no arguments and always scans
-- every debtor the caller's RLS lets them see before grouping by portfolio — measured directly
-- against production (2026-09-22): 2.27s for one manager with ~6,600 visible rows, even though
-- Portfolio Overview only ever wants the handful of portfolios in the manager's active team.
--
-- Same SELECT as the original, with an added `d.portfolio_id = ANY(p_portfolio_ids)` so the
-- planner can use idx_debtors_portfolio_id instead of scanning the whole client-visible set.
-- SECURITY INVOKER (the default, same as the original) — runs as the caller, so debtors_select
-- still applies; this is a query-shape change, not a privilege change, and is not an `auth_*`
-- helper, so it is outside the class of function scripts/check-rls-safety.mjs guards against.
--
-- The original function is left in place, untouched — portfolio-store.ts's refreshPortfolios()
-- (Reports, admin pages) still calls it unscoped.
CREATE OR REPLACE FUNCTION portfolio_debtor_aggregates_for(p_portfolio_ids UUID[])
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
  WHERE d.portfolio_id = ANY(p_portfolio_ids)
    AND d.status IS DISTINCT FROM 'removed'
  GROUP BY d.portfolio_id;
$$;

REVOKE ALL ON FUNCTION portfolio_debtor_aggregates_for(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION portfolio_debtor_aggregates_for(UUID[]) TO authenticated, service_role;
