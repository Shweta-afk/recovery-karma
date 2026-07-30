-- Harden row-level security.
--
-- Verified against the live database on 2026-07-30 using ONLY the public anon key
-- (the one compiled into the client bundle, so effectively public):
--
--   GET /rest/v1/debtors     -> 206, content-range 0-0/1440   *** full debtor PII ***
--   GET /rest/v1/agents      -> 206, content-range 0-0/7
--   GET /rest/v1/portfolios  -> 206, content-range 0-0/6
--   POST /rest/v1/debtors {} -> 23502 not-null violation  (i.e. NOT blocked by RLS)
--   POST /rest/v1/agents  {} -> 23502 not-null violation  (i.e. NOT blocked by RLS)
--   POST /rest/v1/payments{} -> 401 row-level security     (correctly blocked)
--
-- So debtors/agents/portfolios were readable AND writable by anyone holding the anon
-- key. Impact: 1440 debtors' names, phone numbers, emails, loan amounts and balances
-- were publicly readable, and `agents.role` was publicly writable — meaning anyone
-- could grant themselves 'admin'. Route-level admin checks are client-side only
-- (src/routes/admin.tsx), so RLS is the only real enforcement boundary.
--
-- schema.sql declares correct-looking policies, so the live database has diverged from
-- it — either extra permissive policies were added or RLS was disabled on those tables.
-- This migration is therefore authoritative: it drops every existing policy on these
-- tables and rebuilds them, rather than assuming the declared set is what is deployed.

-- ────────────────────────────────────────────────────────────
-- 1. Helper functions
-- ────────────────────────────────────────────────────────────

-- SECURITY DEFINER without a pinned search_path lets a caller who can create objects in
-- a schema earlier on the path shadow `agents` and make this function return anything.
-- Pin it. (The original in schema.sql omits this.)
CREATE OR REPLACE FUNCTION auth_client_id() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT client_id FROM agents WHERE auth_user_id = auth.uid() LIMIT 1
  $$;

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT role FROM agents WHERE auth_user_id = auth.uid() LIMIT 1
  $$;

-- ────────────────────────────────────────────────────────────
-- 2. Revoke the anon role entirely
-- ────────────────────────────────────────────────────────────
-- Nothing in this app talks to PostgREST before sign-in: login goes through GoTrue
-- (supabase.auth.*), after which the JWT carries role=authenticated. The anon role
-- therefore needs no table access at all, and removing it means a future policy
-- mistake cannot re-expose data to unauthenticated callers.

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;

-- ────────────────────────────────────────────────────────────
-- 3. Force RLS and clear whatever policies are actually deployed
-- ────────────────────────────────────────────────────────────
-- FORCE also applies RLS to the table owner, so a mistakenly-owner-privileged
-- connection cannot bypass these policies.

