-- Collection MIS (user, 2026-11-27): the company's daily MIS sheets (Daily Collection, Ranking,
-- Zero Numbers, Client, Last-month Differences) built from SamvadX's own data.
--   client      = the portfolio's TEAM (portfolios.lender_name holds free text such as a
--                 manager's name, so it cannot group by lender).
--   POS / loans = loan_amount / count of accounts assigned to the agent in OPEN portfolios.
--   paid        = completed payments (agent-entered and bank paid files), by IST day, credited
--                 to payments.agent_id, else to the account's assigned agent.
--   projection  = open promises still to come this month: the account's LATEST call is a PTP
--                 ('promised') or Partially Paid with a balance, due between p_as_of and month end.
-- One row per (team, agent). Called only by src/lib/collection-mis.server.ts with the service
-- role after verifyCaller; the caller's company and team scope are passed in.

CREATE OR REPLACE FUNCTION collection_mis(
  p_client uuid,
  p_team_ids uuid[],
  p_month_start date,
  p_as_of date
)
RETURNS TABLE (
  team_id uuid,
  team_name text,
  agent_id uuid,
  agent_name text,
  pos numeric,
  loans bigint,
  paid_by_day jsonb,
  projection numeric
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH scope_portfolios AS (
    SELECT p.id, p.team_id
    FROM portfolios p
    WHERE p.client_id = p_client
      AND p.team_id = ANY (p_team_ids)
      AND p.deleted_at IS NULL
  ),
  open_debtors AS (
    SELECT d.id, d.assigned_agent_id, d.loan_amount, sp.team_id
    FROM debtors d
    JOIN scope_portfolios sp ON sp.id = d.portfolio_id
    JOIN portfolios p ON p.id = d.portfolio_id
    WHERE p.closed_at IS NULL AND d.assigned_agent_id IS NOT NULL
  ),
  book AS (
    SELECT team_id, assigned_agent_id AS agent_id,
           SUM(COALESCE(loan_amount, 0)) AS pos, COUNT(*) AS loans
    FROM open_debtors GROUP BY 1, 2
  ),
  paid AS (
    SELECT sp.team_id,
           COALESCE(pay.agent_id, d.assigned_agent_id) AS agent_id,
           (pay.received_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
           SUM(pay.amount) AS amount
    FROM payments pay
    JOIN debtors d ON d.id = pay.debtor_id
    JOIN scope_portfolios sp ON sp.id = d.portfolio_id
    WHERE pay.status = 'completed'
      AND (pay.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_month_start AND p_as_of
    GROUP BY 1, 2, 3
  ),
  paid_agg AS (
    SELECT team_id, agent_id, jsonb_object_agg(day::text, amount) AS by_day
    FROM paid WHERE agent_id IS NOT NULL GROUP BY 1, 2
  ),
  latest AS (
    SELECT DISTINCT ON (cl.debtor_id) cl.debtor_id, cl.outcome, cl.promise_amount,
           cl.promise_date, cl.balance_amount, cl.balance_date
    FROM call_logs cl
    JOIN open_debtors od ON od.id = cl.debtor_id
    ORDER BY cl.debtor_id, cl.created_at DESC
  ),
  proj AS (
    SELECT od.team_id, od.assigned_agent_id AS agent_id,
           SUM(CASE
                 WHEN l.outcome = 'promised' THEN COALESCE(l.promise_amount, 0)
                 ELSE COALESCE(l.balance_amount, 0)
               END) AS amount
    FROM latest l
    JOIN open_debtors od ON od.id = l.debtor_id
    WHERE (l.outcome = 'promised'
           AND l.promise_date::date BETWEEN p_as_of
               AND (date_trunc('month', p_as_of) + interval '1 month - 1 day')::date)
       OR (l.outcome = 'partial_paid'
           AND l.balance_date::date BETWEEN p_as_of
               AND (date_trunc('month', p_as_of) + interval '1 month - 1 day')::date)
    GROUP BY 1, 2
  ),
  keys AS (
    SELECT team_id, agent_id FROM book
    UNION SELECT team_id, agent_id FROM paid_agg
    UNION SELECT team_id, agent_id FROM proj
  )
  SELECT k.team_id, t.name, k.agent_id, a.name,
         COALESCE(b.pos, 0), COALESCE(b.loans, 0),
         COALESCE(pa.by_day, '{}'::jsonb), COALESCE(pr.amount, 0)
  FROM keys k
  JOIN teams t ON t.id = k.team_id
  JOIN agents a ON a.id = k.agent_id
  LEFT JOIN book b ON b.team_id = k.team_id AND b.agent_id = k.agent_id
  LEFT JOIN paid_agg pa ON pa.team_id = k.team_id AND pa.agent_id = k.agent_id
  LEFT JOIN proj pr ON pr.team_id = k.team_id AND pr.agent_id = k.agent_id;
$$;

REVOKE ALL ON FUNCTION collection_mis(uuid, uuid[], date, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION collection_mis(uuid, uuid[], date, date) TO service_role;
