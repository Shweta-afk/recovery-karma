-- HOTFIX for 20260814_scope_remaining_tables_to_agent_and_manager.sql, which broke every
-- non-admin, non-service-role query touching `agents` (confirmed live: PostgREST returned
-- 42P17 "infinite recursion detected in policy for relation agents" for a real manager
-- session immediately after that migration ran).
--
-- Root cause: auth_agent_id() was declared `LANGUAGE sql STABLE SECURITY DEFINER`, the same
-- shape as auth_client_id()/auth_role(). Those two are safe because they're only ever called
-- FROM OTHER tables' policies (a different table than the one they query). auth_agent_id() is
-- called from agents_select itself - and Postgres's planner inlines simple single-statement
-- SQL-language functions into the surrounding query, which silently discards the SECURITY
-- DEFINER privilege elevation. Once inlined, the function body's `SELECT id FROM agents ...`
-- runs as a normal query under the CALLING role, so it is itself subject to agents_select -
-- which depends on auth_agent_id() - a genuine self-referential cycle.
--
-- Fix: redefine as LANGUAGE plpgsql. plpgsql functions are opaque to the planner (never
-- inlined), so the SECURITY DEFINER role switch is preserved for the function's entire
-- execution, and the internal query genuinely bypasses agents' RLS via the table-owner
-- exemption - breaking the cycle. No policy needs to change, only this function's definition.
CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    result UUID;
  BEGIN
    SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    RETURN result;
  END;
  $$;
