-- WHO is reverting the RLS policies? This records it definitively.
--
-- We know something outside this repo re-applies the old migrations on each deploy, but not
-- what. Rather than disconnect integrations on a hunch, this logs the identity behind every
-- CREATE FUNCTION / CREATE POLICY touching our auth objects — so the next revert names itself.
--
-- Install it, then trigger a deploy (or just wait for the next one) and read the table.
-- Cheap, read-only in effect, and easy to remove (section 4).

-- ══ 1. Somewhere to record it ═══════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS _rls_ddl_audit (
  id             bigserial PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  db_user        text,        -- the Postgres role that ran it
  app_name       text,        -- application_name — often names the tool (e.g. supabase-cli, psql)
  client_addr    inet,        -- source IP: distinguishes CI vs a dashboard vs a hosted service
  command_tag    text,
  object_identity text,
  -- The state we care about, captured at the moment of the change:
  auth_agent_id_lang text,
  agents_select_ok   boolean
);

-- ══ 2. The recorder ═════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION _rls_audit_ddl() RETURNS event_trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
  DECLARE
    r RECORD;
    lang text;
    ok boolean;
  BEGIN
    SELECT l.lanname INTO lang
      FROM pg_proc p
      JOIN pg_language l ON l.oid = p.prolang
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'auth_agent_id';

    SELECT (qual LIKE '%auth_visible_agent_ids%') INTO ok
      FROM pg_policies
     WHERE tablename = 'agents' AND policyname = 'agents_select';

    FOR r IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
      -- Only record DDL on the objects involved in the outage, so this stays quiet.
      IF r.object_identity ILIKE '%auth_%'
         OR r.object_identity ILIKE '%agents%'
         OR r.object_identity ILIKE '%debtors%'
         OR r.object_identity ILIKE '%team_agents%'
         OR r.object_identity ILIKE '%portfolios%' THEN
        INSERT INTO _rls_ddl_audit(
          db_user, app_name, client_addr, command_tag, object_identity,
          auth_agent_id_lang, agents_select_ok
        )
        SELECT current_user,
               current_setting('application_name', true),
               inet_client_addr(),
               r.command_tag,
               r.object_identity,
               lang,
               ok;
      END IF;
    END LOOP;
  END;
  $$;

-- ══ 3. Install ══════════════════════════════════════════════════════════════
DROP EVENT TRIGGER IF EXISTS rls_audit_ddl_trg;
CREATE EVENT TRIGGER rls_audit_ddl_trg
  ON ddl_command_end
  WHEN TAG IN ('CREATE FUNCTION', 'CREATE POLICY', 'DROP POLICY', 'ALTER POLICY')
  EXECUTE FUNCTION _rls_audit_ddl();

-- ══ READ THE RESULTS (run this after the next deploy) ═══════════════════════
-- Look at db_user / app_name / client_addr on the rows where auth_agent_id_lang = 'sql'
-- or agents_select_ok = false — that is the moment of the revert, and those three columns
-- identify what did it.
SELECT occurred_at, db_user, app_name, client_addr, command_tag, object_identity,
       auth_agent_id_lang, agents_select_ok
FROM _rls_ddl_audit
ORDER BY occurred_at DESC
LIMIT 50;

-- ══ 4. UNINSTALL ════════════════════════════════════════════════════════════
-- DROP EVENT TRIGGER IF EXISTS rls_audit_ddl_trg;
-- DROP FUNCTION IF EXISTS _rls_audit_ddl();
-- DROP TABLE IF EXISTS _rls_ddl_audit;
