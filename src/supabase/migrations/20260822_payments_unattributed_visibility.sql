-- ══════════════════════════════════════════════════════════════════════════════
-- Make bank-reported payments (agent_id IS NULL) readable by the people who create them.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- applyBulkPaidFile() (src/lib/portfolio-store.ts) inserts the bank's daily paid-status file
-- as payments rows with agent_id = NULL and source = 'bank_reported' — deliberately credited
-- to no agent, since nobody's call caused the payment.
--
-- The live payments_select (still the 20260814 version — 20260821 applied only partially,
-- see below) reads:
--
--       auth_role() = 'admin'
--    OR agent_id = (SELECT id FROM agents WHERE auth_user_id = auth.uid())
--    OR (auth_role() = 'manager' AND agent_id IN (SELECT ta.agent_id FROM team_agents ...))
--
-- With agent_id NULL, `NULL = ...` and `NULL IN (...)` both evaluate to NULL — not TRUE — so
-- the row fails the policy for every non-admin. The manager who uploaded the paid file could
-- INSERT those rows (payments_insert scopes by debtor_id only) and then could not SELECT a
-- single one of them back. That is the main reason an uploaded paid file appeared to vanish:
-- it was written correctly and was simply invisible to its own author.
--
-- ── Why this file is deliberately minimal ────────────────────────────────────
--
-- A catalog dump of the live project (2026-08-22) showed auth_agent_id, auth_client_id,
-- auth_role, auth_visible_agent_ids and auth_visible_portfolio_ids ALL already present, all
-- plpgsql, all with the expected return types — and agents/debtors/portfolios already on the
-- helper-based 20260821 policies. Only auth_client_debtor_ids() was missing, which is why the
-- first attempt at this file died with:
--
--     ERROR: 42883: function auth_client_debtor_ids() does not exist
--
-- So 20260821 got as far as auth_visible_portfolio_ids() and aborted before the helper that
-- follows it — leaving payments_select behind on the older definition.
--
-- This file therefore CREATEs only the two functions that do not exist and REPLACEs only
-- payments_select. It does not touch auth_agent_id / auth_client_id / auth_role /
-- auth_visible_agent_ids / auth_visible_portfolio_ids, and it does not touch any policy on
-- agents, debtors, portfolios, call_logs, teams or team_agents.
--
-- That containment is the safety property that matters: sign-in reads `agents` (see
-- getMyAgentRow in src/lib/supabase.ts) under agents_select, which depends on
-- auth_client_id/auth_role/auth_visible_agent_ids — none of which this file redefines. There
-- is no path by which applying this can break login. The worst case is that payments queries
-- misbehave, and the rollback at the bottom restores the previous policy verbatim.
--
-- No BEGIN/COMMIT: the runner (and the Supabase SQL Editor) supplies its own transaction.

-- ── 1. The one missing 20260821 helper ───────────────────────────────────────
-- "Which debtors belong to my client": lets the downstream tables scope by tenant without
-- reading `debtors` (and therefore debtors_select) directly.
-- plpgsql, NOT sql: Postgres inlines simple SQL functions, which discards SECURITY DEFINER
-- and reintroduces the 42P17 recursion. See CLAUDE.md.
CREATE OR REPLACE FUNCTION auth_client_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY SELECT id FROM debtors WHERE client_id = auth_client_id();
  END; $$;

-- ── 2. New helper ────────────────────────────────────────────────────────────
-- "Which debtors can I see": the debtors under my visible portfolios, plus any assigned
-- directly to me. SECURITY DEFINER + row_security = off for the WHOLE body, so neither its
-- own reads nor auth_visible_portfolio_ids()'s ever re-enter debtors_select or
-- portfolios_select — the cross-table cycle that 20260817 had to untangle.
CREATE OR REPLACE FUNCTION auth_visible_debtor_ids() RETURNS SETOF UUID
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  SET row_security = off
  AS $$
  BEGIN
    RETURN QUERY
    SELECT id FROM debtors WHERE portfolio_id IN (SELECT auth_visible_portfolio_ids())
    UNION
    SELECT id FROM debtors WHERE assigned_agent_id = auth_agent_id();
  END; $$;

-- ── 3. payments_select ───────────────────────────────────────────────────────
-- Brings payments onto the helper-based form the other tables already use (no direct reads of
-- agents/debtors/team_agents from inside the policy), and adds the unattributed-payment
-- clause. An unattributed payment is visible to whoever can see the DEBTOR it is against —
-- the managing manager, or the agent the account is assigned to. Attributed payments keep
-- exactly the semantics they have today; nothing here widens agent-to-agent visibility.
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
  USING (
    (debtor_id IS NULL OR debtor_id IN (SELECT auth_client_debtor_ids()))
    AND (
      auth_role() = 'admin'
      OR agent_id = auth_agent_id()
      OR (auth_role() = 'manager' AND agent_id IN (SELECT auth_visible_agent_ids()))
      -- New: unattributed (bank-reported) payments, scoped by the debtor instead of the agent.
      OR (agent_id IS NULL AND debtor_id IN (SELECT auth_visible_debtor_ids()))
    )
  );

-- ── 4. Drop stale cached plans ───────────────────────────────────────────────
-- CREATE OR REPLACE FUNCTION and a replaced policy can leave pooled PostgREST connections
-- holding plans compiled against the OLD definitions — which shows up as inconsistent 500s
-- that "go away on their own" and sent an earlier debugging round chasing the wrong table.
-- Cheap and safe to do unconditionally. See scripts/debug/rls-smoke-test.sql.
NOTIFY pgrst, 'reload schema';
DISCARD PLANS;

-- ── Rollback ─────────────────────────────────────────────────────────────────
-- If payments reads misbehave, this restores the exact policy that was live before, as
-- captured from the catalog on 2026-08-22. The two functions above can be left in place;
-- nothing else references them once this runs.
--
--   DROP POLICY IF EXISTS payments_select ON payments;
--   CREATE POLICY payments_select ON payments FOR SELECT TO authenticated
--     USING (
--       ((debtor_id IS NULL) OR (debtor_id IN (
--          SELECT debtors.id FROM debtors WHERE (debtors.client_id = auth_client_id()))))
--       AND ((auth_role() = 'admin'::text)
--         OR (agent_id = (SELECT agents.id FROM agents WHERE (agents.auth_user_id = auth.uid())))
--         OR ((auth_role() = 'manager'::text) AND (agent_id IN (
--              SELECT ta.agent_id FROM (team_agents ta JOIN teams t ON ((t.id = ta.team_id)))
--              WHERE (t.manager_id = (SELECT agents.id FROM agents
--                                     WHERE (agents.auth_user_id = auth.uid())))))))
--     );
