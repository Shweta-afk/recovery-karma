-- Report account counts computed in SQL instead of in the browser.
--
-- WHY: portfolio-store.ts caches every portfolio AND every debtor row in localStorage, then
-- the report pages counted those cached rows with portfolios.reduce(...). At 10,436 live
-- debtors / 26 MB (measured 2026-08-21) that blows past localStorage's ~5 MB per-origin
-- quota, so a partial snapshot gets served and every count is wrong — admin/reports showed
-- "1 active portfolio" and 1,449 accounts against a real 8 and 10,436.
--
-- Counting is exactly the work a database should do. These return a handful of aggregate rows
-- regardless of dataset size, so the numbers are correct and the payload stays tiny.
--
-- SECURITY INVOKER (not DEFINER) is deliberate: RLS must still apply, so an agent's counts
-- cover only their own debtors and a manager's only their team's — the same masking the rest
-- of the app enforces. Do NOT switch these to SECURITY DEFINER; that would leak counts across
-- teams. (They're also plain `LANGUAGE sql` without SECURITY DEFINER, so the inlining hazard
-- that caused the 42P17 outages does not apply here — see check-rls-safety.mjs.)

-- ── Per-agent assigned counts ────────────────────────────────────────────────
-- Keyed by email because that is the identity the app uses everywhere (AgentRef.id,
-- teams.agentIds, UploadedDebtor.assignedAgentId are all emails).
CREATE OR REPLACE FUNCTION report_agent_account_counts()
  RETURNS TABLE (
    agent_email     text,
    active_assigned bigint,
    total_assigned  bigint
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    SELECT
      a.email::text                                                      AS agent_email,
      -- "Active" = the dialer's definition (see buildAssignedQueue): the portfolio's cycle is
      -- still open and the account hasn't already been settled.
      count(*) FILTER (
        WHERE p.closed_at IS NULL AND d.status IS DISTINCT FROM 'paid'
      )                                                                  AS active_assigned,
      count(*)                                                           AS total_assigned
    FROM debtors d
    JOIN agents a      ON a.id = d.assigned_agent_id
    LEFT JOIN portfolios p ON p.id = d.portfolio_id
    WHERE d.status IS DISTINCT FROM 'removed'
    GROUP BY a.email
  $$;

-- ── Per-portfolio totals ─────────────────────────────────────────────────────
-- Feeds the KPI strip, team standings and the Recovery tab. `placed_amount` is the sum of
-- loan_amount, i.e. the denominator of recovery rate.
CREATE OR REPLACE FUNCTION report_portfolio_totals()
  RETURNS TABLE (
    portfolio_id   uuid,
    portfolio_name text,
    team_id        uuid,
    manager_id     uuid,
    is_open        boolean,
    total_rows     bigint,
    active_rows    bigint,
    assigned_rows  bigint,
    placed_amount  numeric
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    SELECT
      p.id,
      p.name::text,
      p.team_id,
      p.manager_id,
      (p.closed_at IS NULL)                                              AS is_open,
      count(d.id)                                                        AS total_rows,
      count(d.id) FILTER (
        WHERE p.closed_at IS NULL AND d.status IS DISTINCT FROM 'paid'
      )                                                                  AS active_rows,
      count(d.assigned_agent_id) FILTER (
        WHERE p.closed_at IS NULL AND d.status IS DISTINCT FROM 'paid'
      )                                                                  AS assigned_rows,
      COALESCE(sum(d.loan_amount), 0)                                    AS placed_amount
    FROM portfolios p
    LEFT JOIN debtors d
      ON d.portfolio_id = p.id
     AND d.status IS DISTINCT FROM 'removed'
    GROUP BY p.id, p.name, p.team_id, p.manager_id, p.closed_at
  $$;

GRANT EXECUTE ON FUNCTION report_agent_account_counts() TO authenticated;
GRANT EXECUTE ON FUNCTION report_portfolio_totals()     TO authenticated;
