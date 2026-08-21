-- Is the fix actually applied right now? One tiny read-only query, no transaction blocks.
-- Run this ALONE and paste the 3 rows back.
--
-- Purpose: the app still 500s, but we don't yet know whether the 2026-08-21 fix landed,
-- errored, or was never run. Explicit BEGIN/COMMIT in the previous script may have conflicted
-- with the SQL Editor's own transaction handling and silently rolled the DDL back — this
-- checks the live state directly instead of trusting that it applied.

SELECT
  'auth_agent_id language' AS check_name,
  l.lanname                AS actual,
  CASE WHEN l.lanname = 'plpgsql'
       THEN 'PASS'
       ELSE 'FAIL — still inlinable; this alone causes the recursion'
  END AS verdict
FROM pg_proc p
JOIN pg_language l ON l.oid = p.prolang
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'auth_agent_id'

UNION ALL

SELECT
  'agents_select uses helper fn',
  CASE WHEN qual LIKE '%auth_visible_agent_ids%' THEN 'yes' ELSE 'no — inline team_agents/teams' END,
  CASE WHEN qual LIKE '%auth_visible_agent_ids%'
       THEN 'PASS'
       ELSE 'FAIL — policy still reads team_agents/teams inside its own USING'
  END
FROM pg_policies
WHERE tablename = 'agents' AND policyname = 'agents_select'

UNION ALL

SELECT
  'team_agents_write reads agents inline',
  CASE WHEN qual LIKE '%FROM agents%' THEN 'yes' ELSE 'no' END,
  CASE WHEN qual LIKE '%FROM agents%'
       THEN 'FAIL — causes team_agents own recursion'
       ELSE 'PASS'
  END
FROM pg_policies
WHERE tablename = 'team_agents' AND policyname = 'team_agents_write';
