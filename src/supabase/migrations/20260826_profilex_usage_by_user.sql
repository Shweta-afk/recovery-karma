-- Per-user Insights usage for the admin report.
--
-- profilex_spend_report answers "what did we spend, by service". This answers "who is spending
-- it" — the question an admin actually has when a monthly bill arrives, since every lookup is
-- charged and a manager running speculative lookups on a whole portfolio is the failure mode
-- worth catching early.
--
-- One row per user PER SERVICE, not per user: the UI aggregates for the top-level row and uses
-- the same rows for the drill-down, so a manager's mix (cheap Mobile-to-UAN vs the pricier
-- employment calls) is visible without a second round trip.
--
-- SECURITY INVOKER on purpose, matching report_agent_account_counts and profilex_spend_report:
-- debtor_traces' own policy still applies, so an admin sees their whole client and a manager
-- sees only their team. Do NOT switch this to DEFINER — that would leak usage across tenants.

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
    SELECT
      t.requested_by                                                   AS agent_id,
      COALESCE(a.name, 'Unknown')::text                                AS agent_name,
      COALESCE(a.email, '')::text                                      AS agent_email,
      COALESCE(a.role, '')::text                                       AS agent_role,
      t.service_id::text,
      count(*)                                                         AS lookups,
      count(*) FILTER (WHERE t.provider_status = '1')                  AS hits,
      -- Charged but returned nothing. The number that says whether the spend is worth it.
      count(*) FILTER (WHERE t.billable AND t.provider_status IS DISTINCT FROM '1') AS misses,
      -- Never reached a data source, so never charged.
      count(*) FILTER (WHERE t.state = 'failed')                       AS failures,
      -- A completed lookup that cost nothing is one the cache absorbed — worth surfacing so an
      -- admin can see the TTL doing its job rather than only seeing what was spent.
      count(*) FILTER (WHERE t.state = 'done' AND NOT t.billable)      AS cached_reuses,
      count(DISTINCT t.debtor_id)                                      AS debtors_touched,
      COALESCE(sum(t.cost), 0)                                         AS spend,
      max(t.created_at)                                                AS last_used
    FROM debtor_traces t
    LEFT JOIN agents a ON a.id = t.requested_by
    WHERE t.created_at >= p_since
    GROUP BY t.requested_by, a.name, a.email, a.role, t.service_id
    ORDER BY spend DESC, lookups DESC;
  $$;
