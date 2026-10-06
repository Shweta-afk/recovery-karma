-- Admins must confirm every sign-in with a one-time code emailed by Supabase (2026-10-06).
--
-- The login screen asks for the code (src/lib/auth.tsx, src/lib/login-otp.ts), but that alone
-- would leave the password as the whole key: anyone holding it could sign in through the API
-- and read the company's data directly. So the database itself withholds admin powers from a
-- session that has not passed the code.
--
-- How a session proves it: Supabase stamps each access token's `amr` claim with how the session
-- was created — `password`, `otp` (email code typed in), `magiclink` (the link in that same
-- email). A sign-in finished through the code carries `otp`; a password-only one does not.
-- Keep the method list identical to EMAIL_OTP_AMR_METHODS in src/lib/login-otp.ts.
--
-- What changes:
--   * auth_role() returns 'admin_unverified' instead of 'admin' for such a session. Every
--     policy and helper compares auth_role() to 'admin'/'manager' (checked live 2026-10-06:
--     38 policies, auth_my_debtor_ids, agents_guard_privileged_columns, delete_portfolio), so
--     the session falls through to an agent's own-rows-only access. It never errors.
--   * auth_visible_team_ids() read agents.role itself instead of calling auth_role(), so it
--     would have kept handing an unverified admin every team. It now goes through auth_role().
--
-- Superadmins have no database powers to withhold (superadmins has no RLS policy; everything
-- runs through service-role server actions), so their check lives in verifySuperadminCaller.
-- The service-role side for company admins is verifyCaller — both in supabase-admin.server.ts.
--
-- Rollback: re-run the auth_role()/auth_visible_team_ids() definitions from
-- 20260821_rls_no_direct_table_reads.sql / 20260908_fix_team_agents_admin_client_scope.sql.

CREATE OR REPLACE FUNCTION auth_session_email_verified() RETURNS BOOLEAN
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE amr JSONB := auth.jwt() -> 'amr';
  BEGIN
    IF amr IS NULL OR jsonb_typeof(amr) <> 'array' THEN
      RETURN false;
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM jsonb_array_elements(amr) e
      WHERE jsonb_typeof(e) = 'object' AND e ->> 'method' IN ('otp', 'magiclink')
    );
  END; $$;

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE
    result TEXT;
  BEGIN
    SELECT role INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
    IF result = 'admin' AND NOT auth_session_email_verified() THEN
      RETURN 'admin_unverified';
    END IF;
    RETURN result;
  END; $$;

CREATE OR REPLACE FUNCTION auth_visible_team_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  DECLARE me UUID; r TEXT; cid UUID;
  BEGIN
    SELECT id, client_id INTO me, cid FROM agents WHERE auth_user_id = auth.uid();
    r := auth_role();
    IF r = 'admin' THEN
      RETURN QUERY SELECT id FROM teams WHERE client_id = cid;
    ELSE
      RETURN QUERY
      SELECT id FROM teams WHERE manager_id = me
      UNION
      SELECT team_id FROM team_agents WHERE agent_id = me;
    END IF;
  END; $$;

REVOKE ALL ON FUNCTION auth_session_email_verified() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION auth_session_email_verified() TO authenticated, service_role;
