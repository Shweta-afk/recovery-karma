-- Superadmin usage totals, summed in the database (2026-10-09).
--
-- The superadmin Overview / Companies / company-detail / Revenue pages used to page every
-- call_logs, debtor_traces and insights_manual_lookups row of the period into the server and
-- add them up there (src/lib/platform-usage.server.ts). That grows with call volume; this
-- returns the sums instead — a few rows per agent and per lookup kind, whatever the volume.
--
-- Returns one jsonb:
--   calls:   per (agent, company, period) — calls, contacts, talk seconds, latest call
--   lookups: per (company, requested_by, period, service, provider status, failed?, billable)
--            — count, sum of what the company was charged, latest lookup. Grouped that finely
--            because "what ProfileX actually bills" is priced per service AND per status in
--            src/lib/profilex/catalogue.ts (priceFor); the server prices each group there, so
--            the rate card stays in one place instead of being copied into SQL.
--   daily:   per IST day of the CURRENT period — calls (with a company) and lookups.
-- "period" is current = [p_since, p_until), previous = [p_prev_since, p_since).
--
-- A contact is any logged outcome other than no_answer / voicemail — the same rule as
-- NON_CONTACT_OUTCOMES in src/lib/platform-usage.ts; change both together.
--
-- Feature usage ONLY. Deliberately reads no payments, promise amounts or anything a company
-- collected (product decision, 2026-10-09).
--
-- Cross-company data, so server-only: SECURITY INVOKER and executable by service_role alone
-- (it bypasses RLS). Company users get no EXECUTE — an RLS-scoped caller would only see its
-- own rows anyway, but there is no reason to expose it. The server falls back to summing rows
-- itself if this function is missing, so code can deploy ahead of the migration.

CREATE OR REPLACE FUNCTION public.superadmin_usage_totals(
  p_prev_since TIMESTAMPTZ,
  p_since      TIMESTAMPTZ,
  p_until      TIMESTAMPTZ,
  p_client_id  UUID DEFAULT NULL
)
  RETURNS JSONB
  LANGUAGE sql STABLE SECURITY INVOKER
  SET search_path = public, pg_temp
AS $$
  WITH calls AS (
    SELECT cl.agent_id,
           a.client_id,
           cl.created_at,
           cl.outcome,
           cl.duration_seconds,
           cl.created_at >= p_since AS is_current
      FROM call_logs cl
      LEFT JOIN agents a ON a.id = cl.agent_id
     WHERE cl.created_at >= p_prev_since
       AND cl.created_at <  p_until
       AND (p_client_id IS NULL OR a.client_id = p_client_id)
  ),
  lookups AS (
    SELECT client_id, requested_by, service_id, provider_status, state, billable, cost,
           created_at, created_at >= p_since AS is_current
      FROM debtor_traces
     WHERE created_at >= p_prev_since AND created_at < p_until
       AND (p_client_id IS NULL OR client_id = p_client_id)
    UNION ALL
    SELECT client_id, requested_by, service_id, provider_status, state, billable, cost,
           created_at, created_at >= p_since AS is_current
      FROM insights_manual_lookups
     WHERE created_at >= p_prev_since AND created_at < p_until
       AND (p_client_id IS NULL OR client_id = p_client_id)
  )
  SELECT jsonb_build_object(
    'calls', COALESCE((
      SELECT jsonb_agg(g) FROM (
        SELECT agent_id,
               client_id,
               is_current,
               count(*) AS calls,
               count(*) FILTER (
                 WHERE outcome IS NOT NULL AND outcome NOT IN ('no_answer', 'voicemail')
               ) AS contacts,
               COALESCE(sum(GREATEST(COALESCE(duration_seconds, 0), 0)), 0) AS talk_seconds,
               max(created_at) AS last_at
          FROM calls
         GROUP BY agent_id, client_id, is_current
      ) g
    ), '[]'::jsonb),
    'lookups', COALESCE((
      SELECT jsonb_agg(g) FROM (
        SELECT client_id,
               requested_by,
               is_current,
               service_id,
               provider_status,
               state = 'failed' AS failed,
               billable,
               count(*) AS n,
               COALESCE(sum(cost), 0) AS charged,
               max(created_at) AS last_at
          FROM lookups
         GROUP BY client_id, requested_by, is_current, service_id, provider_status,
                  state = 'failed', billable
      ) g
    ), '[]'::jsonb),
    'daily', COALESCE((
      SELECT jsonb_agg(d ORDER BY d.day) FROM (
        SELECT day, sum(calls)::int AS calls, sum(lookups)::int AS lookups
          FROM (
            SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, 1 AS calls, 0 AS lookups
              FROM calls WHERE is_current AND client_id IS NOT NULL
            UNION ALL
            SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date, 0, 1
              FROM lookups WHERE is_current
          ) e
         GROUP BY day
      ) d
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.superadmin_usage_totals(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.superadmin_usage_totals(TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID)
  TO service_role;

-- The all-companies view filters the lookup tables by date alone; their existing indexes lead
-- with client_id. call_logs already has idx_call_logs_created_at.
CREATE INDEX IF NOT EXISTS debtor_traces_created_idx ON debtor_traces (created_at);
CREATE INDEX IF NOT EXISTS insights_manual_lookups_created_idx ON insights_manual_lookups (created_at);
