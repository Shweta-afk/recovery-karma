-- Follow-up to 20260814_fix_auth_agent_id_recursion.sql, which fixed the SAME recursion bug
-- but only for auth_agent_id() — the agents_select policy (20260814_scope_remaining_tables_
-- to_agent_and_manager.sql) also calls auth_client_id() and auth_role() directly:
--
--   CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
--     USING (
--       client_id = auth_client_id()
--       AND ( auth_role() = 'admin' OR id = auth_agent_id() OR ... )
--     );
--
-- Both auth_client_id() and auth_role() (defined in 20260730_harden_rls.sql) are still
-- `LANGUAGE sql STABLE SECURITY DEFINER`, each internally running `SELECT ... FROM agents
-- WHERE auth_user_id = auth.uid()`. The original hotfix's own reasoning ("safe because
-- they're only ever called FROM OTHER tables' policies") does not hold here: agents_select
-- calls them on agents itself, so Postgres inlines them here exactly as it did
-- auth_agent_id(), discarding the SECURITY DEFINER escalation and recursing back into
-- agents_select — reproducing the identical 42P17 "infinite recursion detected in policy
-- for relation agents" error even after the first hotfix was applied. Confirmed live
-- 2026-08-14: the 500 on GET /rest/v1/agents persisted after running the auth_agent_id() fix
-- alone.
--
-- Fix: same technique as before — redefine both as plpgsql so Postgres never inlines them.
-- These functions are called from every other table's RLS policy too, but plpgsql only
-- changes whether the planner inlines the body; behavior for every other caller is identical.
CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    result UUID;
  BEGIN
    SELECT client_id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    result TEXT;
  BEGIN
    SELECT role INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;
