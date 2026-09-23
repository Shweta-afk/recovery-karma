-- Per-agent book totals (growth plan item #3): how many accounts each agent holds and their
-- summed loan_amount ("assigned POS").
--
-- The agent dashboard and the manager dashboard used to get these two numbers by running
-- portfolio-store.ts's refreshPortfolios() — downloading every debtor row the caller can see —
-- and summing them in the browser. Both pages load on every sign-in.
--
-- Same rules the browser applied (getAgentDebtorIds over the portfolio cache):
--   * assigned to the agent,
--   * status not 'removed' (NULL counts, as `d.status !== "removed"` did),
--   * in a portfolio that is not closed — the cache carries a closed portfolio's rows as [],
--   * in a portfolio the caller can see — the INNER JOIN runs under portfolios_select, just as
--     the cache only ever held portfolios RLS returned.
--
-- SECURITY INVOKER (the default): debtors_select and portfolios_select apply exactly as they did
-- to the browser's own queries, so an agent passing someone else's id gets nothing they could
-- not already read. Not an `auth_*` helper, so outside what check-rls-safety.mjs guards.
-- Uses idx_debtors_agent_id via the `= ANY` filter.

CREATE OR REPLACE FUNCTION public.agent_book_totals(p_agent_ids uuid[])
RETURNS TABLE (agent_id uuid, accounts bigint, assigned_pos numeric)
LANGUAGE sql
STABLE
AS $$
  SELECT d.assigned_agent_id,
         count(*),
         coalesce(sum(d.loan_amount), 0)
    FROM public.debtors d
    JOIN public.portfolios p ON p.id = d.portfolio_id
   WHERE d.assigned_agent_id = ANY (p_agent_ids)
     AND d.status IS DISTINCT FROM 'removed'
     AND p.closed_at IS NULL
   GROUP BY d.assigned_agent_id
$$;

GRANT EXECUTE ON FUNCTION public.agent_book_totals(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
