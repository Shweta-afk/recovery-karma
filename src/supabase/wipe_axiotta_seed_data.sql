-- ============================================================
-- One-off: wipe the seeded "Axiotta Risk Management" demo company from the live database,
-- so the first company created through /setup starts on a genuinely empty database.
--
-- Run this in Supabase → SQL Editor (same workflow as every other migration in this repo).
-- Resolves the client by company_name rather than a hardcoded UUID, so it's robust even if
-- the live row's id ever drifted from seed.sql's literal.
--
-- This does NOT delete the 5 Supabase Auth logins (admin@axiotta.in, manager@axiotta.in,
-- agent1-3@axiotta.in) — do that separately via Dashboard → Authentication → Users (5
-- clicks). Raw `DELETE FROM auth.users` is deliberately avoided here: it risks orphaning
-- rows in auth.identities/auth.sessions/auth.refresh_tokens depending on this project's
-- Supabase Auth schema version, whereas the Dashboard/Admin API cleans up GoTrue's internal
-- state properly. If you'd rather not click through the dashboard, the 5 UUIDs are in
-- seed.sql (lines 40/46/52/58/64) and can be deleted with supabaseAdmin.auth.admin.deleteUser()
-- via the now-working service-role key instead.
-- ============================================================

DO $wipe$
DECLARE
  cid UUID;
BEGIN
  SELECT id INTO cid FROM clients WHERE company_name = 'Axiotta Risk Management Pvt Ltd' LIMIT 1;
  IF cid IS NULL THEN
    RAISE NOTICE 'No client named Axiotta Risk Management Pvt Ltd found — nothing to wipe.';
    RETURN;
  END IF;

  -- Audit-trail / leaf tables, scoped via debtors.client_id.
  DELETE FROM settlement_requests WHERE debtor_id IN (SELECT id FROM debtors WHERE client_id = cid);
  DELETE FROM disputes            WHERE debtor_id IN (SELECT id FROM debtors WHERE client_id = cid);
  DELETE FROM payments            WHERE debtor_id IN (SELECT id FROM debtors WHERE client_id = cid);
  DELETE FROM messages            WHERE debtor_id IN (SELECT id FROM debtors WHERE client_id = cid);
  -- Ad-hoc call_logs rows (debtor_id IS NULL, Manual Dial — see
  -- migrations/20260731_call_logs_adhoc_contacts.sql) have no client_id of their own, but
  -- they DO carry agent_id — scoping by debtor_id alone left them behind and then blocked
  -- deleting agents with "violates foreign key constraint call_logs_agent_id_fkey". Catch
  -- both shapes here.
  DELETE FROM call_logs WHERE debtor_id IN (SELECT id FROM debtors WHERE client_id = cid)
                           OR agent_id IN (SELECT id FROM agents WHERE client_id = cid);

  -- Junction + client_id-scoped tables added by migrations rather than schema.sql (teams,
  -- team_agents, notifications, escalations, reminders, mapping_templates, agent_portfolios).
  -- The live database has previously drifted from what's in the migration files (confirmed
  -- separately — agent_portfolios errored "relation does not exist" on a first run of this
  -- script), so each is guarded with an existence check rather than assumed present.
  IF to_regclass('public.agent_portfolios') IS NOT NULL THEN
    DELETE FROM agent_portfolios WHERE agent_id IN (SELECT id FROM agents WHERE client_id = cid)
                                    OR portfolio_id IN (SELECT id FROM portfolios WHERE client_id = cid);
  END IF;
  IF to_regclass('public.team_agents') IS NOT NULL THEN
    DELETE FROM team_agents WHERE team_id IN (SELECT id FROM teams WHERE client_id = cid);
  END IF;
  IF to_regclass('public.reminders') IS NOT NULL THEN
    DELETE FROM reminders WHERE client_id = cid;
  END IF;
  IF to_regclass('public.escalations') IS NOT NULL THEN
    DELETE FROM escalations WHERE client_id = cid;
  END IF;
  IF to_regclass('public.notifications') IS NOT NULL THEN
    DELETE FROM notifications WHERE client_id = cid;
  END IF;
  IF to_regclass('public.mapping_templates') IS NOT NULL THEN
    DELETE FROM mapping_templates WHERE client_id = cid;
  END IF;

  -- Core schema.sql tables — always present.
  DELETE FROM debtors    WHERE client_id = cid;
  DELETE FROM portfolios WHERE client_id = cid;
  IF to_regclass('public.teams') IS NOT NULL THEN
    DELETE FROM teams WHERE client_id = cid;
  END IF;
  DELETE FROM agents WHERE client_id = cid;
  DELETE FROM clients WHERE id = cid;

  RAISE NOTICE 'Wiped all data for client %', cid;
END $wipe$;
