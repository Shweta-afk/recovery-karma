-- Fixes a cross-tenant data leak in profilex_usage_by_user (20260826_profilex_usage_by_user.sql):
-- that function's own doc comment claims "SECURITY INVOKER, so debtor_traces' own policy still
-- scopes this" (an admin sees their client, a manager only their team), but getProfilexUsage()
-- in profilex-actions.server.ts called it through the SERVICE-ROLE admin client — service_role
-- has BYPASSRLS, so SECURITY INVOKER runs as service_role and debtor_traces_select never fires
-- at all. Every manager/admin viewing Admin -> Reports -> Insights was seeing EVERY client's
-- ProfileX usage on the platform, not just their own.
--
-- No SQL change is needed here to fix that specific bug — the fix is calling these RPCs as the
-- real caller (their own JWT, RLS-scoped) instead of as service_role, done in
-- profilex-actions.server.ts. This migration only adds the new detail-level report the fix
-- exposed: profilex_usage_by_user aggregates by agent+service, with no way to see WHICH debtor
-- an agent looked up. profilex_usage_detail below returns one row per debtor_traces entry, so
-- "where did an agent use Insights" has an actual answer.
--
-- SECURITY INVOKER + no client_id/agent filter here on purpose: relies entirely on
-- debtor_traces_select's and debtors_select's existing RLS (client_id = auth_client_id() AND
-- debtor_id IN auth_my_debtor_ids()/auth_visible_debtor_ids()) to scope this exactly the same
-- way every other debtor-facing read in the app already is. Called as the real caller (see
-- profilex-actions.server.ts), never through the service-role client.
CREATE OR REPLACE FUNCTION profilex_usage_detail(
  p_since  TIMESTAMPTZ,
  p_limit  INT DEFAULT 200,
  p_offset INT DEFAULT 0
)
  RETURNS TABLE (
    trace_id        UUID,
    created_at      TIMESTAMPTZ,
    agent_name      TEXT,
    agent_email     TEXT,
    debtor_id       UUID,
    debtor_name     TEXT,
    loan_reference  TEXT,
    service_id      TEXT,
    provider_status TEXT,
    billable        BOOLEAN,
    cost            NUMERIC,
    state           TEXT
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    SELECT
      t.id                                AS trace_id,
      t.created_at,
      COALESCE(a.name, 'Unknown')::text   AS agent_name,
      COALESCE(a.email, '')::text         AS agent_email,
      t.debtor_id,
      COALESCE(d.name, 'Unknown')::text   AS debtor_name,
      COALESCE(d.loan_reference, '')::text AS loan_reference,
      t.service_id::text,
      t.provider_status,
      t.billable,
      t.cost,
      t.state
    FROM debtor_traces t
    LEFT JOIN agents a  ON a.id = t.requested_by
    LEFT JOIN debtors d ON d.id = t.debtor_id
    WHERE t.created_at >= p_since
    ORDER BY t.created_at DESC
    LIMIT p_limit OFFSET p_offset
  $$;
