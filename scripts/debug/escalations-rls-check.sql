-- Tighten escalation visibility to the manager who actually owns the agent.
--
-- Reported 2026-08-22: every manager sees every other team's escalations. The client-side
-- half is fixed (getOpenEscalationsForAgents scopes My Queue and its badge), but that only
-- hides rows the browser has ALREADY been sent. The rows still cross the wire, so this is the
-- half that matters for real separation.
--
-- Two tables are involved and only one of them is in this repo:
--
--   ptp_escalations   migrations/20260811_ptp_escalations.sql. Its policy is deliberately
--                     client-wide, and says so: "any agent/manager/admin in the company can
--                     read ... doesn't need the tighter per-team scoping call_logs has". That
--                     was a considered decision for a dedupe signal, not an oversight — it is
--                     listed here so the choice is re-made knowingly rather than by accident.
--
--   escalations       what escalation-store.ts actually reads, and the table behind My Queue.
--                     It has NO migration anywhere in this repo and is absent from schema.sql,
--                     so it was created directly against the live project and its policy is
--                     unknown from source. STEP 1 reads it out.

-- ── STEP 1: what exists today. Read-only. Run this and paste the result back. ─────────────
SELECT 'rls enabled' AS item,
       c.relname || ' = ' || c.relrowsecurity::text AS detail
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('escalations', 'ptp_escalations')
UNION ALL
SELECT 'policy: ' || c.relname || '.' || pol.polname,
       pg_get_expr(pol.polqual, pol.polrelid)
FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
WHERE c.relname IN ('escalations', 'ptp_escalations')
UNION ALL
SELECT 'column: escalations.' || column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'escalations'
ORDER BY 1;

-- ── STEP 2: the intended policy. Do NOT run until STEP 1 confirms the column names. ───────
--
-- "Visible to the agent who raised it, to a manager the raising agent reports to, and to an
-- admin" — the same shape call_logs and payments already use, via auth_visible_agent_ids().
-- That helper returns the caller's own id plus, for a manager, every agent on the teams they
-- manage; so this is exactly "the manager above that agent".
--
-- Assumes escalations.agent_id is a UUID referencing agents(id), which STEP 1 will confirm.
-- If it turns out to store an email instead, the middle clause needs
-- `agent_id IN (SELECT email FROM agents WHERE id IN (SELECT auth_visible_agent_ids()))`.
--
-- DROP POLICY IF EXISTS escalations_select ON escalations;
-- CREATE POLICY escalations_select ON escalations FOR SELECT TO authenticated
--   USING (
--     (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
--     AND (
--       auth_role() = 'admin'
--       OR agent_id = auth_agent_id()
--       OR agent_id IN (SELECT auth_visible_agent_ids())
--     )
--   );
--
-- NOTIFY pgrst, 'reload schema';
--
-- Requires auth_client_debtor_ids(), created by
-- migrations/20260822_payments_unattributed_visibility.sql. That has been applied.

-- ── STEP 3: verify. Should return only escalations raised by your own agents. ─────────────
-- SELECT e.id, e.reason, a.name AS raised_by
-- FROM escalations e LEFT JOIN agents a ON a.id = e.agent_id
-- ORDER BY e.created_at DESC LIMIT 20;
