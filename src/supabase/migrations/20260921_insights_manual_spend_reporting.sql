-- Fold Admin > Insights manual lookups (insights_manual_lookups, 20260921_insights_manual_lookups.sql)
-- into the Insights reports that used to read debtor_traces alone.
--
-- All three report functions stay SECURITY INVOKER and are called as the real caller, so RLS
-- scopes them: insights_manual_lookups_select is admin-only for the caller's own client, which
-- means an admin's totals now include their manual lookups and a manager's (team-scoped) totals
-- do not. Do NOT switch any of these to DEFINER.
--
-- A manual lookup has no debtor, so in the detail log it appears with debtor_id NULL, the name
-- "Manual lookup" and the value that was typed in the loan-reference column. Return shapes are
-- unchanged, hence no UI change is needed for the tables to pick these rows up.

CREATE OR REPLACE FUNCTION profilex_spend_report(p_since TIMESTAMPTZ)
  RETURNS TABLE (
    service_id  TEXT,
    calls       BIGINT,
    hits        BIGINT,
    misses      BIGINT,
    failures    BIGINT,
    spend       NUMERIC
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    WITH t AS (
      SELECT service_id, provider_status, billable, state, cost, created_at FROM debtor_traces
      UNION ALL
      SELECT service_id, provider_status, billable, state, cost, created_at FROM insights_manual_lookups
    )
    SELECT
      t.service_id::text,
      count(*)                                                        AS calls,
      count(*) FILTER (WHERE t.provider_status = '1')                 AS hits,
      count(*) FILTER (WHERE t.billable AND t.provider_status <> '1') AS misses,
      count(*) FILTER (WHERE t.state = 'failed')                      AS failures,
      COALESCE(SUM(t.cost), 0)                                        AS spend
    FROM t
    WHERE t.created_at >= p_since
    GROUP BY t.service_id
    ORDER BY spend DESC;
  $$;

-- The month total. DEFINER + service_role only, keyed on an explicit client, as before.
CREATE OR REPLACE FUNCTION profilex_month_spend(p_client_id UUID, p_since TIMESTAMPTZ)
  RETURNS NUMERIC
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
  DECLARE total NUMERIC;
  BEGIN
    SELECT COALESCE(SUM(c), 0) INTO total FROM (
      SELECT cost AS c FROM debtor_traces
        WHERE client_id = p_client_id AND created_at >= p_since
      UNION ALL
      SELECT cost FROM insights_manual_lookups
        WHERE client_id = p_client_id AND created_at >= p_since
    ) s;
    RETURN total;
  END; $$;

REVOKE ALL ON FUNCTION profilex_month_spend(UUID, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION profilex_month_spend(UUID, TIMESTAMPTZ) TO service_role;

CREATE OR REPLACE FUNCTION profilex_usage_by_user(p_since TIMESTAMPTZ)
  RETURNS TABLE (
    agent_id        UUID,
    agent_name      TEXT,
    agent_email     TEXT,
    agent_role      TEXT,
    service_id      TEXT,
    lookups         BIGINT,
    hits            BIGINT,
    misses          BIGINT,
    failures        BIGINT,
    cached_reuses   BIGINT,
    debtors_touched BIGINT,
    spend           NUMERIC,
    last_used       TIMESTAMPTZ
  )
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
  AS $$
    WITH t AS (
      SELECT requested_by, service_id, provider_status, billable, state, cost, created_at, debtor_id
        FROM debtor_traces
      UNION ALL
      SELECT requested_by, service_id, provider_status, billable, state, cost, created_at, NULL::uuid
        FROM insights_manual_lookups
    )
    SELECT
      t.requested_by                                                   AS agent_id,
      COALESCE(a.name, 'Unknown')::text                                AS agent_name,
      COALESCE(a.email, '')::text                                      AS agent_email,
      COALESCE(a.role, '')::text                                       AS agent_role,
      t.service_id::text,
      count(*)                                                         AS lookups,
      count(*) FILTER (WHERE t.provider_status = '1')                  AS hits,
      count(*) FILTER (WHERE t.billable AND t.provider_status IS DISTINCT FROM '1') AS misses,
      count(*) FILTER (WHERE t.state = 'failed')                       AS failures,
      count(*) FILTER (WHERE t.state = 'done' AND NOT t.billable)      AS cached_reuses,
      count(DISTINCT t.debtor_id)                                      AS debtors_touched,
      COALESCE(sum(t.cost), 0)                                         AS spend,
      max(t.created_at)                                                AS last_used
    FROM t
    LEFT JOIN agents a ON a.id = t.requested_by
    WHERE t.created_at >= p_since
    GROUP BY t.requested_by, a.name, a.email, a.role, t.service_id
    ORDER BY spend DESC, lookups DESC;
  $$;

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
    WITH t AS (
      SELECT id, created_at, requested_by, debtor_id, NULL::text AS manual_value,
             service_id, provider_status, billable, cost, state
        FROM debtor_traces
      UNION ALL
      SELECT id, created_at, requested_by, NULL::uuid, query_key,
             service_id, provider_status, billable, cost, state
        FROM insights_manual_lookups
    )
    SELECT
      t.id                                AS trace_id,
      t.created_at,
      COALESCE(a.name, 'Unknown')::text   AS agent_name,
      COALESCE(a.email, '')::text         AS agent_email,
      t.debtor_id,
      CASE WHEN t.manual_value IS NOT NULL THEN 'Manual lookup'
           ELSE COALESCE(d.name, 'Unknown') END::text AS debtor_name,
      COALESCE(t.manual_value, d.loan_reference, '')::text AS loan_reference,
      t.service_id::text,
      t.provider_status,
      t.billable,
      t.cost,
      t.state
    FROM t
    LEFT JOIN agents a  ON a.id = t.requested_by
    LEFT JOIN debtors d ON d.id = t.debtor_id
    WHERE t.created_at >= p_since
    ORDER BY t.created_at DESC
    LIMIT p_limit OFFSET p_offset
  $$;
