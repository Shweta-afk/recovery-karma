-- Who are debtors actually assigned to, and which team owns each portfolio?
--
-- Context: the By Agent report showed all 1,449 accounts against a single agent, but
-- portfolios were reportedly assigned across almost every team. Those are TWO DIFFERENT
-- things, and the report only reflects the second one:
--
--   portfolios.team_id / manager_id   -> which TEAM owns the portfolio
--   debtors.assigned_agent_id         -> which AGENT works that individual debtor
--
-- Assigning a portfolio to a team does NOT populate assigned_agent_id on its debtors. If the
-- rows below show one agent holding everything, the portfolio→team assignment happened but the
-- debtor→agent allocation didn't — a data/workflow gap, not a reporting bug.
--
-- Run each section separately (the SQL Editor shows only the last result set).

-- ══ 1. Debtors per assigned agent, split by whether the portfolio is still open ══
SELECT
  COALESCE(a.name, '(unassigned)')            AS agent,
  COALESCE(t.name, '—')                       AS team,
  count(*)                                    AS total_debtors,
  count(*) FILTER (
    WHERE p.closed_at IS NULL AND d.status IS DISTINCT FROM 'paid'
  )                                           AS active_debtors
FROM debtors d
LEFT JOIN agents a       ON a.id = d.assigned_agent_id
LEFT JOIN portfolios p   ON p.id = d.portfolio_id
LEFT JOIN team_agents ta ON ta.agent_id = a.id
LEFT JOIN teams t        ON t.id = ta.team_id
WHERE d.status IS DISTINCT FROM 'removed'
GROUP BY 1, 2
ORDER BY total_debtors DESC;


-- ══ 2. Portfolios: which team owns them, and are their debtors allocated? ═══════
-- `assigned_debtors` far below `total_debtors` means the portfolio reached a team but its
-- rows were never handed to individual agents.
SELECT
  p.name                                        AS portfolio,
  COALESCE(t.name, '(no team)')                 AS owning_team,
  COALESCE(m.name, '(no manager)')              AS manager,
  CASE WHEN p.closed_at IS NULL THEN 'open' ELSE 'closed' END AS state,
  count(d.id)                                   AS total_debtors,
  count(d.assigned_agent_id)                    AS assigned_debtors,
  count(d.id) - count(d.assigned_agent_id)      AS unassigned_debtors
FROM portfolios p
LEFT JOIN teams t   ON t.id = p.team_id
LEFT JOIN agents m  ON m.id = p.manager_id
LEFT JOIN debtors d ON d.portfolio_id = p.id AND d.status IS DISTINCT FROM 'removed'
GROUP BY p.id, p.name, t.name, m.name, p.closed_at
ORDER BY total_debtors DESC;


-- ══ 3. Roster vs. workload — every agent, including those holding nothing ═══════
SELECT
  a.name                                   AS agent,
  a.role,
  COALESCE(t.name, '—')                    AS team,
  count(d.id)                              AS debtors_assigned
FROM agents a
LEFT JOIN team_agents ta ON ta.agent_id = a.id
LEFT JOIN teams t        ON t.id = ta.team_id
LEFT JOIN debtors d      ON d.assigned_agent_id = a.id
                        AND d.status IS DISTINCT FROM 'removed'
GROUP BY a.id, a.name, a.role, t.name
ORDER BY debtors_assigned DESC, a.name;
