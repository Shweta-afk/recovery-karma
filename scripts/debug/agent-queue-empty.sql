-- Why an agent's Call Queue reads "0 accounts in queue" when the manager has assigned them.
--
-- Reported 2026-08-23: agent akashvis812@gmail.com sees Total Count 0 and "No portfolio
-- assigned", while the PTP Follow-up Tracker directly below it lists 2 real debtors. That
-- combination is the clue: the tracker reads `call_logs` (debtor name and phone are
-- denormalised onto the log), while the queue needs live `debtors` + `portfolios` rows. So the
-- agent's call history is readable and their debtor rows are not reaching buildAssignedQueue().
--
-- Note "No portfolio assigned" is NOT an independent symptom. dashboard.call-queue.tsx derives
-- primaryPortfolio from allQueue[0], so an empty queue always prints it. One root cause, two
-- pieces of text.
--
-- For a debtor to appear in that queue, EVERY link below has to hold (portfolio-store.ts →
-- build-queue.ts). This query reports on each one:
--
--   1. agents            a row exists whose `email` EXACTLY equals the agent's login email
--   2. debtors           assigned_agent_id = that agent's UUID
--   3. portfolios        the owning portfolio has closed_at IS NULL
--                        (a closed cycle is cached with rows: [] and buildAssignedQueue
--                         `continue`s on it — the queue cannot show a closed portfolio at all)
--   4. debtors.status    not 'removed' (filtered in refreshPortfolios) and not 'paid'
--                        (skipped in buildAssignedQueue)
--
-- Read-only. The Supabase SQL Editor renders only the LAST statement's result, so everything
-- is UNIONed into one result set — run it whole, don't bisect it.

WITH me AS (
  SELECT id, email FROM agents WHERE lower(trim(email)) = lower(trim('akashvis812@gmail.com'))
),
mine AS (
  SELECT d.*, p.name AS portfolio_name, p.closed_at
  FROM debtors d
  LEFT JOIN portfolios p ON p.id = d.portfolio_id
  WHERE d.assigned_agent_id = (SELECT id FROM me)
),
-- Portfolios this agent has actually called into, whoever the rows are assigned to now. If
-- link 2 broke, this still finds where their work went.
worked AS (
  SELECT DISTINCT d.portfolio_id
  FROM call_logs cl JOIN debtors d ON d.id = cl.debtor_id
  WHERE cl.agent_id = (SELECT id FROM me)
)

-- 1. Does the agent row exist, and does its email match the login exactly?
SELECT '1. agent row' AS check, COALESCE((SELECT id::text FROM me), '*** NO MATCHING agents ROW ***') AS detail,
       COALESCE((SELECT email FROM me), '—') AS value
UNION ALL
-- A stored email differing only by case or whitespace breaks the queue silently: the manager's
-- assign writes the right UUID, but the agent side compares emails as strings.
SELECT '1b. near-miss emails', email, 'exact match? ' || (email = 'akashvis812@gmail.com')::text
FROM agents WHERE lower(trim(email)) = lower(trim('akashvis812@gmail.com'))
UNION ALL

-- 2. How many debtors are assigned to them at all?
SELECT '2. debtors assigned', count(*)::text, 'rows' FROM mine
UNION ALL

-- 3/4. Of those, the breakdown that decides whether each row survives to the queue.
SELECT '3. assigned by portfolio',
       COALESCE(portfolio_name, '(no portfolio)') || CASE WHEN closed_at IS NOT NULL
            THEN '  *** CLOSED ' || closed_at::date || ' — INVISIBLE TO THE QUEUE ***' ELSE '' END,
       count(*)::text || ' rows'
FROM mine GROUP BY portfolio_name, closed_at
UNION ALL
SELECT '4. assigned by status',
       COALESCE(status, '(null)') || CASE WHEN status IN ('paid','removed')
            THEN '  *** DROPPED FROM THE QUEUE ***' ELSE '' END,
       count(*)::text || ' rows'
FROM mine GROUP BY status
UNION ALL

-- 5. The silent-skip signature.
--
-- assignDebtors() sets assigned_agent_id = NULL for the WHOLE portfolio first, then loops the
-- allocation and does `const agentUuid = idByEmail.get(agentEmail); if (!agentUuid) continue;`.
-- That `continue` is silent. If the manager's own read of `agents` did not return this agent
-- (RLS scoping, or a stale roster), the reset lands and the re-assign never does — the manager
-- sees "assigned" and every row in the portfolio ends up NULL. High unassigned counts in a
-- portfolio the agent has demonstrably worked is exactly that fingerprint.
SELECT '5. UNASSIGNED in portfolios they worked',
       COALESCE(p.name, '(no portfolio)'),
       count(*)::text || ' rows with assigned_agent_id IS NULL'
FROM debtors d
LEFT JOIN portfolios p ON p.id = d.portfolio_id
WHERE d.portfolio_id IN (SELECT portfolio_id FROM worked)
  AND d.assigned_agent_id IS NULL
GROUP BY p.name
UNION ALL

-- 6. Confirms the agent HAS worked accounts, so an empty queue is a regression rather than a
-- new hire with nothing allocated yet.
SELECT '6. their call logs', count(*)::text, 'calls logged' FROM call_logs
WHERE agent_id = (SELECT id FROM me)
UNION ALL
SELECT '6b. debtors behind those calls',
       count(DISTINCT d.id)::text,
       'now assigned elsewhere: ' || count(DISTINCT d.id) FILTER (
         WHERE d.assigned_agent_id IS DISTINCT FROM (SELECT id FROM me))::text
FROM call_logs cl JOIN debtors d ON d.id = cl.debtor_id
WHERE cl.agent_id = (SELECT id FROM me)

ORDER BY 1;

-- ── Reading the result ────────────────────────────────────────────────────────────────────
-- Row 2 is 0, row 5 is large   → assignDebtors' silent `continue` wiped the portfolio. Re-run
--                                the assignment from Manager → Queue and watch row 2 change.
-- Row 2 > 0, row 3 says CLOSED → the debtors sit in a closed cycle. Reopen it, or carry them
--                                forward via a retention request so their portfolio_id moves
--                                to the live cycle.
-- Row 2 > 0, row 4 says paid   → a paid-file upload settled them; the queue is correct.
-- Row 1 says NO MATCHING ROW,
--   or 1b says exact match? false
--                              → identity mismatch. The queue compares
--                                debtors.assigned_agent_id → agents.email against the login
--                                email as a plain string, so a case or whitespace difference
--                                empties the queue while every other page looks fine.
-- Everything above looks right → the failure is client-side: refreshPortfolios() bails with a
--                                bare `return` if the portfolios, debtors OR agents read
--                                errors, logging nothing. Have the agent open DevTools →
--                                Network and check those three requests for a 4xx.
