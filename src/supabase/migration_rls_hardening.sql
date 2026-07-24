-- ============================================================
-- DRAFT — RLS hardening: intra-tenant role + ownership scoping
-- ============================================================
--
-- ⚠️  REVIEW BEFORE RUNNING. Test in a Supabase *staging* project first and
--     confirm every app flow (agent logging calls, manager upload/assign,
--     admin user management) still works. This DROPs and REPLACEs the current
--     "FOR ALL USING (client_id = auth_client_id())" policies.
--
-- WHY: today's policies only isolate one CLIENT (tenant) from another. Within a
-- client, ANY authenticated user can read/update/delete ALL agents, debtors,
-- call_logs and payments via the anon key + their session — role (agent/manager/
-- admin) and per-agent ownership are enforced only in the browser. This migration
-- moves those rules into the database.
--
-- KNOWN LIMITATION: RLS is row-level, not column-level. It cannot stop a user who
-- already has UPDATE on a row from changing a specific column (e.g. an agent
-- flipping their own agents.role to 'admin'). Preventing that needs either column
-- GRANTs or a BEFORE UPDATE trigger — see the trigger at the end.

-- ── Helper functions (SECURITY DEFINER = bypass RLS, no recursion) ─────────────
-- auth_client_id() already exists in schema.sql. Add role + agent-id resolvers.

CREATE OR REPLACE FUNCTION auth_role() RETURNS TEXT
  LANGUAGE sql STABLE SECURITY DEFINER
  AS $$ SELECT role FROM agents WHERE auth_user_id = auth.uid() LIMIT 1 $$;

CREATE OR REPLACE FUNCTION auth_agent_id() RETURNS UUID
  LANGUAGE sql STABLE SECURITY DEFINER
  AS $$ SELECT id FROM agents WHERE auth_user_id = auth.uid() LIMIT 1 $$;

CREATE OR REPLACE FUNCTION auth_is_privileged() RETURNS BOOLEAN
  LANGUAGE sql STABLE SECURITY DEFINER
  AS $$ SELECT auth_role() IN ('manager', 'admin') $$;

-- ── agents ─────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "agents_own_client" ON agents;

-- Everyone in the client may READ the roster (team lists, leaderboards).
CREATE POLICY "agents_select" ON agents FOR SELECT
  USING (client_id = auth_client_id());

-- Only managers/admins may create / modify / remove agents.
CREATE POLICY "agents_write_privileged" ON agents FOR INSERT
  WITH CHECK (client_id = auth_client_id() AND auth_is_privileged());
CREATE POLICY "agents_update_privileged" ON agents FOR UPDATE
  USING (client_id = auth_client_id() AND auth_is_privileged())
  WITH CHECK (client_id = auth_client_id());
CREATE POLICY "agents_delete_privileged" ON agents FOR DELETE
  USING (client_id = auth_client_id() AND auth_is_privileged());

-- ── portfolios ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "portfolios_own_client" ON portfolios;
CREATE POLICY "portfolios_select" ON portfolios FOR SELECT
  USING (client_id = auth_client_id());
CREATE POLICY "portfolios_write_privileged" ON portfolios FOR INSERT
  WITH CHECK (client_id = auth_client_id() AND auth_is_privileged());
CREATE POLICY "portfolios_update_privileged" ON portfolios FOR UPDATE
  USING (client_id = auth_client_id() AND auth_is_privileged())
  WITH CHECK (client_id = auth_client_id());
CREATE POLICY "portfolios_delete_privileged" ON portfolios FOR DELETE
  USING (client_id = auth_client_id() AND auth_is_privileged());

-- ── debtors ─────────────────────────────────────────────────────────────────
-- Agents see + update only their assigned accounts; managers/admins see all.
DROP POLICY IF EXISTS "debtors_own_client" ON debtors;
CREATE POLICY "debtors_select" ON debtors FOR SELECT
  USING (client_id = auth_client_id()
         AND (auth_is_privileged() OR assigned_agent_id = auth_agent_id()));
CREATE POLICY "debtors_update" ON debtors FOR UPDATE
  USING (client_id = auth_client_id()
         AND (auth_is_privileged() OR assigned_agent_id = auth_agent_id()))
  WITH CHECK (client_id = auth_client_id());
-- Bulk import / reassignment / deletion is manager/admin only.
CREATE POLICY "debtors_insert_privileged" ON debtors FOR INSERT
  WITH CHECK (client_id = auth_client_id() AND auth_is_privileged());
CREATE POLICY "debtors_delete_privileged" ON debtors FOR DELETE
  USING (client_id = auth_client_id() AND auth_is_privileged());

-- ── call_logs — append-only audit trail ───────────────────────────────────────
-- Anyone in the client can read; an agent may INSERT only as themselves; NOBODY
-- may UPDATE/DELETE through the anon key (corrections go through the service role).
DROP POLICY IF EXISTS "call_logs_own_client" ON call_logs;
CREATE POLICY "call_logs_select" ON call_logs FOR SELECT
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY "call_logs_insert" ON call_logs FOR INSERT
  WITH CHECK (
    debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id())
    AND (agent_id = auth_agent_id() OR auth_is_privileged())
  );
-- (no UPDATE / DELETE policy => denied for all non-service-role callers)

-- ── payments — append-only audit trail ────────────────────────────────────────
DROP POLICY IF EXISTS "payments_own_client" ON payments;
CREATE POLICY "payments_select" ON payments FOR SELECT
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY "payments_insert" ON payments FOR INSERT
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
-- (no UPDATE / DELETE => denied)

-- ── messages / disputes / settlement_requests ────────────────────────────────
-- Read within client; insert within client; settlement APPROVAL stays privileged.
DROP POLICY IF EXISTS "messages_own_client" ON messages;
CREATE POLICY "messages_select" ON messages FOR SELECT
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY "messages_insert" ON messages FOR INSERT
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

DROP POLICY IF EXISTS "disputes_own_client" ON disputes;
CREATE POLICY "disputes_select" ON disputes FOR SELECT
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY "disputes_insert" ON disputes FOR INSERT
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY "disputes_update_privileged" ON disputes FOR UPDATE
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()) AND auth_is_privileged())
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

DROP POLICY IF EXISTS "settlements_own_client" ON settlement_requests;
CREATE POLICY "settlements_select" ON settlement_requests FOR SELECT
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
CREATE POLICY "settlements_insert" ON settlement_requests FOR INSERT
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));
-- Approve / reject is manager/admin only.
CREATE POLICY "settlements_update_privileged" ON settlement_requests FOR UPDATE
  USING (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()) AND auth_is_privileged())
  WITH CHECK (debtor_id IN (SELECT id FROM debtors WHERE client_id = auth_client_id()));

-- ── Column-level guard: prevent self role-escalation ──────────────────────────
-- RLS can't restrict WHICH columns an UPDATE touches, so block non-admins from
-- changing an agent's role or client_id via a trigger.
CREATE OR REPLACE FUNCTION protect_agent_privileged_columns() RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF (NEW.role IS DISTINCT FROM OLD.role OR NEW.client_id IS DISTINCT FROM OLD.client_id)
     AND auth_role() <> 'admin' THEN
    RAISE EXCEPTION 'Only an admin may change an agent role or client';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_agent_columns ON agents;
CREATE TRIGGER trg_protect_agent_columns
  BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION protect_agent_privileged_columns();
