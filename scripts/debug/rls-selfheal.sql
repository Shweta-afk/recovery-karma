-- SELF-HEALING GUARD for the recurring 42P17 recursion outage.
--
-- WHY THIS EXISTS: something outside this repo re-applies the OLD migrations on every deploy.
-- Verified 2026-08-21 — CI touches no database, the app runs no DDL, and every migration file
-- in the repo was amended to the correct definitions, yet a push still reverted the live
-- schema to `auth_agent_id() LANGUAGE sql` + the inline `agents_select`/`debtors_select`
-- bodies. The most likely source is the Lovable integration replaying its own stored copy of
-- the migrations, which repo edits cannot influence.
--
-- WHAT THIS DOES: installs a Postgres EVENT TRIGGER that fires after any CREATE FUNCTION or
-- CREATE POLICY. If it sees the schema has been reverted to a known-bad shape, it immediately
-- re-applies the correct definitions. So a replay still happens — it just gets repaired within
-- the same transaction, and production never sees the broken state.
--
-- TRADE-OFF, READ BEFORE INSTALLING: this makes the database silently overrule certain DDL.
-- If someone later *intends* to change agents_select or auth_agent_id, this will fight them
-- and that will be confusing. It is a workaround for an external process we cannot control,
-- not a substitute for stopping that process. Remove it (section 3) once the replay is fixed.
--
-- Run section 1 + 2 to install. Section 3 uninstalls.

-- ══ SECTION 1: the repair routine ═══════════════════════════════════════════
CREATE OR REPLACE FUNCTION _rls_selfheal() RETURNS event_trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $outer$
  DECLARE
    needs_repair boolean := false;
  BEGIN
    -- Re-entrancy guard: our own CREATE OR REPLACE statements below fire this same trigger.
    -- Without this it would recurse until the stack depth limit.
    IF coalesce(current_setting('rls_selfheal.running', true), 'off') = 'on' THEN
      RETURN;
    END IF;

    -- Bad shape 1: auth_agent_id() reverted to the inlinable LANGUAGE sql form.
    IF EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'auth_agent_id' AND l.lanname = 'sql'
    ) THEN
      needs_repair := true;
    END IF;

    -- Bad shape 2: agents_select reading team_agents/teams inline instead of via the helper.
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'agents' AND policyname = 'agents_select'
        AND qual NOT LIKE '%auth_visible_agent_ids%'
    ) THEN
      needs_repair := true;
    END IF;

    -- Bad shape 3: debtors_select reading team_agents inline.
    IF EXISTS (
      SELECT 1 FROM pg_policies
      WHERE tablename = 'debtors' AND policyname = 'debtors_select'
        AND qual NOT LIKE '%auth_visible_agent_ids%'
    ) THEN
      needs_repair := true;
    END IF;

    IF NOT needs_repair THEN
      RETURN;
    END IF;

    PERFORM set_config('rls_selfheal.running', 'on', true);  -- true = transaction-local

    -- plpgsql so the planner cannot inline it and discard SECURITY DEFINER.
    EXECUTE $f$
      CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
        LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path = public, pg_temp
        SET row_security = off
        AS $body$
        DECLARE result UUID;
        BEGIN
          SELECT id INTO result FROM agents WHERE auth_user_id = auth.uid() LIMIT 1;
          RETURN result;
        END; $body$;
    $f$;

    EXECUTE $f$ DROP POLICY IF EXISTS agents_select ON agents $f$;
    EXECUTE $f$
      CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
        USING (
          client_id = auth_client_id()
          AND (auth_role() = 'admin' OR id IN (SELECT auth_visible_agent_ids()))
        );
    $f$;

    EXECUTE $f$ DROP POLICY IF EXISTS debtors_select ON debtors $f$;
    EXECUTE $f$
      CREATE POLICY debtors_select ON debtors FOR SELECT TO authenticated
        USING (
          client_id = auth_client_id()
          AND (
            auth_role() = 'admin'
            OR assigned_agent_id = auth_agent_id()
            OR (
              auth_role() = 'manager'
              AND (
                assigned_agent_id IN (SELECT auth_visible_agent_ids())
                OR portfolio_id IN (SELECT auth_visible_portfolio_ids())
              )
            )
          )
        );
    $f$;

    PERFORM set_config('rls_selfheal.running', 'off', true);

    RAISE NOTICE '[rls_selfheal] detected a reverted RLS definition and repaired it';
  END;
  $outer$;

-- ══ SECTION 2: install the trigger ══════════════════════════════════════════
DROP EVENT TRIGGER IF EXISTS rls_selfheal_trg;
CREATE EVENT TRIGGER rls_selfheal_trg
  ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'CREATE POLICY')
  EXECUTE FUNCTION _rls_selfheal();

-- ══ SECTION 3: UNINSTALL (run this once the external replay is stopped) ═════
-- DROP EVENT TRIGGER IF EXISTS rls_selfheal_trg;
-- DROP FUNCTION IF EXISTS _rls_selfheal();