DO $$
DECLARE
  t TEXT;
  p TEXT;
  tables TEXT[] := ARRAY[
    'clients','agents','portfolios','debtors','call_logs',
    'messages','payments','disputes','settlement_requests'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    FOR p IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t
    LOOP
      EXECUTE format('DROP POLICY %I ON %I', p, t);
    END LOOP;
  END LOOP;
END $$;

-- ────────────────────────────────────────────────────────────
-- 4. Policies — authenticated users only, scoped to their client
-- ────────────────────────────────────────────────────────────
-- Every policy carries an explicit WITH CHECK on write commands so a row can never be
-- inserted or moved into another tenant. `FOR ALL USING (...)` alone was the original
-- shape; it is easy to misread and leaves INSERT intent implicit.

-- clients: read-only, own row
CREATE POLICY clients_select ON clients FOR SELECT TO authenticated
  USING (id = auth_client_id());

-- agents: everyone in the client can see colleagues; only admins may create/remove.
-- Self-service updates are allowed but role/client_id changes are blocked by the
-- trigger in section 5 (a policy cannot compare OLD to NEW).
CREATE POLICY agents_select ON agents FOR SELECT TO authenticated
  USING (client_id = auth_client_id());
CREATE POLICY agents_insert ON agents FOR INSERT TO authenticated
  WITH CHECK (client_id = auth_client_id() AND auth_role() = 'admin');
CREATE POLICY agents_update ON agents FOR UPDATE TO authenticated
  USING (client_id = auth_client_id() AND (auth_role() = 'admin' OR auth_user_id = auth.uid()))
  WITH CHECK (client_id = auth_client_id());
CREATE POLICY agents_delete ON agents FOR DELETE TO authenticated
  USING (client_id = auth_client_id() AND auth_role() = 'admin');

-- portfolios: all staff read; managers/admins write
CREATE POLICY portfolios_select ON portfolios FOR SELECT TO authenticated
  USING (client_id = auth_client_id());
CREATE POLICY portfolios_write ON portfolios FOR ALL TO authenticated
  USING (client_id = auth_client_id() AND auth_role() IN ('admin','manager'))
  WITH CHECK (client_id = auth_client_id() AND auth_role() IN ('admin','manager'));

-- debtors: agents read and update within their client, but may not delete
CREATE POLICY debtors_select ON debtors FOR SELECT TO authenticated
  USING (client_id = auth_client_id());
CREATE POLICY debtors_insert ON debtors FOR INSERT TO authenticated
  WITH CHECK (client_id = auth_client_id() AND auth_role() IN ('admin','manager'));
CREATE POLICY debtors_update ON debtors FOR UPDATE TO authenticated
  USING (client_id = auth_client_id())
  WITH CHECK (client_id = auth_client_id());
-- admin AND manager: deleting a portfolio cascades to its debtors in application code
-- (portfolio-store.deletePortfolio), and managers may delete portfolios.
CREATE POLICY debtors_delete ON debtors FOR DELETE TO authenticated
  USING (client_id = auth_client_id() AND auth_role() IN ('admin','manager'));

-- Child tables: scoped through the parent debtor's client.
-- call_logs, messages, payments and disputes are an audit trail — no UPDATE or DELETE
-- for anyone, so a compromised agent account cannot rewrite collection history.
CREATE POLICY call_logs_select ON call_logs FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY call_logs_insert ON call_logs FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

CREATE POLICY messages_select ON messages FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY messages_insert ON messages FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY payments_insert ON payments FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

CREATE POLICY disputes_select ON disputes FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY disputes_insert ON disputes FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
-- Disputes change state (open -> resolved/escalated), so updates are allowed.
CREATE POLICY disputes_update ON disputes FOR UPDATE TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()))
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

CREATE POLICY settlements_select ON settlement_requests FOR SELECT TO authenticated
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY settlements_insert ON settlement_requests FOR INSERT TO authenticated
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
-- Only managers/admins may approve or reject a settlement.
CREATE POLICY settlements_update ON settlement_requests FOR UPDATE TO authenticated
  USING (
    debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
    AND auth_role() IN ('admin','manager')
  )
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

-- ────────────────────────────────────────────────────────────
-- 5. Block privilege escalation on agents
-- ────────────────────────────────────────────────────────────
-- agents_update lets a user edit their own row (name, phone). Without this trigger they
-- could also set role='admin' or move themselves to another client_id, because an RLS
-- policy cannot compare the old row to the new one.

CREATE OR REPLACE FUNCTION agents_guard_privileged_columns() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  BEGIN
    IF auth.uid() IS NULL THEN      -- service-role / server-side jobs
      RETURN NEW;
    END IF;
    IF NEW.role IS DISTINCT FROM OLD.role AND auth_role() <> 'admin' THEN
      RAISE EXCEPTION 'only an admin may change an agent role';
    END IF;
    IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
      RAISE EXCEPTION 'agent client_id is immutable';
    END IF;
    IF NEW.auth_user_id IS DISTINCT FROM OLD.auth_user_id THEN
      RAISE EXCEPTION 'agent auth_user_id is immutable';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS agents_guard_privileged_columns_trg ON agents;
CREATE TRIGGER agents_guard_privileged_columns_trg
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION agents_guard_privileged_columns();
