-- Is the fix still applied, and does it hold for the user that's 500ing?
-- Read-only. Run the whole file; paste the result table back.
--
-- Context: the full smoke test passed for user 25e3159e..., but the browser is 500ing for
-- user 0015916e... Two possibilities this distinguishes:
--   (a) the fix was REVERTED again (rows 1-3 will show FAIL)
--   (b) the recursion is role-specific and my test user didn't hit it (rows 1-3 PASS,
--       row 4+ FAIL) -- different roles take different branches of agents_select.

CREATE OR REPLACE FUNCTION _rls_probe(t text) RETURNS text
  LANGUAGE plpgsql SECURITY INVOKER
  AS $$
  DECLARE n bigint;
  BEGIN
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    RETURN 'OK — ' || n || ' rows';
  EXCEPTION WHEN OTHERS THEN
    RETURN 'FAIL — ' || SQLSTATE || ': ' || SQLERRM;
  END; $$;

-- Who is the failing user, and is the fix still in place?
SELECT * FROM (
  SELECT '1_fix_auth_agent_id' AS check_name,
         l.lanname AS value,
         CASE WHEN l.lanname = 'plpgsql' THEN 'PASS' ELSE 'FAIL — reverted to inlinable sql' END AS verdict
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'auth_agent_id'

  UNION ALL
  SELECT '2_fix_agents_select',
         CASE WHEN qual LIKE '%auth_visible_agent_ids%' THEN 'uses helper' ELSE 'inline reads' END,
         CASE WHEN qual LIKE '%auth_visible_agent_ids%' THEN 'PASS' ELSE 'FAIL — reverted' END
  FROM pg_policies WHERE tablename = 'agents' AND policyname = 'agents_select'

  UNION ALL
  SELECT '3_fix_debtors_select',
         CASE WHEN qual LIKE '%auth_visible_agent_ids%' THEN 'uses helper' ELSE 'inline reads' END,
         CASE WHEN qual LIKE '%auth_visible_agent_ids%' THEN 'PASS' ELSE 'FAIL — reverted' END
  FROM pg_policies WHERE tablename = 'debtors' AND policyname = 'debtors_select'

  UNION ALL
  -- How many SELECT policies exist on agents? More than one is a problem: permissive policies
  -- are OR'd, so a stray extra policy still gets evaluated and can recurse on its own.
  SELECT '4_agents_select_policy_count',
         count(*)::text,
         CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL — extra policy is also evaluated' END
  FROM pg_policies WHERE tablename = 'agents' AND cmd IN ('SELECT','ALL')

  UNION ALL
  -- Identify the failing user so we know which branch of the policy they take.
  SELECT '5_failing_user_role',
         COALESCE((SELECT role FROM agents WHERE auth_user_id = '0015916e-bd23-4816-b3b1-cb81c7ae9cd1'), 'NO AGENT ROW'),
         'info'
) x ORDER BY check_name;
